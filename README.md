# Open Cockpit

A single package that gives you real usage data in two places:

- **OpenChamber extension** — a rail panel with 12 sections and a compact Work Status section.
- **OpenCode plugin** — one `cockpit` tool for asking OpenCode about usage, context and sessions.

Both read the same local OpenCode database. No account, no cloud service, no data leaves the machine.

## Features

- Today at a glance: tokens, total tokens, cache, requests, tools, skills, MCP, errors, sessions, projects, cost and cache-hit rate.
- Period totals for 7 days, 30 days, year and all time.
- Dedicated tabs: Overview, Token, Date, Model, Session, Project, Context, Tool, Skill, MCP, Logs and Settings.
- Daily bars, GitHub-style activity heat maps, sortable tables and a recent-activity log.
- Context window gauge, six-category context breakdown and rolling cache-hit rate.
- Daily token budget, optional price estimates, 12/24-hour clock, saved view settings and drag-to-reorder cards.
- Panel and Work Status recheck data every 5 seconds while visible.
- One OpenCode tool with `action: "usage" | "context" | "sessions"`.

## Install

### OpenChamber extension

Click once:

[Install Open Cockpit](openchamber://extensions/install?url=https%3A%2F%2Fgithub.com%2FSeaXen%2Fopen-cockpit)

Or in OpenChamber, go to **Settings → Extensions → Add** and paste:

```
https://github.com/SeaXen/open-cockpit
```

Enable the extension and approve `service`. The OpenCode plugin is contributed by the same package; approve `opencodePlugin` when asked. The panel appears in the rail and the "Usage today" section appears in Work Status.

### OpenCode plugin alone

```sh
opencode plugin add open-cockpit
```

This installs from npm, so no git dependency preparation is needed.

If `plugin add github:` fails on Windows with `git dep preparation failed`, use one of these instead:

1. **Recommended:** install the OpenChamber extension above. It contributes the OpenCode plugin too — approve `opencodePlugin` when asked. No separate plugin install is needed.
2. **Local path:** clone the repo, then add the directory directly:

```powershell
git clone https://github.com/SeaXen/open-cockpit.git
opencode plugin add C:\Users\Sagar-EB\open-cockpit
```

Or put the path in `~/.config/opencode/opencode.json`:

```json
{ "plugins": ["C:/Users/Sagar-EB/open-cockpit"] }
```

Then restart OpenCode. The single tool is available as `cockpit` (or `tools.cockpit` in Code Mode):

```ts
await tools.cockpit({ action: "usage", days: 7 });
await tools.cockpit({ action: "context" });
await tools.cockpit({ action: "sessions", limit: 10 });
```

## Files

- `package.json` — manifest, scripts and package exports.
- `service/main.js` — host service: reads SQLite, keeps a small incremental cache, serves the panel.
- `panel/main.ts` — page source; `panel/main.js` is the bundled page that loads.
- `plugin/index.js` — OpenCode server plugin with the `cockpit` tool.
- `scripts/check.mjs` — manifest checker.
- `service/merge.test.mjs` — integration test for the incremental cache.

## Data and privacy

Usage numbers come from `~/.local/share/opencode/opencode.db` (or the platform equivalent). Context estimates also read `AGENTS.md` / `CLAUDE.md` in the open project and the user's OpenCode config folder. Nothing is uploaded. The service listens only on loopback.

## Development

```sh
npm install
npm run build
npm test
npm run check
```

The built `panel/main.js` is committed; installing never builds.

## License

MIT.
