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
  (`applyMorph`). The morph is already deferred while you are mid-compose (`isComposing`),
  but it still lands *between* annotations: content shifts under the selection you were
  about to make, and existing marks must re-anchor (substring-only; see CLAUDE.md backlog).

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
   acts only on an explicit user action. Same explicit-send contract as GitHub's PR review
   flow (comments are pending until "Submit review") - the analogy is about predictability of
   when the other side sees your words, not about batching benefits.
3. **It unifies the two widget modes.** Disconnected mode already works exactly like this:
   notes accumulate, stay editable, and are exported by an explicit action (Copy). Connected
   mode becomes "disconnected mode + Fix buttons" instead of a third behavior to learn, test,
   and document.
4. **The fast path survives - keyboard and mouse.** The one-click cost for a quick single fix
   is erased by **Cmd/Ctrl+Enter** in the popover ("comment and fix now"),
   **Cmd/Ctrl+Backspace** ("strike and fix now"), and **Cmd/Ctrl+click** on the popover's
   Comment/Strike buttons (mouse parity - mouse-first users must not be the only ones who
   lose today's one-action flow). Power users keep today's zero friction; everyone else gets
   safety by default.

**Stated usage assumption:** reviewing a generated page normally produces feedback in small
bursts (read a section, leave several notes, submit) rather than one isolated note per
session, so the extra click is paid once per burst via **Fix all**. When a single quick fix
*is* the whole session, the fast path keeps it at today's zero friction. If real usage turns
out to be overwhelmingly single-note-and-wait, this default should be revisited - there is no
telemetry, so the signal is user reports on the issue tracker.

Two other alternatives were weighed and rejected:

- **Undo-send grace window** (Gmail style: send instantly, show a ~5 s "Undo" toast). Solves
  take-back at zero added clicks, but keeps *implicit* sending as the default (violates
  point 2), adds time pressure at exactly the moment the user is re-reading their note, only
  delays the mid-annotation morph problem by the grace period, and does nothing to unify the
  two widget modes.
- **Two-button popover** ("Save draft" / "Fix now" side by side). Mouse-friendly, but doubles
  the decision cost of every single annotation and breaks the shared muscle-memory Enter
  flow. A visually secondary "Fix now" link was considered as a milder variant; instead the
  fast path is surfaced where the mouse already is - in the popover buttons' own tooltips
  (`Cmd/Ctrl+click: fix now`, see copy table) - keeping one button per action and zero added
  chrome.

### Naming: agent-agnostic

No user-facing string mentions "Claude". The runtime on the other end may be any agent
(Claude today, possibly Codex or others later). Wording used throughout: **"the agent"**.

| Element | Copy |
|---|---|
| Header primary button | `Fix all (3)` |
| Per-card button (draft) | `Fix` |
| Per-card tooltip | `Send to the agent to fix` |
| Drafts section header | `Drafts` with count |
| Connection dot tooltips | `Connected - agent is idle` / `Agent is working on N comments on this page` / `Run /cc-htmlfeedback to enable live fixes` (not "auto fixes" - fixes are no longer automatic) |
| Popover button tooltips | `Comment (Cmd/Ctrl+click: fix now)` / `Strike (Cmd/Ctrl+click: fix now)` - the mouse fast path's discoverability lives here |
| Popover hint (connected) | `Enter to save draft · Backspace (empty) to strike · Cmd/Ctrl+Enter to fix now · Shift+Enter for newline · Esc to cancel` (keeps today's strike + newline discoverability - the hint is the only place new users learn them) |
| Disconnected banner | `Want these fixed live? Run /cc-htmlfeedback.` (today's copy names Claude twice) |

## 3. UX specification

### 3.1 Popover (annotation flow - unchanged keys)

- Select text, type a note. **Enter** = save comment draft. **Backspace** (empty box) = save
  strike draft. Identical to today; only the destination changes (local draft, not POST).
- **Cmd/Ctrl+Enter** = comment + fix now (draft is created and immediately submitted).
  Implementation note: the existing plain-Enter branch (`e.key === 'Enter' && !e.shiftKey`)
  also matches Cmd/Ctrl+Enter - the modifier branch must be checked *before* it (or the plain
  branch must exclude `metaKey`/`ctrlKey`), else the fast path is unreachable.
- **Cmd/Ctrl+Backspace** (empty box - same gate as plain Backspace) = strike + fix now. With
  text in the box the chord keeps its native word-delete / delete-to-line-start behavior, so
  it can never fire mid-edit. Key-repeat is ignored (`e.repeat`) - holding the chord to
  word-delete cannot overshoot into a strike the instant the box empties.
- **Cmd/Ctrl+click** on the 💬 Comment / ⌫ Strike buttons = the same fix-now fast path for
  mouse-first users (parity with the keyboard chords; plain click saves a draft). Both
  buttons' tooltips advertise it (copy table) - the chords' only other surface is the hint
  line, which stays scannable by carrying just the primary one.
- **First-use cue**: the first time a draft is saved, a one-time toast (existing `showToast`,
  gated by a localStorage flag like the banner's `ccfb-banner-dismissed`) explains the new
  default: `Saved as draft - nothing is sent until you click Fix`. Shown with a duration
  override (~4 s) - the default 1.6 s auto-hide is too brief for the one message that
  explains a behavior change. Release notes alone don't reach extension users.
- Hint line updated per the copy table above. Disconnected mode keeps the current hint.

### 3.2 Panel

- **Sections** (connected mode), in order: `Drafts`, `In progress`, `To do`, `Error`, `Done`.
  `Drafts` reuses the existing collapsible-section framework: `SEC_ORDER` gains `draft` at
  rank 0, `SEC_LABEL` gains `draft: 'Drafts'` (without it the header renders "undefined"),
  and `statusOf(f)` returns `'draft'` when `f.draft` is true (checked before the
  `f.status || 'todo'` fallback), so the existing section-bucketing keys on it directly.
  Section hidden when empty, like the others.
- **Draft cards**: editable note (same contenteditable used in disconnected mode), a **Fix**
  button, and the ✕ discard. No status pill - the Fix button is the status. Draft cards keep
  the existing anchor-lost marker; an anchor-lost draft can still be fixed (quote/context
  were captured at creation and are matched against *source*, not the live DOM) - if the
  quote no longer exists in source, the agent fails cleanly and the ticket surfaces as
  `error`, as with any ticket. No submit-blocking warning: the existing error path already
  handles it end to end.
- **✕ and undo**: ✕ soft-removes (sets `removed: true`, exactly as today - hard-deleting
  would break undo, since `setRemoved` no-ops on a missing store entry). Removed entries are
  *excluded from the persistence snapshot*, so a discarded draft does not survive reload;
  undo (Cmd+Z) restores it in-memory and re-persists it. Undo history stays session-local,
  as today. ✕ on an in-flight or submitted card hides it locally as today - it cannot cancel
  the submission (the ticket is already queued; the agent may still fix it); there is no
  undo for Fix - unsending is impossible once the inbox has grown.
- **Accessible names**: per the widget's existing convention (`title` + `aria-label` on
  every control), Fix gets `aria-label` `Send to the agent to fix: <first ~40 chars of
  quote>` (disambiguates repeated Fix buttons for screen readers), Fix all gets
  `Fix all N drafts`, and the Drafts section header uses the existing section framework's
  semantics unchanged.
- **Submitted cards**: exactly as today (status pill, read-only note, result line).
- **Header**: `Fix all (N)` is a full-width **amber** button above `Copy feedback`, which
  keeps today's blue primary styling *unchanged*. Rationale: today's big blue header button
  IS Copy feedback - styling Fix all identically would route years of copy-click muscle
  memory into the least reversible action in the widget. **Amber is the "send to the agent"
  color throughout**: the per-card Fix button is amber too, never blue. Fix all does take
  the top slot Copy occupied - position drives muscle memory as well as color - but the
  color break plus Copy remaining full-width blue directly below is judged sufficient; if
  fat-finger reports appear, swap the two slots before reaching for a confirmation step.
  `Fix all` appears whenever N ≥ 1 drafts exist for this page; `Copy feedback` exports
  drafts + submitted alike, as today. Clicking `Fix all` submits drafts in creation order.
- **Badge / count**: outstanding = drafts + submitted-but-not-done. A page with only drafts
  still shows a red badge - work is pending, just not sent.
- **Clean** clears drafts along with everything else - also removes the persisted
  `ccfb-drafts:` snapshot entry (key defined in §3.3), so a cleared page can't resurrect
  drafts from storage on reload.

### 3.3 Submission semantics

- Submitting a draft POSTs the same payload as today. The card moves from `Drafts` to `To do`
  when the POST is *sent* and the note becomes read-only; on success the server id (`sid`) is
  recorded, on failure the card returns to `Drafts` (see next bullet). The inbox file grows
  only here, so `watch-inbox` wake semantics keep meaning "real work arrived".
- POST failure: the card *returns* to `Drafts` (it moved to `To do` at send). **Failure** =
  fetch rejection, non-2xx response, *or* unparseable response JSON - `fetch` resolves on
  HTTP errors, so the current `.then(r => r.json())` pattern alone would leave `sid`
  undefined and the card stranded in `To do` forever. Single-Fix failure toast: `Could not
  reach the server - draft kept`. `Fix all` submits sequentially and stops on first failure,
  leaving the rest as drafts; its toast reports the batch outcome: `Fix all stopped - N
  sent, M kept as drafts`. Retrying `Fix all` resumes from the failed item (earlier
  successes are no longer drafts, so they aren't resubmitted). A draft that keeps failing
  can be fixed individually via its own Fix button, or discarded to unblock the rest.
- **Drafts survive morphs**: `add()` sets `page` at creation (today it is set only on the
  POST path), so drafts pass `applyMorph`'s existing post-morph re-anchor filter
  (`f.page === location.href && statusOf(f) !== 'done'`). Without this one line, the first
  completed fix would strip every remaining draft's highlight permanently - and "a fix lands
  while other drafts exist" is this design's normal case.
- **Draft persistence** (`sessionStorage`, key `ccfb-drafts:` + the normalized path - the
  widget never receives the server's hashed page key, so it derives one from
  `location.pathname` using the server's own normalization (`/` → `/index.html`, as in
  `lib/queue.js`'s `fileOf`), so `/` and `/index.html` share one snapshot; query strings are
  ignored, matching the server's keying):
  - **What persists**: any entry that is a draft *or* not yet **board-seen** - excluding
    `removed: true` entries (a discarded draft must not resurrect on reload; undo history is
    session-local anyway). Written on change (debounced ~300 ms - contenteditable fires per
    keystroke). `reconcile()` marks an
    entry board-seen when it matches it in board data (by `sid` or content-adoption). A
    recorded `sid` alone is NOT enough to stop persisting: the POST response returns the
    `sid` seconds before the skill merges the inbox into the board, and
    `GET /__ccfb/tickets` reads only the board - dropping the entry at `sid`-time would make
    it vanish on a reload in that gap.
  - **Restore**: runs only when the page loads connected (`window.__CCFB` present). If the
    page loads disconnected (server stopped, or the extension-injected widget), the snapshot
    is left intact but not restored - drafts reappear when the page is served again;
    disconnected mode never reads it. Restored entries re-anchor via the existing
    `reanchor()` path, which (as today) skips empty-quote entries - insertion-point drafts
    restore into the list without a live on-page mark, same as any anchor-lost entry. `uid`
    is advanced past the highest restored `id` before any new annotation can be created, so
    a fresh draft can never reuse a restored one's id.
  - **End of life**: once board-seen, the entry is dropped from the snapshot and becomes
    server-authoritative as today (a restored entry that gains its board match dedups by
    `sid` - no duplicate card). ✕ and Clean also purge snapshot entries.
  - **Honest scope note**: sessionStorage is per-tab only *approximately* - browsers copy it
    on tab-duplicate (a duplicated tab duplicates unsent drafts; fixing from both submits
    twice) and restore it on tab-restore. A reload never eats unsent or just-submitted
    notes; closing the tab usually does (the accepted tradeoff for avoiding cross-tab
    clobbering).

### 3.4 Disconnected mode

Unchanged in behavior. No Fix buttons (there is nothing to send to), flat list, editable
notes, Copy export. The fast-path chords and modifier-click degrade to a plain save (there
is nothing to submit to). The banner still advertises `/cc-htmlfeedback`, but its copy is
updated per the naming table above (the current banner names Claude twice, violating this
design's own agent-agnostic rule).

## 4. Data model changes (widget-local)

```text
store[id] = {
  id, quote, context, section, note, type, removed,
  // connected mode:
  draft: true|false,      // NEW - true until the ticket is POSTed (see submitDraft below)
  sid, status, page, result, files, anchorLost
}
```

- `ORDER` gains `draft: -1` (so `statusRank` ranks drafts first - a sort tiebreak only;
  section *placement* comes from the `byKey[statusOf(f)]` bucketing) and `SEC_LABEL` gains
  `draft: 'Drafts'`.
- `add(type)` no longer POSTs; it creates a draft - setting `page` at creation (see §3.3,
  morph survival) - and persists it.
- New `submitDraft(f)` wraps today's `ccfbPost` + `sid` bookkeeping. It flips `draft = false`
  when the POST is *sent* (not when it resolves), and back to `true` if the POST fails.
  Response bookkeeping is `f.sid = f.sid || t.id` - the response never overwrites a `sid`
  already stamped by SSE content-adoption, so two identical in-flight submissions (e.g. two
  strikes on repeated text, both with empty notes) cannot cross-assign sids and orphan a
  ticket into a permanent duplicate card.
- `cardHTML` gains a draft branch: in connected mode a draft renders the disconnected-style
  contenteditable note, and *always* renders the note element for drafts even when empty
  (the current connected branch renders no note element at all for an empty note - an empty
  strike draft would have nothing to type into). `submitDraft` forces a card rebuild on the
  draft→submitted transition: `ensureCard` reuses card DOM and never re-runs `cardHTML`, so
  without an explicit rebuild the note would stay editable after send. The payload is
  serialized at send, so the rebuild also prevents mid-flight edits from silently diverging
  from what the agent received.
- `reconcile()`'s content matcher gains one condition: `!x.draft` (it currently adopts any
  sid-less entry matching `quote`+`note`+`page`). Together with the send-time flip: an unsent
  draft is `draft: true` and never adopted; an in-flight submission is `draft: false` and
  immediately adoptable - so the existing SSE-beats-POST race stays closed, while a server
  ticket that merely shares text with an unsent draft (another tab, a duplicate note) creates
  its own card instead of stealing the draft.
- `isComposing()` needs no change - draft notes carry the `.fb-note` class its existing
  check already covers.

## 5. Out of scope (explicitly)

- **Server-side draft status** (survives across browsers/machines, visible to agent tooling).
  Deliberately deferred: it changes the queue file contract and `watch-inbox` gating for
  little v1 benefit. sessionStorage persistence covers the realistic failure mode (reload).
- Reordering / prioritizing drafts before submission.
- Editing an already-submitted ticket.
- **POST-failure idempotency.** The server persists a ticket before responding
  (`server.js:81-85`), so a response lost after a successful write, then retried, can create a
  duplicate ticket. A real fix needs a server-side dedup key - out of scope for a widget-only
  change. Narrower in practice than it sounds (today's silent, no-retry failure path isn't
  better), but not eliminated.
- **`Fix all` outrunning inbox ingestion.** If the skill is idle, wakes on the first ticket in
  a batch, and fully resolves it before later sequential POSTs land, those later tickets can
  sit unmerged until an unrelated future comment triggers the next wake (`watch-inbox.js`
  snapshots the inbox size fresh on every invocation). Closing this needs a batch endpoint or a
  rescan-before-sleep change to the drain loop - both are skill/server-protocol changes, out of
  scope here. In practice a narrow window: a full fix+verify cycle takes much longer than a
  handful of sequential localhost POSTs.
- **Auto-expiry of submitted-pending entries.** If the board is wiped externally (Clean from
  another session, server restarted on a fresh queue) while a submission is pending
  board-merge, the persisted entry lingers as a card the server no longer knows about. The
  widget cannot distinguish "board wiped" from "skill just hasn't merged yet" (that gap can
  legitimately last minutes while the skill is busy), and auto-reverting to draft would
  invite duplicate submissions - so v1 has no auto-expiry. ✕ or Clean is the escape hatch
  (both purge the snapshot).

## 6. Release notes

Behavior change: connected-mode notes are **no longer sent automatically**. This is
intentional and the default cannot be configured (no mode). Per the release checklist:
bump `extension/manifest.json` + `package.json`, plus plugin versions
(`plugins/cc-htmlfeedback/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`),
run `node build.js`, and update README / SKILL.md wording where it says comments are fixed
immediately. The one-time first-draft toast (§3.1) is the in-product migration cue; these
release notes are the record, not the delivery mechanism.

## 7. Test plan (high level)

- Unit (new - the repo's `node --test` harness covers server/lib only; widget-internal logic
  needs its own tests): `add()` creates a draft with `page` set, no POST; `submitDraft` flips
  state at send, reverts on failure, and never overwrites an SSE-stamped `sid`; `Fix all`
  creation order + stop-on-first-failure + resume-from-failed-item on retry; board-seen
  persistence (an entry with a recorded `sid` still persists until board data contains it);
  restore advances `uid` past the highest restored id and skips `removed: true` entries;
  persistence writes coalesce under the ~300 ms debounce; ✕ soft-removes and purges from the
  snapshot while keeping undo working; ✕ on an in-flight card hides only (no cancel);
  `statusOf`/`SEC_ORDER`/`SEC_LABEL`/`ORDER` render a Drafts section (no "undefined" header);
  reconcile skips `draft: true` entries and does not duplicate restored ones; badge counts
  drafts.
- Chrome E2E (new - no E2E infra exists yet): draft card renders in `Drafts` with an editable
  note, including an *empty-note strike draft*; Fix moves it to `To do` and locks the note;
  Cmd/Ctrl+Enter and Cmd/Ctrl+click fast paths; plain Enter still saves a draft
  (branch-ordering regression guard); Cmd/Ctrl+Backspace fires only on an empty box and
  ignores key-repeat; reload
  in the sid→board gap restores the just-submitted card; a completed fix morphs the page and
  every remaining draft's highlight survives; the first-draft toast shows exactly once;
  disconnected mode unchanged.
