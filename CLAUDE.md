# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# cc-htmlfeedback

This repo is the **runtime tooling** for the `cc-htmlfeedback` live-feedback loop:
`server.js` (serves the user's app with the feedback widget injected), `lib/` (inject, queue,
watch-inbox helpers), and `extension/feedback-widget.js` (the widget itself, built via `build.js`).

## Commands

Zero runtime dependencies - there is no `npm install` step. Node >= 18 to run;
**tests need Node >= 20.14** (`--test-force-exit`), so if `npm test` fails with
`bad option`, switch to a newer nvm node (e.g. `~/.nvm/versions/node/v22.22.1/bin/node`).

```bash
npm run build                                  # regenerate extension widget + assemble the plugin
npm run check                                  # build.js --check: exit 1 on drift, writes nothing
npm test                                       # node --test --test-force-exit (all test/*.test.js)
node --test --test-force-exit test/server.test.js   # single test file
npm run serve -- --root . --port 4317          # companion server, static mode
npm run serve -- --proxy http://localhost:5173 # proxy mode (keeps upstream HMR)
```

`playground_file.html` is the demo fixture for manual widget testing (open it and load the
extension, or serve it).

## Architecture

### One widget source, two products

`feedback-widget.html` is the single source of truth for the widget (despite the `.html` name -
it is a build SOURCE, never served as-is). `build.js` extracts its parts **positionally** and
requires exactly one `<style>` block, one `<script>` block, and that the script is a single bare
IIFE - keep that structure when editing. Outputs (all build artifacts, never hand-edit):
`extension/feedback-widget.js` (self-injecting, for the Chrome extension) and
`plugins/cc-htmlfeedback/{feedback-widget.js,server.js,lib/}` (the self-contained plugin).

The widget is dependency-free and vendors Idiomorph inline (for the on-done DOM morph).

### Two runtime modes, keyed off `window.__CCFB`

- **Disconnected** (extension injects the widget, no `__CCFB`): notes live in memory, exported
  via Copy. `extension/background.js` (MV3, activeTab) injects on toolbar click and toggles
  visibility through the `window.__fbWidget` API.
- **Connected** (`server.js` injects `__CCFB` + the widget via `lib/inject.js`): notes become
  tickets that a Claude Code session fixes live. The `/cc-htmlfeedback` skill
  (`plugins/cc-htmlfeedback/skills/cc-htmlfeedback/SKILL.md`) orchestrates that session.

### Connected-mode data flow (the core contract)

```
widget ──POST /__ccfb/tickets──▶ server ──append──▶ pages/<key>/feedback_inbox.jsonl
                                                          │ (file grows)
        Claude session: lib/watch-inbox.js wakes ◀────────┘
        session drains inbox, fixes via subagents, writes pages/<key>/feedback_tasks.json
                                                          │ (file watched)
widget ◀──SSE /__ccfb/events (page-scoped `tickets`)── server
widget: on a ticket's done transition, re-fetch page + Idiomorph-morph the DOM in place
        (static mode; proxy mode defers to the upstream dev server's HMR)
```

- Queue root: `<servedRoot>/.cc-htmlfeedback/`, one dir per page under `pages/<pagekey>/`
  (`pagekey` = sha1 of the URL pathname, first 12 hex chars - boards survive port changes).
- **Two-file ownership is the lock**: the server only ever *appends* to `feedback_inbox.jsonl`;
  the Claude session is the *sole writer* of `feedback_tasks.json`. Never blur this.
- `watch-inbox.js` wakes only when total inbox bytes strictly grow (fs events are coarse and
  coalesced on macOS) - anything that appends to an inbox means "real work arrived".
- Ticket statuses: `todo -> in-progress -> done` (or `error`). Refinement is a new comment,
  never an edit to a submitted one.
- All server endpoints live under `/__ccfb/*` (tickets, events, widget.js, clean, shutdown,
  health) and are handled locally even in proxy mode.

## The skill ships as a bundled plugin in this repo

This repo is **both** a Claude Code plugin marketplace and the single source of truth for the
`/cc-htmlfeedback` skill. Layout:

```
.claude-plugin/marketplace.json          ← marketplace (lists the one plugin)
plugins/cc-htmlfeedback/                  ← the installable plugin
  .claude-plugin/plugin.json
  skills/cc-htmlfeedback/                 ← canonical skill source - EDIT HERE
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

```
/plugin marketplace add leetwito/cc-htmlfeedback   # or: /plugin marketplace add .  (local dev)
/plugin install cc-htmlfeedback@cc-htmlfeedback
/cc-htmlfeedback
```

After editing the skill text, run `/plugin marketplace update` to refresh the installed copy.

## Architect review backlog - TODO (review: 2026-06-18)

Known issues from a four-agent architect review (server/lib, widget/extension, skill/integration,
root layout). **These are meant to be fixed over time.** Re-verify a finding before acting (code
moves).

> **Maintenance:** when you fix one of these, **delete its entry from this section** in the same
> change - this is a live TODO, not a changelog (commit history is the record). When the last item
> is gone, remove this whole section.

### Open - HIGH
- **Widget DOM re-anchoring is substring-only** (`feedback-widget.html`, `reanchor`/`wrap`). Anchors
  to the first text match of the quote, ignoring captured `context`/`section`; short/repeated quotes
  mis-anchor after a morph, multi-node selections become `anchorLost`. Fix: context-disambiguated
  anchoring + record the original occurrence index. Needs a brainstorm pass + Chrome E2E. Highest value.
- **No re-anchor on host-app re-renders** (`feedback-widget.html`). Nothing watches `CONTENT` for
  React/htmx swaps, so `.fb-mark` spans are destroyed and never restored. Add a debounced
  MutationObserver that re-runs `reanchor` for live items. Pairs with the finding above.
- **Extension-injected widget can't go live + no double-injection guard.** Extension injects the
  widget with no `window.__CCFB` (offline forever); clicking the icon on a server-served page injects
  a 2nd copy. Add `if (window.__fbWidget) return;` at the top of the IIFE; document that served pages
  use the server-injected widget. (Re-verify against current extension flow.)

### Open - MEDIUM
- **Proxy buffers upstream HTML unbounded** (`server.js` proxy path, `Buffer.concat(chunks)`): no cap
  vs the 1 MB POST-body cap → memory DoS on a large/hung upstream. Also injects into HTMX/turbo
  fragments (any `text/html`); gate injection on a full-document heuristic (`<html`/`<body`).
- **SSE half-open stream reads as "live" forever** - `es.onerror` only flips offline on
  `readyState===2`. Add a server `: ping` heartbeat (~15s) + reconnect backoff. Low value on loopback.
- **Version discipline unenforced** - `build.js --check` validates content drift, not
  `manifest.json` === `package.json` === `plugin.json` parity. Add a version-parity assertion.

### Open - LOW
- `server.js` `decodeURIComponent` can throw on a malformed `%` → wrap and 400.
- `watchSource` reload-ignore uses path-fragment matching; compare resolved absolute paths instead.
- Root layout: `playground_file.html` reads like scratch - rename to `demo.html`/`examples/demo.html`
  (it's a documented demo fixture, not stray). `feedback-widget.html` is the build SOURCE despite the
  `.html` name - leave it, the `build.js` docstrings disambiguate.

## Releasing - bump the extension version when needed

When you ship a user-facing change to the widget or the extension (new behavior, fixes,
UX changes), **bump the version** in `extension/manifest.json` and `package.json` (keep them in
sync, semver). Chrome only treats an extension as updated when `manifest.json` `version`
increases, so without a bump users keep the old widget. For a plugin-facing change (skill, server,
widget) also bump `plugins/cc-htmlfeedback/.claude-plugin/plugin.json` and the plugin entry in
`.claude-plugin/marketplace.json` (keep them in sync). Rebuild (`node build.js`) after editing the
widget/server/lib so `extension/feedback-widget.js` and the assembled `plugins/cc-htmlfeedback/`
copies match the source (`node build.js --check` verifies).
