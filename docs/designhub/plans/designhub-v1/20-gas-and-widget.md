# DesignHub v1 Implementation Plan - part 2 of 4: GAS entry points, widget transform, deploy

> Tasks 6-8. Read [00-overview.md](00-overview.md) FIRST - it holds the goal,
> the non-negotiable constraints (D16, dual-use modules, HtmlService gotchas,
> Shared Drive REST discipline, hyphens-only), the fixed configuration
> placeholders, the file map, and the final verification checklist. Task
> numbering is global across the four part files. Steps use checkbox
> (`- [ ]`) syntax for tracking.

---

### Task 6: GAS entry points - `drive.js`, `bridge.js`, `main.js`

The thin Apps-Script-only layer: Drive/Sheets adapters, the six bridge functions, the doGet router, and the D19 reconciler + trigger. No unit tests (this is the mocked boundary); correctness is covered by the pure libs above and E2E in Task 13. Write the code exactly as below.

**Files:**
- Create: `designhub/gas/drive.js`
- Create: `designhub/gas/bridge.js`
- Create: `designhub/gas/main.js`

- [ ] **Step 1: Create `designhub/gas/drive.js`:**

```js
// DriveApp/SpreadsheetApp adapters. Thin by design (D5): everything testable
// lives in lib/, this file only touches Google services.

function dhChildFolder_(folder, name) {
  var it = folder.getFoldersByName(name);
  if (!it.hasNext()) throw new Error('DesignHub: folder not found: ' + name);
  return it.next();
}

// Resolve ?doc=<repo>/<featureDir>/<subpath...> to the Drive file + its
// feature folder. Path is the public addressing scheme; the feature _index
// row (matched by driveFileId) is the authoritative pointer to the companion
// Sheet (design section 5: resolve by id, never by name).
function dhResolveDoc_(path) {
  var p = DH_PATHS.parseDocPath(path);
  var folder = DriveApp.getFolderById(DH_CONFIG.rootFolderId);
  folder = dhChildFolder_(folder, p.repo);
  var featureFolder = dhChildFolder_(folder, p.featureDir);
  folder = featureFolder;
  for (var i = 0; i < p.segments.length - 1; i++) folder = dhChildFolder_(folder, p.segments[i]);
  var files = folder.getFilesByName(p.fileName);
  if (!files.hasNext()) throw new Error('DesignHub: doc not found: ' + path);
  return { file: files.next(), featureFolder: featureFolder, parsed: p };
}

function dhIndexRows_(featureFolder) {
  var it = featureFolder.getFilesByName('_index');
  if (!it.hasNext()) throw new Error('DesignHub: _index missing for feature ' + featureFolder.getName());
  var sheet = SpreadsheetApp.openById(it.next().getId()).getSheetByName('index');
  var values = sheet.getDataRange().getValues();
  return values.slice(1).map(function (row) { return DH_SCHEMA.rowToIndex(row); });
}

// path -> the doc's companion tickets spreadsheet (+ file id for audit rows)
function dhCommentsFor_(path) {
  var r = dhResolveDoc_(path);
  var fileId = r.file.getId();
  var row = dhIndexRows_(r.featureFolder).filter(function (o) { return o.driveFileId === fileId; })[0];
  if (!row || !row.commentSheetId) throw new Error('DesignHub: no index row / commentSheetId for ' + path);
  return { ss: SpreadsheetApp.openById(row.commentSheetId), indexRow: row, fileId: fileId };
}

function dhPortalRows_() {
  var root = DriveApp.getFolderById(DH_CONFIG.rootFolderId);
  var it = root.getFilesByName('_portal-index');
  if (!it.hasNext()) return [];   // nothing published yet
  var sheet = SpreadsheetApp.openById(it.next().getId()).getSheets()[0];
  var values = sheet.getDataRange().getValues();
  return values.slice(1).map(function (row) { return DH_SCHEMA.rowToIndex(row); });
}

// D19 reconciler: rebuild _portal-index from every feature _index shard.
//
// Shard-ordering decision (see the "Two items for whoever executes Task 6
// and Task 10" note above): rollup.js's buildRollup breaks an exact
// updatedAt tie by first-row-wins, which is only deterministic for a FIXED
// `shards` order - it has no way to impose one itself (see its own
// comment). Drive's getFolders()/getFilesByName() iteration order is NOT
// guaranteed, so if we pushed shards in raw traversal order, the tie-break
// winner on an exact-timestamp collision (and therefore what the portal
// index shows) could flap between reconciler runs with no underlying data
// change. We already compute each folder's path while walking the tree, so
// recording it alongside its shard and sorting by path before calling
// buildRollup is free and makes the result deterministic run-to-run
// regardless of Drive's listing order.
// Trailing underscore (final-review finding): a top-level GAS function without
// one is reachable from a published doc's own script via google.script.run -
// this function isn't part of D17(a)'s bridge contract (comment-Sheet rows +
// catalog reads only) and shouldn't be client-callable at all. The Apps
// Script editor's manual "Run" dropdown and ScriptApp trigger targeting both
// still work on underscore-suffixed names - only google.script.run
// reachability is affected.
function dhReconcile_() {
  var root = DriveApp.getFolderById(DH_CONFIG.rootFolderId);
  var shards = [];
  var queue = [{ folder: root, path: '' }];
  while (queue.length) {
    var entry = queue.shift();
    var folder = entry.folder;
    var subs = folder.getFolders();
    while (subs.hasNext()) {
      var sub = subs.next();
      queue.push({ folder: sub, path: entry.path + '/' + sub.getName() });
    }
    var files = folder.getFilesByName('_index');
    while (files.hasNext()) {
      var ss = SpreadsheetApp.openById(files.next().getId()).getSheetByName('index');
      if (ss) shards.push({ path: entry.path, rows: ss.getDataRange().getValues().slice(1) });
    }
  }
  shards.sort(function (a, b) { return a.path.localeCompare(b.path); });
  var rows = DH_ROLLUP.buildRollup(shards.map(function (s) { return s.rows; }));
  var it = root.getFilesByName('_portal-index');
  if (!it.hasNext()) throw new Error('DesignHub: _portal-index missing - first publish creates it');
  var sheet = SpreadsheetApp.openById(it.next().getId()).getSheets()[0];
  sheet.getRange('A2:N10000').clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, DH_SCHEMA.INDEX_COLS.length).setValues(rows);
  return rows.length;
}

// One-time (idempotent) trigger install - run manually from the editor after
// first deploy, or re-run any time; it replaces any existing dhReconcile_ trigger.
// Also underscore-suffixed (see dhReconcile_'s comment) - it isn't part of the
// bridge contract either.
function dhInstallReconcilerTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dhReconcile_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dhReconcile_').timeBased()
    .everyHours(DH_CONFIG.reconcilerEveryHours).create();
}
```

- [ ] **Step 2: Create `designhub/gas/bridge.js`:**

```js
// The google.script.run bridge (design section 5). Note: section 5 also lists
// getDoc(path); in v1 doc retrieval IS doGet(?doc=path) - a bridge getDoc has
// no consumer until a client-side router exists, so it is deliberately absent.
// D17 containment: this file is the ONLY privileged surface doc scripts can
// reach. It must never grow beyond comment-Sheet rows + catalog reads, and
// every mutating call stamps identity server-side from the session.

function getIdentity(clientClaim) {
  return { server: Session.getActiveUser().getEmail(), clientClaim: clientClaim || null };
}

function listCatalog(filter) {
  var rows = dhPortalRows_();
  if (filter && filter.repo) rows = rows.filter(function (r) { return r.repo === filter.repo; });
  return { rows: rows };
}

// Returns tickets in the WIDGET's shape: page keyed by docPath, status mapped
// to board states, replies excluded (v1 widget shows top-level tickets only;
// threads live in the Sheet and the agent docs).
function listComments(docPath) {
  var c = dhCommentsFor_(docPath);
  var values = c.ss.getSheetByName('tickets').getDataRange().getValues().slice(1);
  var tickets = values.map(function (row) { return DH_SCHEMA.rowToTicket(row); })
    .filter(function (t) { return !t.parentId; })
    .map(function (t) {
      return { id: t.id, quote: t.quote, context: t.context, section: t.section,
        note: t.note, type: t.type, page: docPath,
        status: DH_SCHEMA.widgetStatus(t.status), result: t.result, files: [] };
    });
  return { tickets: tickets };
}

function submitComment(docPath, ticket) {
  ticket = ticket || {};
  var c = dhCommentsFor_(docPath);
  var now = new Date().toISOString();
  var t = { id: Utilities.getUuid(), parentId: '', type: ticket.type === 'strike' ? 'strike' : 'comment',
    status: 'open', quote: String(ticket.quote || ''), context: String(ticket.context || ''),
    section: String(ticket.section || ''), note: String(ticket.note || ''),
    authorEmail: Session.getActiveUser().getEmail(),   // client-supplied identity ignored (D17)
    authorName: '', source: 'web', docVersion: String(c.indexRow.updatedAt || ''),
    result: '', files: '', createdAt: now, updatedAt: now };
  c.ss.getSheetByName('tickets').appendRow(DH_SCHEMA.ticketToRow(t));
  return { id: t.id };
}

function reply(docPath, parentId, note) {
  var c = dhCommentsFor_(docPath);
  var now = new Date().toISOString();
  var t = { id: Utilities.getUuid(), parentId: String(parentId || ''), type: 'reply',
    status: 'open', quote: '', context: '', section: '', note: String(note || ''),
    authorEmail: Session.getActiveUser().getEmail(), authorName: '', source: 'web',
    docVersion: '', result: '', files: '', createdAt: now, updatedAt: now };
  c.ss.getSheetByName('tickets').appendRow(DH_SCHEMA.ticketToRow(t));
  return { id: t.id };
}

function setStatus(docPath, id, status) {
  if (DH_SCHEMA.VALID_STATUSES.indexOf(status) === -1) throw new Error('invalid status: ' + status);
  var c = dhCommentsFor_(docPath);
  var sheet = c.ss.getSheetByName('tickets');
  var values = sheet.getDataRange().getValues();
  var email = Session.getActiveUser().getEmail();
  var now = new Date().toISOString();
  var ID = DH_SCHEMA.TICKET_COLS.indexOf('id');
  var STATUS = DH_SCHEMA.TICKET_COLS.indexOf('status');
  var UPDATED = DH_SCHEMA.TICKET_COLS.indexOf('updatedAt');
  for (var i = 1; i < values.length; i++) {
    if (values[i][ID] === id) {
      sheet.getRange(i + 1, STATUS + 1).setValue(status);
      sheet.getRange(i + 1, UPDATED + 1).setValue(now);
      // D17(c): status changes land in the audit history (meta tab), so forged
      // or surprising activity is detectable and reversible.
      c.ss.getSheetByName('meta').appendRow(['', '', '', '', '', '', email, now,
        'setStatus ' + id + ' -> ' + status]);
      return { id: id, status: status };
    }
  }
  throw new Error('ticket not found: ' + id);
}
```

- [ ] **Step 3: Create `designhub/gas/main.js`:**

```js
// doGet router: tree (no params) | ?doc=<path> (serve html/md + widget) |
// ?asset=widget|marked|mermaid (ContentService JS - poc3: big bundles must
// NOT be inlined, HtmlService truncates giant inline scripts).
//
// The widget asset specifically must NOT be served via
// HtmlService.createHtmlOutputFromFile: verified empirically (Task 13 E2E
// against the real deployed app) that Chrome's Opaque Response Blocking (ORB)
// blocks that response when fetched as a <script> subresource from inside the
// sandboxed content iframe - both as a static server-embedded <script src> tag
// and as a dynamically-created one. DH_WIDGET_JS (gas/widget.js, a plain
// script-scope string built by build-designhub.js) sidesteps HtmlService
// entirely, matching the already-proven marked/mermaid DriveApp-based routes.

function dhExecUrl_() { return ScriptApp.getService().getUrl(); }

function dhAsset_(name) {
  if (name === 'widget') {
    return ContentService.createTextOutput(DH_WIDGET_JS).setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  var id = DH_CONFIG.assets[name];
  if (!id) throw new Error('unknown asset: ' + name);
  return ContentService.createTextOutput(DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8'))
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.asset) return dhAsset_(p.asset);
  if (!p.doc) {
    return HtmlService.createHtmlOutput(DH_RENDER.treeHtml(dhPortalRows_()))
      .setTitle('DesignHub').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  // A stale bookmark, typo, or deleted/renamed doc would otherwise surface as
  // GAS's generic, unbranded uncaught-exception page - render DesignHub's own
  // not-found page instead. The thrown message only echoes the caller's own
  // ?doc= input, so there's nothing sensitive to leak into it.
  var r;
  try {
    r = dhResolveDoc_(p.doc);
  } catch (err) {
    return HtmlService.createHtmlOutput(DH_RENDER.notFoundHtml(p.doc))
      .setTitle('DesignHub - not found').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  var out;
  if (/\.md$/i.test(r.parsed.fileName)) {
    var md = r.file.getBlob().getDataAsString('UTF-8');
    var markedJs = DriveApp.getFileById(DH_CONFIG.assets.marked).getBlob().getDataAsString('UTF-8');
    var shell = DH_RENDER.mdShell(md, markedJs, dhExecUrl_() + '?asset=mermaid', r.parsed.fileName);
    // Splice the widget in at the shell's KNOWN tail. A replace of the FIRST
    // '</body></html>' would hit a literal one inside the MD_SOURCE JSON string
    // if the markdown ever quotes closing tags - and widgetTags contains real
    // </script> sequences, which would truncate that script block.
    var tail = '</body></html>';
    out = shell.slice(0, shell.length - tail.length) +
      DH_RENDER.widgetTags(p.doc, dhExecUrl_()) + tail;
  } else {
    out = DH_RENDER.serveHtml(r.file.getBlob().getDataAsString('UTF-8'), p.doc, dhExecUrl_());
  }
  return HtmlService.createHtmlOutput(out)
    .setTitle('DesignHub - ' + r.parsed.fileName)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
```

- [ ] **Step 4: Full test suite still green:** `node --test designhub/test/` (the GAS files are not loaded by node; this catches accidental lib edits).

- [ ] **Step 5: Commit:** `git add designhub/ && git commit -m "designhub: GAS entries - doGet router, six-function bridge, D19 reconciler"`

---

### Task 7: `build-designhub.js` - the fail-loud widget transform (D16)

Generates `designhub/gas/widget.js` (raw widget JS wrapped as a plain script-scope string, served via `?asset=widget`) from untouched upstream `feedback-widget.html`. Mirrors upstream `build.js` extraction, then swaps the transport layer. Every replacement asserts its anchor string occurs EXACTLY ONCE so upstream drift fails the build instead of silently shipping a broken widget.

**Why a `.js` string constant and not an `.html` HtmlService file (execution-time finding, Task 13):** the artifact was originally `designhub/gas/widget.html`, served via `HtmlService.createHtmlOutputFromFile('widget').getContent()`. Task 13's real E2E run against the deployed app found this response gets blocked by Chrome's Opaque Response Blocking (ORB) when fetched as a `<script>` subresource from inside the sandboxed content iframe - reproduced both as a static server-embedded `<script src>` tag and as a dynamically-created one, and confirmed the differentiator empirically: the DriveApp-sourced `marked`/`mermaid` asset routes (same ContentService wrapping, no HtmlService involved) load fine via the identical dynamic-injection pattern. The fix moves the widget off HtmlService entirely: `build-designhub.js` wraps the transform's output as `var DH_WIDGET_JS = <JSON-escaped string>;` in a plain `.js` project file, and `dhAsset_('widget')` in Task 6's `main.js` returns it directly via `ContentService.createTextOutput(DH_WIDGET_JS)` - no file-read API at all.

The complete upstream transport surface (verified by reading `feedback-widget.html` at the revision this plan was written; line refs for orientation only - match on strings, not lines):
- `ccfbPost()` - POST `/__ccfb/tickets` (submit)
- `loadTickets()` - GET `/__ccfb/tickets?page=` (board pull)
- `subscribeSSE()` - EventSource `/__ccfb/events` (live updates - dropped in v1 per design section 6, replaced by 30 s polling)
- the Clean handler's POST `/__ccfb/clean` (dropped: on DesignHub the Sheet is authoritative; Clean stays local-view-only, which also sidesteps upstream's known clean-deletes-unseen-tickets issue)
- 10 textual occurrences of `location.href` for page keying: 2 on the `FILE` line, 1 inside the `//` comment above `add()`'s new-entry `store[id] = ...` line ("a later morph's re-anchor pass (which filters on f.page === location.href)"), 7 more in code (one of which - the Clean handler's - is removed by R4). On DesignHub the page key is the doc path, injected as `window.__CCFB.docPath`. NOTE: a separate `//` comment in the draft-persistence block mentions `/__ccfb/tickets`, so post-transform endpoint guards must ignore comment lines.
- `window.__CCFB.mode === 'proxy'` already disables the morph path - we inject `mode:'proxy'`.

**Files:**
- Create: `designhub/build-designhub.js`
- Create: `designhub/gas/widget.js` (generated - never hand-edit)
- Test: `designhub/test/transform.test.js`

- [ ] **Step 1: Write the failing test** (`designhub/test/transform.test.js`) - runs the transform against the REAL upstream source so upstream drift is caught in CI:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { transform, wrap } = require('../build-designhub.js');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'feedback-widget.html'), 'utf8');

test('transform produces a self-injecting widget with GAS transport', () => {
  const out = transform(src);
  assert.match(out, /google\.script\.run/);
  assert.match(out, /dhRun\('submitComment'/);
  assert.match(out, /dhRun\('listComments'/);
  // Upstream comment lines legitimately MENTION /__ccfb/ - assert on code lines only.
  const code = out.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /\/__ccfb\//);        // no live server endpoints remain
  assert.doesNotMatch(out, /EventSource/);        // SSE fully removed (v1)
  // Page keying goes through dhPage(); its own fallback is the ONE allowed use.
  assert.equal((code.match(/location\.href/g) || []).length, 1,
    'only the dhPage() fallback may reference location.href');
  assert.match(out, /function dhPage\(\)/);
  assert.match(out, /setInterval\(loadTickets, 30000\)/);
  assert.match(out, /__fbWidgetLoaded/);          // self-injection guard kept
  assert.ok(out.length > 30000, 'suspiciously small output: ' + out.length);
});

test('transform fails loudly when an anchor string is missing (upstream drift)', () => {
  assert.throws(() => transform(src.replace('function ccfbPost', 'function ccfbPostX')),
    /ccfbPost/);
});

test('transform fails loudly when a second anchor string is missing (loadTickets renamed)', () => {
  assert.throws(() => transform(src.replace('function loadTickets', 'function loadTicketsX')),
    /loadTickets/);
});

test('transform fails loudly when subscribeSSE cannot be located (renamed/restructured upstream)', () => {
  assert.throws(() => transform(src.replace('function subscribeSSE(){', 'function subscribeSSEX(){')),
    /subscribeSSE/);
});

test('transform fails loudly on a second <style> block (would otherwise be silently dropped)', () => {
  const injected = src.replace('</script>', '</script>\n<style>.extra{color:red}</style>');
  assert.throws(() => transform(injected), /exactly one <style> block/);
});

test('transform fails loudly on a second <script> block (would otherwise be silently dropped, even one carrying a new /__ccfb/ endpoint)', () => {
  const injected = src.replace('</script>', '</script>\n<script>fetch("/__ccfb/newthing");</script>');
  assert.throws(() => transform(injected), /exactly one <script> block/);
});

test('transform fails loudly when the output would be malformed JS (syntax backstop catches what no single anchor check does)', () => {
  // Plausible upstream reformat: a nested object literal inside subscribeSSE whose closing brace
  // lands at the same indentation the non-greedy subscribeSSE regex stops at. The match still
  // contains "EventSource" (so that guard passes) but truncates before the function's real end,
  // leaving the original tail (the reload listener, the catch, the real closing brace) dangling as
  // orphaned statements - invalid JS that no earlier check in transform() catches on its own.
  const injected = src.replace(
    "es.addEventListener('tickets', e => { try { reconcile(JSON.parse(e.data).tickets || []); } catch{} });",
    "es.addEventListener('tickets', e => { try { reconcile(JSON.parse(e.data).tickets || []); } catch{} });\n      var X = {\n    a: 1\n  };"
  );
  assert.throws(() => transform(injected), /not valid JavaScript/);
});

test('wrap() round-trips through require() to the exact transform() output (real widget content)', () => {
  const out = transform(src);
  const wrapped = wrap(out);
  const f = path.join(os.tmpdir(), 'wrap-roundtrip-' + process.pid + '-' + Date.now() + '.js');
  fs.writeFileSync(f, wrapped);
  try {
    delete require.cache[require.resolve(f)];
    const roundTripped = require(f);
    assert.equal(roundTripped, out);
  } finally {
    fs.unlinkSync(f);
  }
});

test('wrap() safely escapes JS/JSON-tricky content: quotes, backslashes, backticks, ${}, U+2028/U+2029, emoji', () => {
  const tricky = 'a"b\'c\\d`e${f}g h i</script>j 🎉 k';
  const wrapped = wrap(tricky);
  const f = path.join(os.tmpdir(), 'wrap-tricky-' + process.pid + '-' + Date.now() + '.js');
  fs.writeFileSync(f, wrapped);
  try {
    delete require.cache[require.resolve(f)];
    const roundTripped = require(f);
    assert.equal(roundTripped, tricky);
  } finally {
    fs.unlinkSync(f);
  }
});
```

- [ ] **Step 2: Run to verify FAIL:** `node --test designhub/test/transform.test.js`

- [ ] **Step 3: Implement `designhub/build-designhub.js`:**

```js
#!/usr/bin/env node
/* Build the DesignHub widget variant from UNTOUCHED upstream feedback-widget.html.
 *   node designhub/build-designhub.js          - write designhub/gas/widget.js
 *   node designhub/build-designhub.js --check  - verify output matches source; exit 1 on drift
 * Transport swap: fetch /__ccfb/* + SSE -> google.script.run bridge (design D16, section 6).
 * FAIL-LOUD CONTRACT: every anchor string below must occur exactly once in the
 * upstream source; if upstream refactors, this build BREAKS instead of shipping
 * a silently wrong widget. Fix by updating the anchors after reviewing the change.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'gas', 'widget.js');

function fail(msg) { console.error('build-designhub.js: ' + msg); process.exit(1); }

function replaceOnce(body, anchor, replacement, label) {
  const i = body.indexOf(anchor);
  if (i === -1) throw new Error('anchor not found (' + label + '): upstream feedback-widget.html changed - review and update build-designhub.js');
  if (body.indexOf(anchor, i + 1) !== -1) throw new Error('anchor not unique (' + label + '): the exact text "' + anchor + '" occurs more than once - upstream duplicated or restructured this code; narrow the anchor and update build-designhub.js');
  return body.slice(0, i) + replacement + body.slice(i + anchor.length);
}

// Parse-only validity check (node --check on a temp file) rather than new
// Function()/eval, which would construct a live, invocable function from
// generated text - unnecessary here and an avoidable code-smell even though
// nothing untrusted flows through this build-time-only script. Shared by both
// transform()'s backstop (catches a truncated/malformed body) and main()'s
// check on the final wrapped file (catches a wrapping-layer bug - belt and
// braces, since ES2019's JSON-is-a-JS-subset guarantee already makes the
// second check provably redundant for well-formed input).
function assertValidJs(content, label) {
  const f = path.join(os.tmpdir(), 'ccfb-designhub-' + label + '-' + process.pid + '-' + Date.now() + '.js');
  try {
    fs.writeFileSync(f, content);
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    const detail = (e.stderr ? e.stderr.toString() : e.message).trim();
    throw new Error('generated ' + label + ' is not valid JavaScript:\n' + detail);
  } finally {
    try { fs.unlinkSync(f); } catch { /* best-effort cleanup */ }
  }
}

function transform(src) {
  // -- extraction: same structural contract as upstream build.js --
  // Structural invariants the positional extraction below silently relies on: grab() takes
  // the FIRST <style>/<script> block non-greedily, so a second one added upstream would be
  // silently dropped rather than erroring. Assert the count up front instead (mirrors build.js).
  const countOf = re => (src.match(re) || []).length;
  if (countOf(/<style>/g) !== 1) throw new Error('expected exactly one <style> block in feedback-widget.html, found ' + countOf(/<style>/g) + ' - upstream added/removed a block; review the new structure before updating the extraction regexes');
  if (countOf(/<script>/g) !== 1) throw new Error('expected exactly one <script> block in feedback-widget.html, found ' + countOf(/<script>/g) + ' - upstream added/removed a block; review the new structure before updating the extraction regexes');
  const grab = (re, label) => {
    const m = src.match(re);
    if (!m) throw new Error('could not find ' + label + ' in feedback-widget.html (expected ' + re + '): upstream structure changed - review and update build-designhub.js');
    return m[1];
  };
  const css = grab(/<style>([\s\S]*?)<\/style>/, '<style> block').trim();
  const markup = grab(/<\/style>([\s\S]*?)<script>/, 'markup between </style> and <script>').trim().replace(/^<!--[\s\S]*?-->\s*/, '');
  const scriptFull = grab(/<script>([\s\S]*?)<\/script>/, '<script> block').trim();
  const iife = scriptFull.match(/^\(function\(\)\{([\s\S]*)\}\)\(\);?$/);
  if (!iife) throw new Error('source <script> must be a single bare IIFE: (function(){ ... })() - wrapper not found, upstream changed');
  let body = iife[1];
  if (css.length < 100 || markup.length < 100 || body.length < 100) {
    throw new Error('extraction produced suspiciously small output (css ' + css.length + ', markup ' + markup.length + ', body ' + body.length + ') - check the source structure');
  }

  // -- R1: submit goes through the bridge; shim keeps the fetch-Response shape
  //    submitDraft() relies on: r.ok, r.json() -> {id} --
  body = replaceOnce(body,
    "function ccfbPost(t){ return fetch(ccfbBase() + '/__ccfb/tickets', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(t) }); }",
    "function ccfbPost(t){ return dhRun('submitComment', window.__CCFB.docPath, t).then(function(row){ return { ok: true, status: 200, json: function(){ return Promise.resolve(row); } }; }); }",
    'ccfbPost');

  // -- R2: board pull via bridge; success doubles as the liveness signal --
  body = replaceOnce(body,
    "function loadTickets(){ fetch(ccfbBase() + '/__ccfb/tickets?' + pageParam()).then(r => r.json()).then(d => reconcile(d.tickets || [])).catch(() => {}); }",
    "function loadTickets(){ dhRun('listComments', window.__CCFB.docPath).then(function(d){ reconcile(d.tickets || []); setConn('live'); }).catch(function(){ setConn('offline'); }); }",
    'loadTickets');

  // -- R3: SSE -> 30 s polling (v1 drops live push per design section 6) --
  const sse = body.match(/  function subscribeSSE\(\)\{[\s\S]*?\n  \}/);
  if (!sse) throw new Error('anchor not found (subscribeSSE block)');
  if (!/EventSource/.test(sse[0])) throw new Error('subscribeSSE block does not contain EventSource - refusing to replace');
  body = replaceOnce(body, sse[0],
    "  function subscribeSSE(){ setConn('connecting'); setInterval(loadTickets, 30000); }",
    'subscribeSSE');

  // -- R4: Clean stays local-only (the Sheet is the durable record) --
  body = replaceOnce(body,
    "    if(CCFB) fetch(ccfbBase() + '/__ccfb/clean', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ page: location.href }) }).catch(() => {});",
    "    /* DesignHub: Clean clears the local view only - comments stay in the Sheet. */",
    'clean handler');

  // -- R5: page keying by doc path. After R4, exactly 9 location.href remain
  //    (FILE x2, restore-time reanchor, the CODE COMMENT above add()'s new-entry
  //    line, new-entry page, reconcile re-anchor guard, morph fetch [dead in
  //    proxy mode], morph re-anchor, pageParam [now unused]). The global replace
  //    also rewrites the comment occurrence - harmless. --
  const count = (body.match(/location\.href/g) || []).length;
  if (count !== 9) throw new Error('expected exactly 9 location.href sites after clean removal, found ' + count + ' - upstream changed, re-audit page keying');
  body = body.replace(/location\.href/g, 'dhPage()');

  // -- prepend the bridge helpers (function declarations hoist above first use) --
  body = "\n  function dhPage(){ return (window.__CCFB && window.__CCFB.docPath) || location.href; }\n" +
    "  function dhRun(fn){ var args = [].slice.call(arguments, 1); return new Promise(function(res, rej){ var r = google.script.run.withSuccessHandler(res).withFailureHandler(rej); r[fn].apply(r, args); }); }\n" + body;

  // Upstream comment lines legitimately mention /__ccfb/ (the draft-persistence
  // block documents the old GET endpoint) - guard on code lines only.
  const codeOnly = body.split('\n').filter(function (l) { return !l.trim().startsWith('//'); }).join('\n');
  if (/\/__ccfb\//.test(codeOnly)) throw new Error('a /__ccfb/ endpoint survived the transform');

  const esc = s => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  const out = `/*! widget-designhub.js - the cc-htmlfeedback widget with google.script.run transport.
 * GENERATED from upstream feedback-widget.html by designhub/build-designhub.js - NEVER EDIT.
 * Served by the DesignHub web app as ?asset=widget (never inlined - HtmlService
 * truncates giant inline scripts, see docs/designhub/pocs/poc3). */
(function(){
  if (window.__fbWidgetLoaded || document.getElementById('fb-launch')) return;
  window.__fbWidgetLoaded = true;
  var FB_CSS = \`${esc(css)}\`;
  var FB_MARKUP = \`${esc(markup)}\`;
  function fbInit(){
    if (document.getElementById('fb-launch')) return;
    var st = document.createElement('style'); st.textContent = FB_CSS; document.head.appendChild(st);
    var tpl = document.createElement('template'); tpl.innerHTML = FB_MARKUP; document.body.appendChild(tpl.content);
${body}
  }
  if (document.body) fbInit();
  else document.addEventListener('DOMContentLoaded', fbInit);
})();
`;

  // Final backstop: the regex-based extraction/replacement above can - in principle - produce
  // a truncated or malformed body (e.g. a non-greedy anchor regex stopping at an unrelated brace
  // introduced by an upstream reformat) without any single check above catching it. Parsing the
  // FULL generated output catches that class of bug regardless of which step caused it.
  try {
    assertValidJs(out, 'widget.js (raw transform output)');
  } catch (e) {
    throw new Error(e.message + '\nThe transform likely produced a truncated/malformed body - re-check the R1-R5 anchors and the subscribeSSE regex against the current upstream structure');
  }

  return out;
}

// Wrapped as a plain script-scope JS string (a .js project file), NOT served via
// HtmlService.createHtmlOutputFromFile: verified empirically against the real
// deployed app (Task 13 E2E) that Chrome's Opaque Response Blocking (ORB) blocks
// an HtmlService-sourced ContentService response when fetched as a <script>
// subresource from inside the sandboxed content iframe - both as a static
// server-embedded <script src> tag AND as a dynamically-created one. A plain
// ContentService.createTextOutput(scriptScopeStringVar) response does not
// trigger it (matches the already-proven marked/mermaid asset routes, which
// read their content from DriveApp, never touching HtmlService).
function wrap(out) {
  return '// GENERATED by designhub/build-designhub.js from upstream feedback-widget.html - NEVER EDIT.\n' +
    '// Served by the DesignHub web app as ?asset=widget via plain ContentService,\n' +
    '// not HtmlService - see the comment above wrap() in build-designhub.js for why.\n' +
    'var DH_WIDGET_JS = ' + JSON.stringify(out) + ';\n' +
    "if (typeof module !== 'undefined') module.exports = DH_WIDGET_JS;\n";
}

function main() {
  const src = fs.readFileSync(path.join(root, 'feedback-widget.html'), 'utf8');
  let out;
  try { out = transform(src); } catch (e) { fail(e.message); }
  const wrapped = wrap(out);
  // Belt and braces: transform() already validated `out` in isolation, but this
  // checks the file exactly as GAS will load it (the var declaration + the
  // module.exports tail too) - provably redundant given ES2019's JSON-is-a-JS-
  // subset guarantee, but cheap enough to close the loop completely.
  try {
    assertValidJs(wrapped, 'widget.js (wrapped output)');
  } catch (e) {
    fail(e.message);
  }
  if (process.argv.includes('--check')) {
    const disk = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (disk !== wrapped) fail('designhub/gas/widget.js is stale - run: node designhub/build-designhub.js');
    console.log('build-designhub: up to date');
    return;
  }
  fs.writeFileSync(OUT, wrapped);
  console.log('wrote ' + OUT + ' (' + wrapped.length + ' bytes)');
}

if (require.main === module) main();
module.exports = { transform, wrap };
```

- [ ] **Step 4: Run tests, expect PASS:** `node --test designhub/test/transform.test.js`

- [ ] **Step 5: Generate the artifact and re-check:**

Run: `node designhub/build-designhub.js && node designhub/build-designhub.js --check`
Expected: `wrote .../widget.js (~66000 bytes)` then `build-designhub: up to date`

- [ ] **Step 6: Commit:** `git add designhub/ && git commit -m "designhub: fail-loud widget transform - GAS transport variant (D16)"`

---

### Task 8: Create, deploy, and authorize the production web app

Manual-ish task (browser consent involved) - follow exactly; poc1's Results section is the reference for every quirk you will see.

**Files:**
- Create: `designhub/gas/.clasp.json` (generated by clasp - GITIGNORED, the scriptId is org-specific)
- Create: `plugins/designhub/designhub.config.json` (committed placeholder template)
- Create: `plugins/designhub/designhub.config.local.json` (GITIGNORED - real values)

- [ ] **Step 1: Create the Apps Script project without clobbering local files.** `clasp create-script` clones the remote `appsscript.json` over local files, so create in a scratch dir and move the `.clasp.json`:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$(mktemp -d)" && npx -y @google/clasp create-script --title "DesignHub" --type standalone
mv .clasp.json "$REPO_ROOT/designhub/gas/.clasp.json"
cd "$REPO_ROOT/designhub/gas"
# clasp records the CREATION dir as rootDir - pin it to this dir or push grabs nothing:
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('.clasp.json','utf8'));j.rootDir='.';fs.writeFileSync('.clasp.json',JSON.stringify(j,null,2))"
```

Expected: "Created new script: https://script.google.com/d/<SCRIPT_ID>/edit". clasp v3 is installed and logged in as the publisher account `<DH_PUBLISHER_ACCOUNT>` (P1); verify with `clasp show-authorized-user` if unsure. `.clasp.json` stays local (gitignored in Task 1 Step 2b); record the printed `<SCRIPT_ID>` in `environment.local.md`.

- [ ] **Step 2: Push and deploy:**

```bash
cd designhub/gas && clasp push -f && clasp create-deployment -d "designhub v1"
```

Expected: `Deployed <DEPLOYMENT_ID> @1`. The exec URL is `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`.

- [ ] **Step 3: One-time owner authorization** (poc1 quirk: the consent screen has PER-SCOPE checkboxes; a partial grant serves pages but breaks the ungranted scope):

Open the exec URL in the logged-in dev-browser (named browser `designhub`), click "REVIEW PERMISSIONS", pick `<DH_PUBLISHER_ACCOUNT>`, on the scope screen **tick ALL FOUR scopes** (email, Drive read, Sheets, script triggers), Continue. The click-through sequence (popup handling, Select all pitfall) is documented in docs/designhub/pocs/poc1/README.md, Operational learnings #1; a human doing it in that browser window is equally fine.

- [ ] **Step 4: Install the D19 reconciler trigger:** open `https://script.google.com/d/<SCRIPT_ID>/edit`, select function `dhInstallReconcilerTrigger_` (the trailing underscore keeps it off `google.script.run`'s callable surface per D17(a) - the editor's Run dropdown still lists it), Run once (grants may re-prompt; approve).

- [ ] **Step 5: Smoke-check via dev-browser:**

```bash
dev-browser --browser designhub --timeout 90 <<'EOF'
const page = await browser.getPage("dh-smoke");
await page.goto("https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(5000);
for (const f of page.frames()) {
  const t = await f.evaluate(() => document.body ? document.body.innerText.slice(0, 120) : "").catch(() => "");
  if (t.includes("DesignHub")) console.log("tree page:", JSON.stringify(t));
}
EOF
```

Expected: tree page prints "No docs published yet...". (The `?asset=widget` route is exercised end-to-end by Task 13 - navigating to a ContentService JS URL directly downloads rather than renders, so do not smoke-test it by navigation.)

- [ ] **Step 6: Create the skill config pair** - the committed file keeps placeholders (the
fork stays generic); the gitignored `.local` file carries the real values from Step 2 and
wins at run time (publish.mjs prefers it, Task 10). Record `<SCRIPT_ID>`/`<DEPLOYMENT_ID>`
in `environment.local.md` too.

`plugins/designhub/designhub.config.json` (committed template):

```json
{
  "rootFolderId": "<DH_ROOT_FOLDER_ID>",
  "execUrl": "https://script.google.com/macros/s/<DH_DEPLOYMENT_ID>/exec"
}
```

`plugins/designhub/designhub.config.local.json` (gitignored - fill with the REAL ids):

```json
{
  "rootFolderId": "<real root folder id>",
  "execUrl": "https://script.google.com/macros/s/<real deployment id>/exec",
  "scriptId": "<real script id>",
  "deploymentId": "<real deployment id>"
}
```

- [ ] **Step 7: Commit:** `git add plugins/designhub/ && git commit -m "designhub: production web app deployed (execute-as-me, domain access)"` - `.clasp.json` and `designhub.config.local.json` stay local via the Task 1 ignore rules; `git status` must show them as ignored, not staged.

---

