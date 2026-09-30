# Piet

Piet is a canvas-like user interface to Pi AI agent.
Instead of typing in TUI you draw, ask with your voice and `piet` will work with you on a canvas within browser.

Piet relies on `pi` provider authentication and setup by reading `~/.pi`.

<img width="1902" height="1035" alt="SCR-20260930-tovn" src="https://github.com/user-attachments/assets/f308f020-7877-4ae1-9807-c460c035eb52" />


## Installation

Requires Node.js 22.19+ and pnpm 11+.

Clone the repository, install dependencies, build the shared protocol, and register
the `piet` command globally:

```sh
git clone https://github.com/denisshepelin/piet.git
cd piet
pnpm install
pnpm --filter @piet/protocol build
pnpm add -g .
```

If pnpm reports that its global bin directory is not on your PATH, run
`pnpm setup`, restart your shell, and retry `pnpm add -g .`.

Keep the checkout in place: the command runs from it rather than an independent
installed copy.

Builtin speech to text function currently works only with [Soniox](https://soniox.com/docs/stt/get-started). You will need to provide SONIOX_API_KEY to use it.

## Run from any folder

From any project:

```sh
cd /path/to/project
piet
```

Or supply a directory:

```sh
piet /path/to/project
```

Piet starts the backend and Vite development server and opens the browser on the
first available web UI port starting at 5173. Press Ctrl+C to stop both servers.
To require a specific web UI port (and fail if it is occupied):

```sh
piet --port 5200
piet /path/to/project --port 5200
```

The agent's working directory, relative image paths, project settings, and session
logs belong to the folder you launch it in, not the Piet checkout. Environment
variables come from your shell, then the workspace `.env`, then the checkout
`.env` (in that order of precedence). `PORT` changes the backend port (default
8787); `--port` changes only the web UI port. For multiple instances, give each
a different backend `PORT` as well.

## Updating

Update your checkout, then refresh dependencies and the shared protocol:

```sh
git pull
pnpm install
pnpm --filter @piet/protocol build
```

Restart `piet` to load the updated source. No global reinstall is needed. Local
backend edits, including changes to `backend/src/mainPrompt.ts`, are loaded on
the next execution without a build. Vite also live-reloads web changes.

After changing the shared protocol, run `pnpm --filter @piet/protocol build`.
After changing dependencies, run `pnpm install`.

## Development

```sh
pnpm dev
pnpm test
pnpm typecheck
pnpm lint
```
