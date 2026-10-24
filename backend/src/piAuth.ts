import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import type { AuthInteraction, AuthPrompt, AuthType, Provider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAIN_MODEL } from "./modelDefaults.js";

type LoginOption = { readonly provider: Provider; readonly type: AuthType; readonly label: string };

const ask = async (question: string): Promise<string> => {
  const readline = createInterface({ input: process.stdin, output: process.stdout });

  try {
    return (await readline.question(question)).trim();
  } finally {
    readline.close();
  }
};

/** Reads a line without echoing it, for API keys and pasted tokens. */
const askSecret = async (question: string): Promise<string> => {
  process.stdout.write(question);
  const silent = new Writable({ write: (_chunk, _encoding, done) => done() });
  const readline = createInterface({ input: process.stdin, output: silent, terminal: true });

  try {
    return (await readline.question("")).trim();
  } finally {
    readline.close();
    process.stdout.write("\n");
  }
};

const choose = async <T>(
  message: string,
  options: readonly { label: string; value: T }[],
): Promise<T> => {
  console.log(message);

  for (const [index, option] of options.entries()) console.log(`  ${index + 1}. ${option.label}`);

  for (;;) {
    // Each answer decides whether to ask again.
    // oxlint-disable-next-line no-await-in-loop
    const answer = await ask(`Choose 1-${options.length}: `);
    const option = options[Number(answer) - 1];

    if (option) return option.value;
  }
};

const promptUser = async (prompt: AuthPrompt): Promise<string> => {
  const placeholder =
    prompt.type !== "select" && prompt.placeholder ? ` (${prompt.placeholder})` : "";

  switch (prompt.type) {
    case "select":
      return choose(
        prompt.message,
        prompt.options.map((option) => ({ label: option.label, value: option.id })),
      );
    case "secret":
      return askSecret(`${prompt.message}${placeholder}: `);
    case "text":
    case "manual_code":
      return ask(`${prompt.message}${placeholder}: `);
  }
};

const terminalInteraction: AuthInteraction = {
  prompt: promptUser,
  notify: (event) => {
    switch (event.type) {
      case "auth_url":
        console.log(`\nOpen this URL to sign in:\n  ${event.url}`);

        if (event.instructions) console.log(event.instructions);

        return;
      case "device_code":
        console.log(`\nOpen ${event.verificationUri} and enter the code ${event.userCode}`);

        return;
      case "info":
        console.log(event.message);

        for (const link of event.links ?? [])
          console.log(`  ${link.label ?? link.url}: ${link.url}`);

        return;
      case "progress":
        console.log(event.message);

        return;
    }
  },
};

/** Every login a provider offers: subscription OAuth first, then an API key. */
const loginOptions = (providers: readonly Provider[]): LoginOption[] =>
  providers
    .toSorted(
      (left, right) =>
        Number(right.id === DEFAULT_MAIN_MODEL.provider) -
        Number(left.id === DEFAULT_MAIN_MODEL.provider),
    )
    .flatMap((provider) => [
      ...(provider.auth.oauth
        ? [
            {
              provider,
              type: "oauth" as const,
              label: `${provider.name}: ${provider.auth.oauth.loginLabel ?? provider.auth.oauth.name}`,
            },
          ]
        : []),
      ...(provider.auth.apiKey?.login
        ? [
            {
              provider,
              type: "api_key" as const,
              label: `${provider.name}: ${provider.auth.apiKey.name}`,
            },
          ]
        : []),
    ]);

/**
 * Piet uses pi's providers and credentials (`~/.pi/agent/auth.json`). Without any configured provider, this signs in
 * through pi's own provider login before the servers start; credentials are stored where pi keeps them.
 */
const ensurePiAuth = async (): Promise<number> => {
  const runtime = await ModelRuntime.create();

  if ((await runtime.getAvailable()).length > 0) {
    if (!(await runtime.checkAuth(DEFAULT_MAIN_MODEL.provider))) {
      console.log(
        `Piet: no pi credentials for ${DEFAULT_MAIN_MODEL.provider}, the default main model's provider. Choose models from configured providers in the inspector, or set MAIN_MODEL_PROVIDER and MAIN_MODEL_ID.`,
      );
    }

    return 0;
  }

  if (!process.stdin.isTTY) {
    console.error(
      "Piet: no pi credentials found. Run piet in a terminal to sign in, or run pi and use /login.",
    );

    return 1;
  }

  console.log(
    "Piet: no pi credentials found. Sign in to a model provider; pi stores the credentials.",
  );

  const option = await choose(
    "Providers:",
    loginOptions(runtime.getProviders()).map((login) => ({ label: login.label, value: login })),
  );

  await runtime.login(option.provider.id, option.type, terminalInteraction, { agentName: "piet" });
  console.log(`Piet: signed in to ${option.provider.name}.`);

  if (option.provider.id !== DEFAULT_MAIN_MODEL.provider) {
    console.log(
      "Piet: the default models use another provider; choose models in the inspector, or set MAIN_MODEL_PROVIDER/MAIN_MODEL_ID and WORKER_MODEL_PROVIDER/WORKER_MODEL_ID.",
    );
  }

  return 0;
};

try {
  process.exitCode = await ensurePiAuth();
} catch (cause) {
  console.error(`Piet: sign-in failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
}
