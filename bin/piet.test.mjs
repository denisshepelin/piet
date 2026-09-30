import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";

const launcher = new URL("./piet.mjs", import.meta.url);

const createPietFixture = async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "piet-cli-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, "checkout");
  const workspace = join(directory, "workspace with spaces");

  const files = {
    "backend/package.json": '{"type":"module"}',
    "backend/node_modules/tsx/package.json": '{"type":"module","exports":"./loader.mjs"}',
    "backend/node_modules/tsx/loader.mjs": "",
    "shared/dist/canvasProtocol.js": "",
    "web/package.json": '{"type":"module"}',
    "web/node_modules/vite/package.json": '{"type":"module"}',
    "backend/src/index.ts": `console.log(JSON.stringify({role: "backend", cwd: process.cwd(), secret: process.env.PIET_CLI_TEST_SECRET, origin: process.env.PIET_WEB_ORIGIN})); setInterval(() => {}, 1000);`,
    "web/node_modules/vite/bin/vite.js": `console.log(JSON.stringify({role: "web", cwd: process.cwd(), ws: process.env.VITE_WS_URL, args: process.argv.slice(2)})); setInterval(() => {}, 1000);`,
    ".env": "PIET_CLI_TEST_SECRET=checkout\n",
  };

  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const destination = join(repository, path);
      await mkdir(join(destination, ".."), { recursive: true });
      await writeFile(destination, content);
    }),
  );
  await mkdir(join(repository, "bin"), { recursive: true });
  await copyFile(launcher, join(repository, "bin/piet.mjs"));
  await mkdir(workspace);
  await writeFile(join(workspace, ".env"), "PIET_CLI_TEST_SECRET=workspace\nPORT=9876\n");

  return { repository, workspace, cli: join(repository, "bin/piet.mjs") };
};

const runPietFixture = async (t, fixture, args) => {
  const env = { ...process.env };
  delete env.PORT;
  delete env.PIET_CLI_TEST_SECRET;

  const child = spawn(process.execPath, [fixture.cli, ...args], {
    cwd: fixture.workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(() => child.kill("SIGKILL"));
  const closed = once(child, "close");
  let output = "";

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Piet fixture timeout: ${output}`)), 10000);
    child.stdout.on("data", (chunk) => {
      output += chunk;

      if (output.includes('"role":"backend"') && output.includes('"role":"web"')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("close", () => {
      clearTimeout(timeout);
      reject(new Error(`Piet fixture exited early: ${output}`));
    });
  });

  await ready;
  child.kill("SIGTERM");
  assert.deepEqual(await closed, [0, null]);

  return output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
};

test("Piet CLI help works without dependencies or starting servers", () => {
  const result = spawnSync(process.execPath, [launcher.pathname, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: piet \[directory\]/);
});

test("Piet CLI rejects invalid arguments and missing directories", () => {
  for (const args of [
    ["--unknown"],
    ["one", "two"],
    ["/nonexistent/piet-workspace"],
    ["--port"],
    ["--port", "0"],
    ["--port", "65536"],
    ["--port", "abc"],
    ["--port", "1.5"],
  ]) {
    const result = spawnSync(process.execPath, [launcher.pathname, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Piet CLI:/);
  }
});

test("Piet CLI uses the caller workspace and stops both servers on SIGTERM", async (t) => {
  const fixture = await createPietFixture(t);
  const messages = await runPietFixture(t, fixture, []);
  assert.deepEqual(
    messages.find((message) => message.role === "backend"),
    {
      role: "backend",
      cwd: fixture.workspace,
      secret: "workspace",
      origin: `http://127.0.0.1:${messages.find((message) => message.role === "web").args[3]}`,
    },
  );
  const web = messages.find((message) => message.role === "web");
  assert.equal(web.cwd, join(fixture.repository, "web"));
  assert.equal(web.ws, "ws://localhost:9876");
  assert.ok(Number(web.args[3]) >= 5173);
  assert.deepEqual(web.args, [
    "--host",
    "127.0.0.1",
    "--port",
    web.args[3],
    "--strictPort",
    "--open",
  ]);
});

test("Piet CLI skips an occupied default web UI port", async (t) => {
  const server = createServer();
  t.after(() => server.close());
  await new Promise((resolve, reject) => {
    server.once("error", (error) => (error.code === "EADDRINUSE" ? resolve() : reject(error)));
    server.listen(5173, "127.0.0.1", resolve);
  });
  const fixture = await createPietFixture(t);
  const messages = await runPietFixture(t, fixture, []);
  assert.ok(Number(messages.find((message) => message.role === "web").args[3]) > 5173);
});

test("Piet CLI respects an explicit web UI port and rejects occupied ports", async (t) => {
  const server = createServer();
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = String(server.address().port);
  const fixture = await createPietFixture(t);

  const result = spawnSync(process.execPath, [fixture.cli, "--port", port], {
    cwd: fixture.workspace,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /web UI port .* is already in use/);
  assert.doesNotMatch(result.stdout, /"role":/);
  await new Promise((resolve) => server.close(resolve));

  for (const args of [
    ["--port", port, "../checkout"],
    ["../checkout", `--port=${port}`],
  ]) {
    const messages = await runPietFixture(t, fixture, args);
    assert.equal(messages.find((message) => message.role === "web").args[3], port);
    assert.equal(
      messages.find((message) => message.role === "backend").origin,
      `http://127.0.0.1:${port}`,
    );
  }
});

test("Piet CLI rejects a web UI port reserved for the backend", async (t) => {
  const fixture = await createPietFixture(t);

  const result = spawnSync(process.execPath, [fixture.cli, "--port", "9876"], {
    cwd: fixture.workspace,
    env: { ...process.env, PORT: "9876" },
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /web UI port 9876 is already in use/);
});

test("Piet CLI accepts a relative workspace directory", async (t) => {
  const fixture = await createPietFixture(t);
  const messages = await runPietFixture(t, fixture, ["../checkout"]);
  assert.deepEqual(
    messages.find((message) => message.role === "backend"),
    {
      role: "backend",
      cwd: fixture.repository,
      secret: "checkout",
      origin: `http://127.0.0.1:${messages.find((message) => message.role === "web").args[3]}`,
    },
  );
});
