#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryDirectory = fileURLToPath(new URL("../", import.meta.url));

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: piet [directory] [--port <port>]

Start Piet in the current folder, or in the supplied directory.
The web UI uses the first available port starting at 5173.
Use --port <port> to require a specific web UI port. Press Ctrl+C to stop.

Requires dependencies and the protocol build in the Piet checkout:
  pnpm install
  pnpm --filter @piet/protocol build`);
  process.exit(0);
}

let parsedArgs;

try {
  parsedArgs = parseArgs({ args, options: { port: { type: "string" } }, allowPositionals: true });

  if (parsedArgs.positionals.length > 1) throw new Error("expected at most one directory");
  const port = parsedArgs.values.port;

  if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
} catch (error) {
  console.error(`Piet CLI: ${error.message}. Use piet --help for usage.`);
  process.exit(1);
}

const workingDirectory = resolve(parsedArgs.positionals[0] ?? process.cwd());

if (!existsSync(workingDirectory) || !statSync(workingDirectory).isDirectory()) {
  console.error(`Piet CLI: not a directory: ${workingDirectory}`);
  process.exit(1);
}

const loadEnvironmentFile = (path) => {
  if (existsSync(path)) process.loadEnvFile(path);
};

// Shell variables take precedence, followed by the workspace and checkout .env files.
loadEnvironmentFile(join(workingDirectory, ".env"));

if (workingDirectory !== repositoryDirectory) {
  loadEnvironmentFile(join(repositoryDirectory, ".env"));
}

let tsxLoader;

let viteCli;

try {
  const backendRequire = createRequire(join(repositoryDirectory, "backend/package.json"));
  const webRequire = createRequire(join(repositoryDirectory, "web/package.json"));
  tsxLoader = backendRequire.resolve("tsx");
  viteCli = join(dirname(webRequire.resolve("vite/package.json")), "bin/vite.js");

  if (!existsSync(join(repositoryDirectory, "shared/dist/canvasProtocol.js"))) {
    throw new Error("Piet CLI: shared protocol build missing.");
  }
} catch {
  console.error(
    "Piet CLI: dependencies or protocol build missing. Run pnpm install and pnpm --filter @piet/protocol build in the Piet checkout.",
  );
  process.exit(1);
}

const backendPort = process.env.PORT ?? "8787";

const isWebPortAvailable = (port) =>
  new Promise((resolveAvailability, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") resolveAvailability(false);
      else reject(error);
    });
    server.listen(port, "127.0.0.1", () => server.close(() => resolveAvailability(true)));
  });

let webPort = Number(parsedArgs.values.port ?? 5173);

try {
  while (webPort === Number(backendPort) || !(await isWebPortAvailable(webPort))) {
    if (parsedArgs.values.port !== undefined) {
      throw new Error(`web UI port ${webPort} is already in use`);
    }

    if (webPort === 65535) throw new Error("no available web UI port starting at 5173");
    webPort += 1;
  }
} catch (error) {
  console.error(`Piet CLI: ${error.message}`);
  process.exit(1);
}

const webOrigin = `http://127.0.0.1:${webPort}`;

const children = new Set();

let stopping = false;

let forceShutdown;

const stopPiet = (exitCode) => {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;

  for (const child of children) child.kill("SIGTERM");

  if (children.size > 0) {
    forceShutdown = setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
    }, 5000);
    forceShutdown.unref();
  }
};

const startPietProcess = (name, nodeArgs, cwd, env = process.env) => {
  const child = spawn(process.execPath, nodeArgs, { cwd, env, stdio: "inherit" });
  children.add(child);
  child.on("error", (error) => {
    console.error(`Piet CLI: ${name} failed to start: ${error.message}`);
    stopPiet(1);
  });
  child.on("close", (code) => {
    children.delete(child);

    if (!stopping) {
      console.error(`Piet CLI: ${name} stopped; shutting down Piet.`);
      stopPiet(code === 0 ? 0 : 1);
    }

    if (children.size === 0) clearTimeout(forceShutdown);
  });
};

process.on("SIGINT", () => stopPiet(0));

process.on("SIGTERM", () => stopPiet(0));

console.log(`Piet workspace: ${workingDirectory}`);

console.log(`Piet web UI: ${webOrigin}`);

startPietProcess(
  "backend",
  ["--import", tsxLoader, join(repositoryDirectory, "backend/src/index.ts")],
  workingDirectory,
  { ...process.env, PIET_WEB_ORIGIN: webOrigin },
);

startPietProcess(
  "web server",
  [viteCli, "--host", "127.0.0.1", "--port", String(webPort), "--strictPort", "--open"],
  join(repositoryDirectory, "web"),
  { ...process.env, VITE_WS_URL: `ws://localhost:${backendPort}` },
);
