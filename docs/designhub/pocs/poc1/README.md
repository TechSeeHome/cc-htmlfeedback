# POC-1 - the Approach C gate: HtmlService + widget + bridge + identity

**Status:** PASSED 2026-07-05 - Approach C confirmed for v1 (see Results)
**Gate:** yes - this is the spike design.md §9 names as the go/no-go for D4
(pure Apps Script v1). Failure here means switching runtime while switching is
still free.
**Prereqs:** P1 (clasp - done), P2 (dev-browser Google login)
**Estimate:** half a day

## Goal

Serve a **real, heavy design HTML** through an Apps Script web app with the
feedback widget active, and prove the four assumptions everything else stands
on:

1. **Rendering fidelity** - a self-contained dashboard (inline CSS/JS/fonts)
   renders inside the HtmlService IFRAME sandbox essentially as it does under
   `node server.js`.
2. **Viewer identity** - `Session.getActiveUser().getEmail()` returns the real
   viewer email under deploy settings "execute as me" + "anyone in the domain".
   This is the load-bearing assumption behind D13 and D17's server-side
   identity stamping; if it comes back empty, the identity model needs rework.
3. **Bridge round-trip** - widget selection → popover → `google.script.run
   .submitComment(ticket)` → row appended to a Sheet.
4. **Practical limits measured, not assumed** - max doc size HtmlService will
   serve, serving latency, bridge payload limits.

## Plan

Everything hand-rolled and minimal - no build system, no skill; spike code
lives in `poc1/gas/` (version-controlled, pushed with clasp).

1. `clasp create` a standalone web app project.
2. Fixtures in Drive under `DesignHub-POC/`: upload a real heavy dashboard HTML
   (the CRM evaluation dashboard from PR #1; fallback: this repo's
   `playground_file.html` plus a synthetically inflated copy for the size
   tests) and hand-create one comment Sheet with the `tickets` header row.
3. `doGet(e)`: read the HTML from Drive by file ID, inject a minimal widget
   variant (selection → popover → comment box; transport stubbed to
   `google.script.run`), set `<base target="_top">`, return via `HtmlService`.
4. Bridge: `submitComment(ticket)` appends a row, stamping
   `authorEmail = Session.getActiveUser().getEmail()` server-side and ignoring
   any client-supplied identity.
5. Deploy: execute as me, access "anyone in techsee.me".
6. Verify through logged-in **dev-browser scripts** (committed in this folder:
   navigate, select text in the served doc's iframe, submit, assert the Sheet
   row via API), plus a manual pass by Igor in his normal browser as a second
   sample.
7. **D17 containment check:** embed a `<script>` in the served doc that calls
   `submitComment` with a forged `authorEmail` - confirm the stored row carries
   the viewer's identity, not the forged one.
8. **Limits:** serve progressively larger docs (1 / 5 / 10 / 20 MB) until
   HtmlService refuses or degrades; time first-byte on each; push a large
   ticket payload through the bridge.

## Exit criteria

Pass (Approach C confirmed for v1):

- [ ] Dashboard renders with no visual regressions that matter for review
- [ ] `getActiveUser().getEmail()` returns `igora@techsee.me` when viewing
- [ ] Comment submitted from a text selection lands as a correct Sheet row
- [ ] In-doc anchor links navigate (post `<base target="_top">` rewrite)
- [ ] Forged-identity bridge call stored with the real viewer identity
- [ ] Measured size limit comfortably covers our real docs (record the number)

Fail (kill or reshape D4):

- Identity comes back empty → identity model rework before anything else
- Rendering broken beyond CSS fixes, or size ceiling below real docs → revisit
  runtime choice (serving layer graduates earlier than planned)

## Results

**PASSED - 2026-07-05. Approach C (pure Apps Script v1) is confirmed.**
Spike code: [`gas/`](./gas/) (deployed via clasp; web app
`AKfycbxLCY8EBX8mnDdpP28oWxzP4rWHehC1RpSUY8Ab1XLhJjVKazm7oNgQ2SJHE4rP704FTQ`,
version 2, execute-as-me, domain access). Fixture: the real `design.html`
uploaded by POC-2. All verification driven by committed dev-browser scripts in
the logged-in `designhub` profile.

| exit criterion | result |
|---|---|
| Rendering fidelity | ✅ real design.html (custom fonts, layout, colors) pixel-faithful inside the HtmlService iframe (screenshot checked) |
| Viewer identity | ✅ `Session.getActiveUser().getEmail()` returned `igora@techsee.me` under execute-as-me + domain access - the D13/D17 load-bearing assumption holds |
| Bridge round-trip | ✅ programmatic text selection → widget → `google.script.run.submitComment` → row in `design.html.comments` verified via Sheets REST |
| D17 forged identity | ✅ two attacks (widget payload claiming `client-claims@forged.example`; embedded doc-script claiming `ceo@techsee.me` + `source=agent`) - both rows stored with the real viewer identity and server-stamped `source=web` |
| In-doc anchor links | ✅ **after a required fix**: bare `#anchor` + `<base target="_top">` navigates the TOP window into the raw `googleusercontent.com` sandbox URL (widget lost, URL unshareable). Rewriting `href="#..."` links to `target="_self"` fixes it - fragment navigation stays in-frame, widget survives. The design's §3.2 "rewrites bare anchors" note is **mandatory, not optional** |
| Size / latency | ✅ no ceiling found: 1 MB 3.9 s · 5 MB 4.8 s · 10 MB 7.1 s · 20 MB 9.0 s full loads; server-side Drive read of 45 KB doc = 2.6 s. Real docs (tens of KB) are far below any limit |

**Operational learnings:**

1. **One-time owner authorization**: first `/exec` hit shows "Authorization
   needed" → OAuth consent (unverified-app flavor). The consent screen has
   **per-scope checkboxes** - a partial grant serves the doc but injects a
   Google warning banner frame and breaks the ungranted scope (Sheets). Fully
   automatable in dev-browser except the checkbox step needs explicit clicks.
2. **clasp v3 deployment mechanics**: `create-deployment` pins a version;
   `/dev` (HEAD) serves pushed code live but uses the *HEAD deployment's* ID,
   not the versioned one; `create-deployment -i <id>` redeploys the same URL.
3. HtmlService page structure is **doubly nested**: script.google.com wrapper
   → `userCodeAppPanel` frame (where Google injects warning banners) → user
   HTML frame (doc + widget). Test tooling must search frames for the widget
   rather than assume depth.
4. The `?doc=<driveFileId>` param pattern works as designed - one deployment
   serves any readable Drive doc.

**Not covered here** (deliberately): MD+mermaid rendering (poc3), re-anchor
logic, the real cc-htmlfeedback widget adaptation (implementation task, with
this POC's transport pattern).
