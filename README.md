# Open Cockpit

An OpenChamber extension. It reads the local OpenCode database and shows token,
tool, skill, MCP, session and context usage in a rail panel and Work Status.
No account and no network calls; all data stays on this machine.

## Files

- `package.json` — manifest and scripts.
- `service/main.js` — the host service. Reads SQLite, keeps a small JSON cache
  in `~/.config/openchamber/guest-data/open-cockpit/cache.json`, and serves
  `/data`, `/summary`, `/context`, `/session`, `/logs`, `/refresh`.
- `panel/main.ts` — the page source. `panel/main.js` is the bundled page that
  actually loads. Both the rail panel and the Work Status section use it.
- `scripts/check.mjs` — runs the SDK manifest checker.
- `service/merge.test.mjs` — integration test for the incremental cache.

## Build and check

```sh
npm install
npm run build     # bundles panel/main.ts -> panel/main.js
npm test          # creates a temporary database and checks merge logic
npm run check     # validates the manifest
```

`npm run build` needs `esbuild` from `devDependencies`. Installing the extension
does not build anything, so commit the generated `panel/main.js` with the source.

## Data and privacy

Usage numbers come from `~/.local/share/opencode/opencode.db` (or the platform
equivalent). Context estimates also read `AGENTS.md` / `CLAUDE.md` in the open
project and the user's OpenCode config folder. Nothing is uploaded.
