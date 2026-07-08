# cc-htmlfeedback

This repo is the **runtime tooling** for the `cc-htmlfeedback` live-feedback loop:
`server.js` (serves the user's app with the feedback widget injected), `lib/` (inject, queue,
watch-inbox helpers), and `extension/feedback-widget.js` (the widget itself, built via `build.js`).

## The skill ships as a bundled plugin in this repo

This repo is **both** a Claude Code plugin marketplace and the single source of truth for the
`/cc-htmlfeedback` skill. Layout:

```
.claude-plugin/marketplace.json          ← marketplace (lists the plugins - cc-htmlfeedback, designhub)
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

## Architect review backlog — TODO (review: 2026-06-18)

Known issues from a four-agent architect review (server/lib, widget/extension, skill/integration,
root layout). **These are meant to be fixed over time.** Re-verify a finding before acting (code
moves).

> **Maintenance:** when you fix one of these, **delete its entry from this section** in the same
> change — this is a live TODO, not a changelog (commit history is the record). When the last item
> is gone, remove this whole section.

### Open — HIGH
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

### Open — MEDIUM
- **Proxy buffers upstream HTML unbounded** (`server.js` proxy path, `Buffer.concat(chunks)`): no cap
  vs the 1 MB POST-body cap → memory DoS on a large/hung upstream. Also injects into HTMX/turbo
  fragments (any `text/html`); gate injection on a full-document heuristic (`<html`/`<body`).
- **SSE half-open stream reads as "live" forever** — `es.onerror` only flips offline on
  `readyState===2`. Add a server `: ping` heartbeat (~15s) + reconnect backoff. Low value on loopback.
- **Version discipline unenforced** — `build.js --check` validates content drift, not
  `manifest.json` === `package.json` === `plugin.json` parity. Add a version-parity assertion.
- **Clean can delete fix requests the agent never saw** (`server.js` `/__ccfb/clean`,
  `feedback-widget.html` Clean handler). Clean unconditionally truncates the page's
  `feedback_inbox.jsonl`, including lines appended-but-not-yet-merged into `feedback_tasks.json` (the
  drain loop only merges inbox lines when it goes globally idle - see `SKILL.md` Step 1). Deferred
  fix submission's Fix all raises the odds and blast radius of hitting this (several tickets land at
  once, right when a user might Clean). Real fix needs a server-side change (e.g. merge-before-clean,
  or an inbox the server itself drains) - out of scope for a widget-only PR. Related to the design
  doc's already-accepted "Fix all outrunning inbox ingestion" and "POST-failure idempotency" risks
  (`docs/design/2026-07-02-deferred-fix-submission.md` §5), but this is the sharper case: it's not a
  retry/duplicate risk, it's silent deletion of already-sent work with no error surfaced.

### Open — LOW
- **Restored submitted-pending drafts re-anchor before board status is known**
  (`feedback-widget.html` `restoreDrafts()`). It reanchors any restored entry with a matching
  page+quote immediately, including sid-bearing ones that may have already reached `done`
  server-side by the time of reload. Static mode self-heals (the next `done` morph unwraps
  everything); proxy mode's `scheduleApply()` is a no-op, so a stale highlight can linger on an
  already-fixed line until the next full navigation. Fix needs deferring reanchor for sid-bearing
  restored entries until the first `reconcile()` confirms non-done status - skipped for now since
  it's cosmetic-only and proxy-mode-only.
- `server.js` `decodeURIComponent` can throw on a malformed `%` → wrap and 400.
- `watchSource` reload-ignore uses path-fragment matching; compare resolved absolute paths instead.
- Root layout: `playground_file.html` reads like scratch — rename to `demo.html`/`examples/demo.html`
  (it's a documented demo fixture, not stray). `feedback-widget.html` is the build SOURCE despite the
  `.html` name — leave it, the `build.js` docstrings disambiguate.

## Browser automation - use dev-browser

Browser-driving in this repo (widget E2E, DesignHub POC verification, screenshots) uses
the **`dev-browser`** skill/CLI - persistent daemon, full Playwright API in scripts - not
a browser MCP (Playwright MCP was removed from this machine on purpose). Keep
verification flows as committed scripts (e.g. under `docs/designhub/pocs/pocN/`) so they
graduate into E2E tests. Logged-in Google profile setup:
`docs/designhub/pocs/PREREQUISITES.md` P2.

## Releasing — bump the extension version when needed

When you ship a user-facing change to the widget or the extension (new behavior, fixes,
UX changes), **bump the version** in `extension/manifest.json` and `package.json` (keep them in
sync, semver). Chrome only treats an extension as updated when `manifest.json` `version`
increases, so without a bump users keep the old widget. For a plugin-facing change (skill, server,
widget) also bump `plugins/cc-htmlfeedback/.claude-plugin/plugin.json` and the plugin entry in
`.claude-plugin/marketplace.json` (keep them in sync). Rebuild (`node build.js`) after editing the
widget/server/lib so `extension/feedback-widget.js` and the assembled `plugins/cc-htmlfeedback/`
copies match the source (`node build.js --check` verifies).
