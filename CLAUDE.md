# cc-htmlfeedback

This repo is the **runtime tooling** for the `cc-htmlfeedback` live-feedback loop:
`server.js` (serves the user's app with the feedback widget injected), `lib/` (inject, queue,
watch-inbox helpers), and `extension/feedback-widget.js` (the widget itself, built via `build.js`).

## The skill ships as a bundled plugin in this repo

This repo is **both** a Claude Code plugin marketplace and the single source of truth for the
`/cc-htmlfeedback` skill. Layout:

```
.claude-plugin/marketplace.json          ← marketplace (lists the plugins - cc-htmlfeedback)
plugins/cc-htmlfeedback/                  ← the installable plugin
  .claude-plugin/plugin.json
  skills/cc-htmlfeedback/                 ← canonical skill source — EDIT HERE
    SKILL.md  task-workflow.md  judge-prompt.md
  server.js  lib/  feedback-widget.js     ← assembled by `node build.js` (do NOT hand-edit)
```

**Edit the skill** in `plugins/cc-htmlfeedback/skills/cc-htmlfeedback/`. The skill resolves its
tooling via `TOOLING = ${CLAUDE_PLUGIN_ROOT}` (the installed plugin dir), so it works on any
machine with no absolute paths.

**`server.js` + `lib/` stay canonical at the repo root** (where `npm run serve`/`test` point).
`node build.js` mirrors them - plus the built widget - into `plugins/cc-htmlfeedback/` so the
plugin is self-contained. Those plugin copies are **build artifacts**: never edit them directly,
and run `build.js` after changing the server, lib, or widget. `node build.js --check` flags drift.

### Install / use

From a local checkout (recommended - always matches your current branch, including
plugins not yet merged upstream):

```shell
/plugin marketplace add .
/plugin install cc-htmlfeedback@cc-htmlfeedback
/cc-htmlfeedback
```

To install from a GitHub remote instead, use *your own* fork/remote, not a hardcoded
upstream repo - `/plugin marketplace add <owner>/cc-htmlfeedback` (substitute the
owner you actually push to; installing from someone else's fork won't have your
in-progress plugin work).

The marketplace name is always `cc-htmlfeedback` regardless of source (it comes from
the `name` field in `marketplace.json`, not the owner/repo path) - so
`/plugin install <plugin>@cc-htmlfeedback` is correct either way.

After editing the skill text, run `/plugin marketplace update` to refresh the
installed copy. **If you added a brand-new plugin to `marketplace.json`** (not just
edited an existing one), `/plugin install` may report "not found" even after
`marketplace add`/`update` - the running CLI process can cache the marketplace's
plugin list from session start. Exit the session (`/exit`) and start a fresh `claude`
process, then retry the install - no need to re-add the marketplace.
## Architect review backlog

Lives in [TODO.md](TODO.md) - re-verify a finding before acting (code moves). Fix an item ->
delete its entry there in the same change.

## Browser automation - use dev-browser

Browser-driving in this repo (widget E2E, screenshots) uses the **`dev-browser`**
skill/CLI - persistent daemon, full Playwright API in scripts - not a browser MCP
(Playwright MCP was removed from this machine on purpose). Keep verification flows as
committed scripts so they graduate into E2E tests.

## Releasing — bump the extension version when needed

When you ship a user-facing change to the widget or the extension (new behavior, fixes,
UX changes), **bump the version** in `extension/manifest.json` and `package.json` (keep them in
sync, semver). Chrome only treats an extension as updated when `manifest.json` `version`
increases, so without a bump users keep the old widget. For a plugin-facing change (skill, server,
widget) also bump `plugins/cc-htmlfeedback/.claude-plugin/plugin.json` and the plugin entry in
`.claude-plugin/marketplace.json` (keep them in sync). Rebuild (`node build.js`) after editing the
widget/server/lib so `extension/feedback-widget.js` and the assembled `plugins/cc-htmlfeedback/`
copies match the source (`node build.js --check` verifies).
