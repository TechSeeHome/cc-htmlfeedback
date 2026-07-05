# DesignHub v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship DesignHub v1: a `/publish-design` Claude Code skill that publishes repo HTML/MD design docs to the company Shared Drive, and an Apps Script web app that serves them Google-login-gated with the cc-htmlfeedback widget wired to a `google.script.run` bridge, comments stored in per-doc Google Sheets that agents read/write over plain REST.

**Architecture:** Everything of value lives in Drive + Sheets under the runtime-agnostic contracts of `docs/designhub/design.md` §5 (decisions D1-D19); Apps Script is a thin, disposable serving layer (D4). The repo stays a sync-safe monorepo fork (D16): all new code in additive paths `designhub/` + `plugins/designhub/`, upstream files untouched except one `marketplace.json` entry. The widget variant is generated from untouched upstream `feedback-widget.html` by a fail-loud build transform.

**Tech Stack:** Google Apps Script (V8, clasp v3), Drive v3 + Sheets v4 REST, Node 20 (`node --test`, zero deps), marked 15 + mermaid 11 (Drive-hosted assets), dev-browser for E2E.

---

## Required reading (in order)

1. `docs/designhub/design.md` - the spec. Decisions D1-D19 are binding; §5 data contracts are the law.
2. `docs/designhub/pocs/README.md` + each `pocN/README.md` **Results** section - every task below builds on a POC-proven mechanism; the POC code is the reference implementation. NOTE: `docs/designhub/pocs/` is gitignored (org-specific) - it exists on the dev machine only, not in fresh clones.
3. Repo `CLAUDE.md` - especially: never hand-edit `plugins/cc-htmlfeedback/` build artifacts, never use em dashes, bump versions on user-facing changes.

## Non-negotiable constraints (from D16 + POC findings)

- **Never edit upstream files** (`feedback-widget.html`, `build.js`, `server.js`, `lib/`, `plugins/cc-htmlfeedback/`, root `package.json`). Sole exception: one added entry in `.claude-plugin/marketplace.json` (Task 12).
- **GAS + node dual-use modules:** every file in `designhub/gas/lib/` is a plain script defining one global, with a guarded CommonJS export tail (`if (typeof module !== 'undefined') module.exports = ...`) so `node --test` can require it while clasp pushes it verbatim.
- **HtmlService gotchas (poc1/poc3, verified):** inline `<script>` bundles above ~40 KB risk silent truncation - anything bigger is served via the `?asset=` ContentService route; bare `#anchor` links must be rewritten to `target="_self"` after `<base target="_top">` injection; the served page is doubly-nested in iframes.
- **Shared Drive REST discipline (poc2):** every Drive call carries `supportsAllDrives=true`, every list also `includeItemsFromAllDrives=true`; Sheets are created in place via Drive `files.create` with the spreadsheet mimeType.
- **Writing style:** regular hyphens only, never em dashes (user rule, applies to code comments and docs).

## Fixed configuration (from P5 / POC deployments)

Org-specific values (`<DH_*>` placeholders throughout this plan) are recorded in
`docs/designhub/plans/environment.local.md` - gitignored, local-only. The committed
`environment.example.md` documents every placeholder; copy it to `environment.local.md`
and fill in your org's values.

| constant | value |
|---|---|
| Production DesignHub root folder | `<DH_ROOT_FOLDER_ID>` (inside the org's Shared Drive - see `environment.local.md`) |
| POC fixtures (dev/test target, disposable) | folder `DesignHub-POC` `<DH_POC_FOLDER_ID>` |
| marked 15 bundle in Drive | `<DH_MARKED_BUNDLE_ID>` (39 KB) |
| mermaid 11 bundle in Drive | `<DH_MERMAID_BUNDLE_ID>` (3.5 MB - asset route only) |
| Publisher OAuth (dev machine) | refresh token at `~/.claude/skills/gdoc-md-sync/token.json`, scope `https://www.googleapis.com/auth/drive` (also valid for Sheets v4 - poc-verified) |
| Agent test identity | `<DH_AGENT_ACCOUNT>`, token at `docs/designhub/pocs/poc4/.secrets/token-agent.json` (gitignored) |
| POC web app (reference, do not reuse for prod) | deployment `<DH_POC_DEPLOYMENT_ID>`, source `docs/designhub/pocs/poc1/gas/` |

## File structure (what this plan creates)

```text
designhub/
  build-designhub.js            fail-loud transform: feedback-widget.html -> gas/widget.html (Task 7)
  config.example.js             DH_CONFIG template (committed - placeholders only; lives
                                OUTSIDE gas/ so clasp push can never upload it, see Task 1)
  gas/                          clasp project (rootDir), created Task 1, deployed Task 8
    appsscript.json
    config.js                   real DH_CONFIG - GITIGNORED (org ids stay out of the fork)
    main.js                     doGet router: tree | ?doc= | ?asset=
    drive.js                    DriveApp/SpreadsheetApp adapters (thin, no unit tests)
    bridge.js                   getIdentity/listCatalog/listComments/submitComment/reply/setStatus
    widget.html                 BUILT ARTIFACT of build-designhub.js (committed, --check verified)
    lib/
      schema.js                 columns, status map, row<->object mapping        (Task 2)
      paths.js                  D14 path sanitize/parse                          (Task 3)
      rollup.js                 buildRollup/upsertRow (port of poc5)             (Task 4)
      render.js                 injectBase/anchor rewrite/md shell/tree html     (Task 5)
  test/
    schema.test.js  paths.test.js  rollup.test.js  render.test.js  transform.test.js  anchors.test.js  publish.test.js
  e2e/                           NOT under test/ - node's test runner would try to execute it
    serve-and-comment.mjs       dev-browser E2E (Task 13)
  README.md                     (Task 14)
plugins/designhub/
  .claude-plugin/plugin.json
  designhub.config.json         skill config TEMPLATE (committed - placeholders only)
  designhub.config.local.json   real rootFolderId + execUrl - GITIGNORED (Task 8)
  skills/publish-design/
    SKILL.md
    scripts/gauth.mjs           OAuth: refresh-or-consent, token cache            (Task 10)
    scripts/anchors.mjs         D15 re-anchor pure logic                          (Task 9)
    scripts/publish-lib.mjs     pure publish helpers: scan/infer/rows/featureDir  (Task 10)
    scripts/publish.mjs         the publish flow CLI                              (Task 10)
docs/designhub/agent-access.md  "the Sheet is the API" how-to                     (Task 11)
.github/workflows/designhub.yml CI: builds --check + all tests                    (Task 12)
.claude-plugin/marketplace.json +1 entry (the sole upstream-file edit, D16)       (Task 12)
.gitignore                      +3 lines: the local config files above            (Task 1)
```

**Config policy (matches `environment.example.md` and the repo's org-identifier scrub):
committed files carry `<DH_*>` placeholders only.** Real org values live exclusively in
gitignored files - `designhub/gas/config.js`, `designhub/gas/.clasp.json`,
`plugins/designhub/designhub.config.local.json` - filled from `environment.local.md`.
Nothing in this plan ever commits a real folder id, script id, deployment id, or exec URL.

**Test command for everything:** `node --test designhub/test/` (root `package.json` is upstream - do NOT add scripts to it).

**Known accepted risk (execution-time code review, Task 2):** unlike `TICKET_COLS`/
`INDEX_COLS`, `META_COLS` has no `rowToMeta`/`metaToRow` helpers in `schema.js` - the
meta-audit-row appends in Task 6's `setStatus` and Task 10's `publish.mjs` build meta
rows as hand-rolled positional arrays instead. They are verified correctly positioned
against `META_COLS` as drafted, but the column-order-drift protection `schema.js`
gives tickets/index doesn't extend to meta rows. Deferred rather than retrofitted
mid-plan (would touch two already-reviewed tasks); if `META_COLS` ever changes, grep
for its hand-rolled array literals in Tasks 6 and 10 and update them by hand.

**Two items for whoever executes Task 6 and Task 10 (execution-time code review,
Task 4):**
1. `rollup.js`'s `buildRollup` breaks an exact `updatedAt` tie by first-row-wins,
   which is deterministic for a given `shards` array but NOT run-to-run stable if the
   caller assembles `shards` in a non-fixed order. Task 6's `dhReconcile` walks Drive
   folders via `getFolders()`/`getFilesByName()`, whose iteration order Drive does not
   guarantee - so when implementing Task 6, consider sorting the shard list into a
   stable order (e.g. by folder path) before calling `buildRollup`, if reconciler
   output flapping between runs on a same-timestamp tie would matter in practice.
2. `rollup.js` exports `upsertRow` (insert-or-update-in-place over an in-memory rows
   array, tested in Task 4), but Task 10's drafted `publish.mjs` direct-upsert step
   reimplements the same find-or-append decision inline against live Sheets REST
   calls rather than calling it - and CANNOT simply call it, since the installed
   `plugins/designhub/` skill must stay self-contained and can't import
   `designhub/gas/lib/rollup.js` at runtime (the same constraint that's why Task 10's
   `publish-lib.mjs` mirrors `featureDir` instead of importing `paths.js`). When
   implementing Task 10, decide deliberately: leave the inline REST-shaped logic as
   is (it's functionally equivalent today), or extract a small local pure helper in
   `publish-lib.mjs` mirroring `upsertRow`'s decision shape for symmetry/testability -
   don't leave `upsertRow` as tested-but-unused GAS-side code without a conscious
   choice either way.

---


## Plan files (execute in order; task numbering is global)

| file | tasks | contents |
|---|---|---|
| [10-core-libs.md](10-core-libs.md) | 1-5 | scaffold, schema, paths, rollup, render - the pure TDD core |
| [20-gas-and-widget.md](20-gas-and-widget.md) | 6-8 | GAS entries + bridge, the Task 7 widget transform, production deploy |
| [30-publish-skill.md](30-publish-skill.md) | 9-11 | D15 anchors, the publish flow, SKILL.md + agent docs |
| [40-ship.md](40-ship.md) | 12-14 | marketplace entry + CI, E2E + dogfood, wrap-up + PR |

Each task-executing subagent needs exactly two files: this overview + the part
file holding its task.

## Post-v1 backlog (explicitly OUT of this plan - do not build)

- Phase 2 (design §7): Sync-to-PR, quote -> source-line mapping, the comment-driven agent fix loop skill (`plugins/designhub/skills/designhub-agent/`), multi-file docs.
- Widget thread/reply UI (v1 shows top-level tickets; threads live in the Sheet).
- Mermaid publish-time pre-render (poc3 finding 2, if the ~30 s diagram pop-in annoys) and `marked-gfm-heading-id` for MD TOC anchors (v1: marked emits no heading ids, so MD TOC links are safe no-ops - the mdShell `target="_self"` rewrite prevents the sandbox-escape navigation, but they do not scroll anywhere until the extension lands).
- Live updates (SSE equivalent) - v1 polls every 30 s.
- `designhub@` service account migration for the script owner (D13).

## Verification checklist (run after the last task)

- [ ] `node --test designhub/test/` - all green
- [ ] `node designhub/build-designhub.js --check` + `node build.js --check` - both clean
- [ ] `npm test` (upstream) - untouched and green
- [ ] Tree page lists the dogfooded docs; both serve with the widget
- [ ] A comment submitted in the browser lands in the companion Sheet with the VIEWER's email (not any client-claimed identity)
- [ ] D17 design-§9 attack re-run against PRODUCTION (poc1 only proved it on the POC app): from the served doc page's console, call the bridge with a forged `authorEmail` (row must stamp the session user) and call `setStatus` on an existing ticket (a `meta` audit row must appear)
- [ ] `<DH_AGENT_ACCOUNT>` can reply via REST per `agent-access.md` (poc4 recipe) against a PRODUCTION companion Sheet
- [ ] Re-publish of an edited doc: same URL, D15 statuses flip where expected
- [ ] `git log origin/main..HEAD -- feedback-widget.html build.js server.js lib/ plugins/cc-htmlfeedback/` is EMPTY (D16 honored). Use `origin/main` - THIS fork's main, where the PR lands - not the `leetwito/cc-htmlfeedback` upstream: that history carries pre-existing fork-side widget commits unrelated to this plan, so diffing against it always shows commits and never proves anything about D16.
- [ ] Config policy held: the committed `designhub/config.example.js` and `plugins/designhub/designhub.config.json` still contain `<DH_*>` placeholders (never real ids), and `git status --ignored designhub/gas plugins/designhub | grep -E 'config\.js|\.clasp\.json|config\.local\.json'` shows all three local files as ignored
