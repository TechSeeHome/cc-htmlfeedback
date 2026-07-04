# Design: deferred fix submission (drafts + explicit "Fix")

- **Date:** 2026-07-02
- **Status:** proposed - awaiting review
- **Scope:** `feedback-widget.html` (widget only; no server / queue / skill protocol changes)
- **Companion:** [2026-07-02-deferred-fix-submission.html](./2026-07-02-deferred-fix-submission.html) - visual mockups of the new panel/popover states (`To do`, `Error`, and disconnected mode are unchanged from today and not re-mocked here).

## 1. Problem

In connected mode, clicking **Comment** or **Strike** immediately POSTs the ticket to
`/__ccfb/tickets`. The inbox file grows, `watch-inbox.js` wakes the agent session, and the fix
starts right away. "Save my note" and "hand it to the agent" are fused into one action.

Consequences:

- **No review step.** A half-baked note becomes an agent instruction instantly, and the note
  turns read-only the moment it exists. You cannot refine, reconsider, or discard before the
  agent spends work on it.
- **The page changes under you.** When a ticket completes, the widget live-morphs the DOM
  (`applyMorph`). With instant send, the agent starts rewriting the page while you are still
  annotating it - content shifts, and later selections risk lost anchors (re-anchoring is
  substring-only; see CLAUDE.md backlog).

## 2. Decision

**Modeless drafts.** Every new note is saved as a local **draft**. Nothing reaches the agent
until the user explicitly clicks **Fix** (one card) or **Fix all (N)** (everything pending).
There is **no mode switch**.

### Why modeless (and not an "instant / review-first" toggle)

A mode toggle was considered and rejected:

1. **Modes cause errors.** The mode is hidden state, invisible at the moment of annotation
   (the popover looks identical in both modes). Users will batch when they meant to send and
   send when they meant to batch. A visible per-card **Fix** button *is* the state - a draft
   card has one, a submitted card has a status pill instead.
2. **Nothing is ever sent implicitly.** Explicit submission is predictable and safe: the agent
   acts only on an explicit user action. This follows the same contract as GitHub's PR review
   flow (comments are pending until "Submit review") - a model users already know.
3. **It unifies the two widget modes.** Disconnected mode already works exactly like this:
   notes accumulate, stay editable, and are exported by an explicit action (Copy). Connected
   mode becomes "disconnected mode + Fix buttons" instead of a third behavior to learn, test,
   and document.
4. **The fast path survives via keyboard.** The one-click cost for a quick single fix is
   erased by **Cmd/Ctrl+Enter** in the popover ("comment and fix now") and
   **Cmd/Ctrl+Backspace** ("strike and fix now"). Power users keep today's zero-friction flow;
   everyone else gets safety by default.

### Naming: agent-agnostic

No user-facing string mentions "Claude". The runtime on the other end may be any agent
(Claude today, possibly Codex or others later). Wording used throughout: **"the agent"**.

| Element | Copy |
|---|---|
| Header primary button | `Fix all (3)` |
| Per-card button (draft) | `Fix` |
| Per-card tooltip | `Send to the agent to fix` |
| Drafts section header | `Drafts` with count |
| Connection dot tooltips | `Connected - agent is idle` / `Agent is working on N comments on this page` / `Run /cc-htmlfeedback to enable auto fixes` |
| Popover hint (connected) | `Enter to save draft · Cmd/Ctrl+Enter to fix now · Esc to cancel` |

## 3. UX specification

### 3.1 Popover (annotation flow - unchanged keys)

- Select text, type a note. **Enter** = save comment draft. **Backspace** (empty box) = save
  strike draft. Identical to today; only the destination changes (local draft, not POST).
- **Cmd/Ctrl+Enter** = comment + fix now (draft is created and immediately submitted).
- **Cmd/Ctrl+Backspace** = strike + fix now.
- Hint line updated per the copy table above. Disconnected mode keeps the current hint.

### 3.2 Panel

- **Sections** (connected mode), in order: `Drafts`, `In progress`, `To do`, `Error`, `Done`.
  `Drafts` reuses the existing collapsible-section framework (`SEC_ORDER` gains `draft` at
  rank 0). Section hidden when empty, like the others.
- **Draft cards**: editable note (same contenteditable used in disconnected mode), a **Fix**
  button, and the existing ✕ discard. No status pill - the Fix button is the status.
- **Submitted cards**: exactly as today (status pill, read-only note, result line).
- **Header**: `Fix all (N)` appears as the primary button whenever N ≥ 1 drafts exist for this
  page; `Copy feedback` remains below it (it exports drafts + submitted alike, as today).
  Clicking `Fix all` submits drafts in creation order.
- **Badge / count**: outstanding = drafts + submitted-but-not-done. A page with only drafts
  still shows a red badge - work is pending, just not sent.
- **Clean** clears drafts along with everything else - also removes the persisted
  `ccfb-drafts:<page-key>` entry, so a cleared page can't resurrect drafts from storage on
  reload.

### 3.3 Submission semantics

- Submitting a draft POSTs the same payload as today; on success the card moves from `Drafts`
  to `To do`, the note becomes read-only, and the server id (`sid`) is recorded. The inbox
  file grows only here, so `watch-inbox` wake semantics keep meaning "real work arrived".
- POST failure: card stays in `Drafts`, error toast (`Could not reach the server - draft
  kept`). `Fix all` submits sequentially and stops on first failure, leaving the rest as
  drafts. Retrying `Fix all` resumes from the failed item (earlier successes are no longer
  drafts, so they aren't resubmitted). A draft that keeps failing can be fixed individually
  via its own Fix button, or discarded to unblock the rest.
- **Draft persistence**: drafts are saved to `sessionStorage` (key `ccfb-drafts:<page-key>`,
  scoped per tab - no cross-tab clobbering) on every change and restored on load, re-anchored
  with the existing `reanchor()` path, which (as today) skips entries with an empty quote -
  insertion-point drafts restore into the list without a live on-page mark, same as any
  anchor-lost entry. A reload never eats unsent notes; closing the tab does (the tradeoff for
  avoiding cross-tab collisions). Submitted tickets stay server-authoritative as today.

### 3.4 Disconnected mode

Unchanged. No Fix buttons (there is nothing to send to), flat list, editable notes, Copy
export. The banner still advertises `/cc-htmlfeedback`.

## 4. Data model changes (widget-local)

```text
store[id] = {
  id, quote, context, section, note, type, removed,
  // connected mode:
  draft: true|false,      // NEW - true until successfully POSTed
  sid, status, page, result, files, anchorLost
}
```

- `visibleItems()` ranks drafts first (`statusRank` returns -1 for drafts).
- `add(type)` no longer POSTs; it creates a draft and persists it.
- New `submitDraft(f)` wraps today's `ccfbPost` + `sid` bookkeeping and flips `draft = false`.
- `reconcile()` is unchanged: it already matches a sid-less local entry by
  `quote`+`note`+`page` while a POST is in flight, regardless of any local flag - a draft
  becomes matchable the moment it's actually submitted, the same as any ticket today.
- `isComposing()` gains "a draft note is focused" - already covered by the `.fb-note` check.

## 5. Out of scope (explicitly)

- **Server-side draft status** (survives across browsers/machines, visible to agent tooling).
  Deliberately deferred: it changes the queue file contract and `watch-inbox` gating for
  little v1 benefit. sessionStorage persistence covers the realistic failure mode (reload).
- Reordering / prioritizing drafts before submission.
- Editing an already-submitted ticket.

## 6. Release notes

Behavior change: connected-mode notes are **no longer sent automatically**. This is
intentional and the default cannot be configured (no mode). Per the release checklist:
bump `extension/manifest.json` + `package.json`, plus plugin versions
(`plugins/cc-htmlfeedback/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`),
run `node build.js`, and update README / SKILL.md wording where it says comments are fixed
immediately.

## 7. Test plan (high level)

- Unit (new - the repo's `node --test` harness covers server/lib only; widget-internal logic
  needs its own tests): `add()` creates draft without POST; `submitDraft` POSTs and flips
  state; `Fix all` order + first-failure stop; sessionStorage round-trip + re-anchor on load;
  reconcile does not duplicate drafts; badge counts drafts.
- Chrome E2E (new - no E2E infra exists yet): draft card renders in `Drafts` with editable
  note; Fix moves it to `To do`; Cmd/Ctrl+Enter fast path; reload restores drafts; disconnected
  mode unchanged.
