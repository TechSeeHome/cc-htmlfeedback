# TODO - architect review backlog

> Moved out of CLAUDE.md (setup-audit finding F4): a live TODO list does not belong in
> always-loaded context. Maintenance rule unchanged: fix an item -> delete its entry in the
> same change; commit history is the record.

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
  or an inbox the server itself drains) - out of scope for a widget-only PR. Related to (but sharper
  than) the deferred-fix-submission design's already-accepted "Fix all outrunning inbox ingestion"
  and "POST-failure idempotency" risks (that design doc was removed post-ship - see git history for
  `docs/design/2026-07-02-deferred-fix-submission.md` if the original framing is needed): it's not a
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
