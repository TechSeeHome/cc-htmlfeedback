# DesignHub v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship DesignHub v1: a `/publish-design` Claude Code skill that publishes repo HTML/MD design docs to the company Shared Drive, and an Apps Script web app that serves them Google-login-gated with the cc-htmlfeedback widget wired to a `google.script.run` bridge, comments stored in per-doc Google Sheets that agents read/write over plain REST.

**Architecture:** Everything of value lives in Drive + Sheets under the runtime-agnostic contracts of `docs/designhub/design.md` §5 (decisions D1-D19); Apps Script is a thin, disposable serving layer (D4). The repo stays a sync-safe monorepo fork (D16): all new code in additive paths `designhub/` + `plugins/designhub/`, upstream files untouched except one `marketplace.json` entry. The widget variant is generated from untouched upstream `feedback-widget.html` by a fail-loud build transform.

**Tech Stack:** Google Apps Script (V8, clasp v3), Drive v3 + Sheets v4 REST, Node 20 (`node --test`, zero deps), marked 15 + mermaid 11 (Drive-hosted assets), dev-browser for E2E.

---

## Required reading (in order)

1. `docs/designhub/design.md` - the spec. Decisions D1-D19 are binding; §5 data contracts are the law.
2. `docs/designhub/pocs/README.md` + each `pocN/README.md` **Results** section - every task below builds on a POC-proven mechanism; the POC code is the reference implementation.
3. Repo `CLAUDE.md` - especially: never hand-edit `plugins/cc-htmlfeedback/` build artifacts, never use em dashes, bump versions on user-facing changes.

## Non-negotiable constraints (from D16 + POC findings)

- **Never edit upstream files** (`feedback-widget.html`, `build.js`, `server.js`, `lib/`, `plugins/cc-htmlfeedback/`, root `package.json`). Sole exception: one added entry in `.claude-plugin/marketplace.json` (Task 12).
- **GAS + node dual-use modules:** every file in `designhub/gas/lib/` is a plain script defining one global, with a guarded CommonJS export tail (`if (typeof module !== 'undefined') module.exports = ...`) so `node --test` can require it while clasp pushes it verbatim.
- **HtmlService gotchas (poc1/poc3, verified):** inline `<script>` bundles above ~40 KB risk silent truncation - anything bigger is served via the `?asset=` ContentService route; bare `#anchor` links must be rewritten to `target="_self"` after `<base target="_top">` injection; the served page is doubly-nested in iframes.
- **Shared Drive REST discipline (poc2):** every Drive call carries `supportsAllDrives=true`, every list also `includeItemsFromAllDrives=true`; Sheets are created in place via Drive `files.create` with the spreadsheet mimeType.
- **Writing style:** regular hyphens only, never em dashes (user rule, applies to code comments and docs).

## Fixed configuration (from P5 / POC deployments)

Org-specific values (`<DH_*>` placeholders throughout this plan) are recorded in
`docs/designhub/plans/environment.local.md` - gitignored, local-only.

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
  gas/                          clasp project (rootDir), created Task 1, deployed Task 8
    appsscript.json
    config.js                   DH_CONFIG: root folder id, asset file ids
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
    e2e/
      serve-and-comment.mjs     dev-browser E2E (Task 13)
plugins/designhub/
  .claude-plugin/plugin.json
  designhub.config.json         rootFolderId + execUrl for the skill
  skills/publish-design/
    SKILL.md
    scripts/gauth.mjs           OAuth: refresh-or-consent, token cache
    scripts/anchors.mjs         D15 re-anchor pure logic                          (Task 9)
    scripts/publish.mjs         the publish flow                                  (Task 10)
docs/designhub/agent-access.md  "the Sheet is the API" how-to                     (Task 11)
.github/workflows/designhub.yml CI: builds --check + all tests                    (Task 12)
.claude-plugin/marketplace.json +1 entry (the sole upstream-file edit, D16)       (Task 12)
```

**Test command for everything:** `node --test designhub/test/` (root `package.json` is upstream - do NOT add scripts to it).

---

### Task 1: Scaffold the GAS project skeleton

**Files:**
- Create: `designhub/gas/appsscript.json`
- Create: `designhub/gas/config.js`
- Create: `designhub/test/.gitkeep`

- [ ] **Step 1: Create `designhub/gas/appsscript.json`** (scopes proven in poc1; `userinfo.email` is what makes `Session.getActiveUser()` return the viewer):

```json
{
  "timeZone": "Asia/Jerusalem",
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/script.scriptapp"
  ],
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "DOMAIN"
  }
}
```

(`script.scriptapp` is new vs poc1: the rollup reconciler installs a time trigger, Task 6.)

- [ ] **Step 2: Create `designhub/gas/config.js`:**

```js
// DesignHub deployment configuration. IDs are not secrets (access is enforced
// by Drive ACLs), so this is committed. POC fixtures live in DesignHub-POC.
var DH_CONFIG = {
  rootFolderId: '<DH_ROOT_FOLDER_ID>',                  // DesignHub (prod root)
  assets: {
    marked: '<DH_MARKED_BUNDLE_ID>',                    // marked 15 min bundle
    mermaid: '<DH_MERMAID_BUNDLE_ID>'                   // mermaid 11 min bundle
  },
  reconcilerEveryHours: 1                                // D19 reconciler cadence
};
if (typeof module !== 'undefined') module.exports = DH_CONFIG;
```

- [ ] **Step 3: Sanity-run the (empty) test suite**

Run: `node --test designhub/test/ 2>&1 | tail -3`
Expected: `pass 0` (no test files yet, exit 0). If node errors on the empty dir, `touch designhub/test/.gitkeep` and re-run.

- [ ] **Step 4: Commit**

```bash
git add designhub/
git commit -m "designhub: scaffold GAS project config (additive paths per D16)"
```

---

### Task 2: `lib/schema.js` - columns, status mapping, row<->object

The single source of truth for the §5 sheet schemas. Both the GAS bridge and the publish skill consume it.

**Files:**
- Create: `designhub/gas/lib/schema.js`
- Test: `designhub/test/schema.test.js`

- [ ] **Step 1: Write the failing test** (`designhub/test/schema.test.js`):

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../gas/lib/schema.js');

test('ticket columns match design.md section 5 exactly', () => {
  assert.deepEqual(S.TICKET_COLS, ['id', 'parentId', 'type', 'status', 'quote',
    'context', 'section', 'note', 'authorEmail', 'authorName', 'source',
    'docVersion', 'result', 'files', 'createdAt', 'updatedAt']);
});

test('index columns match design.md section 4 exactly', () => {
  assert.deepEqual(S.INDEX_COLS, ['id', 'type', 'title', 'repo', 'feature',
    'jira', 'tags', 'owner', 'driveFileId', 'commentSheetId', 'url', 'status',
    'publishedAt', 'updatedAt']);
});

test('rowToTicket and ticketToRow round-trip', () => {
  const t = { id: 'u1', parentId: '', type: 'comment', status: 'open',
    quote: 'q', context: 'c', section: 's', note: 'n',
    authorEmail: 'a@example.com', authorName: '', source: 'web', docVersion: '',
    result: '', files: '', createdAt: 't1', updatedAt: 't2' };
  assert.deepEqual(S.rowToTicket(S.ticketToRow(t)), t);
});

test('rowToTicket tolerates short rows (Sheets trims trailing empties)', () => {
  const t = S.rowToTicket(['u1', '', 'comment', 'open', 'q']);
  assert.equal(t.note, '');
  assert.equal(t.updatedAt, '');
});

test('widgetStatus maps DesignHub lifecycle to widget board states', () => {
  // widget knows: todo | in-progress | error | done (ORDER map in feedback-widget.html)
  assert.equal(S.widgetStatus('open'), 'todo');
  assert.equal(S.widgetStatus('in-progress'), 'in-progress');
  assert.equal(S.widgetStatus('resolved'), 'done');
  assert.equal(S.widgetStatus('declined'), 'error');
  assert.equal(S.widgetStatus('anchor-lost'), 'error');
  assert.equal(S.widgetStatus('bogus'), 'todo');
});

test('VALID_STATUSES gates setStatus input', () => {
  assert.ok(S.VALID_STATUSES.includes('open'));
  assert.ok(S.VALID_STATUSES.includes('anchor-lost'));
  assert.ok(!S.VALID_STATUSES.includes('done'));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test designhub/test/schema.test.js`
Expected: FAIL, `Cannot find module '../gas/lib/schema.js'`

- [ ] **Step 3: Implement `designhub/gas/lib/schema.js`:**

```js
// DesignHub sheet schemas (design.md section 4 + 5) and the mapping between
// DesignHub ticket lifecycle (D12) and the upstream widget's board states.
// Plain GAS script + guarded CommonJS export (dual-use: clasp and node --test).
var DH_SCHEMA = (function () {
  var TICKET_COLS = ['id', 'parentId', 'type', 'status', 'quote', 'context',
    'section', 'note', 'authorEmail', 'authorName', 'source', 'docVersion',
    'result', 'files', 'createdAt', 'updatedAt'];
  var INDEX_COLS = ['id', 'type', 'title', 'repo', 'feature', 'jira', 'tags',
    'owner', 'driveFileId', 'commentSheetId', 'url', 'status', 'publishedAt',
    'updatedAt'];
  var META_COLS = ['repo', 'pathInRepo', 'branch', 'commitSha', 'pr', 'jira',
    'publisher', 'publishedAt', 'note'];
  var VALID_STATUSES = ['open', 'in-progress', 'resolved', 'declined', 'anchor-lost'];
  var WIDGET_STATUS = { open: 'todo', 'in-progress': 'in-progress',
    resolved: 'done', declined: 'error', 'anchor-lost': 'error' };

  function rowToObj(cols, row) {
    var o = {};
    for (var i = 0; i < cols.length; i++) o[cols[i]] = row[i] === undefined ? '' : row[i];
    return o;
  }
  function objToRow(cols, o) {
    return cols.map(function (c) { return o[c] === undefined ? '' : o[c]; });
  }
  return {
    TICKET_COLS: TICKET_COLS, INDEX_COLS: INDEX_COLS, META_COLS: META_COLS,
    VALID_STATUSES: VALID_STATUSES,
    rowToTicket: function (row) { return rowToObj(TICKET_COLS, row); },
    ticketToRow: function (t) { return objToRow(TICKET_COLS, t); },
    rowToIndex: function (row) { return rowToObj(INDEX_COLS, row); },
    indexToRow: function (o) { return objToRow(INDEX_COLS, o); },
    widgetStatus: function (s) { return WIDGET_STATUS[s] || 'todo'; }
  };
})();
if (typeof module !== 'undefined') module.exports = DH_SCHEMA;
```

- [ ] **Step 4: Run tests, expect PASS:** `node --test designhub/test/schema.test.js`

- [ ] **Step 5: Commit:** `git add designhub/ && git commit -m "designhub: sheet schemas + widget status mapping (TDD)"`

---

### Task 3: `lib/paths.js` - D14 sanitization and doc-path handling

**Files:**
- Create: `designhub/gas/lib/paths.js`
- Test: `designhub/test/paths.test.js`

- [ ] **Step 1: Write the failing test** (`designhub/test/paths.test.js`):

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../gas/lib/paths.js');

test('featureDir encodes path separators (D14)', () => {
  assert.equal(P.featureDir('feature/new-ui'), 'feature--new-ui');
  assert.equal(P.featureDir('design/designhub-platform'), 'design--designhub-platform');
  assert.equal(P.featureDir('plain'), 'plain');
});

test('featureDir strips characters Drive folder names cannot hold', () => {
  assert.equal(P.featureDir('a\\b:c'), 'a--b-c');
});

test('docPath builds repo/featureDir/subpath', () => {
  assert.equal(P.docPath('cc-htmlfeedback', 'design/designhub-platform', 'docs/designhub/design.html'),
    'cc-htmlfeedback/design--designhub-platform/docs/designhub/design.html');
});

test('parseDocPath splits and rejects traversal', () => {
  const p = P.parseDocPath('repo/feat--x/docs/a.html');
  assert.deepEqual(p, { repo: 'repo', featureDir: 'feat--x',
    segments: ['docs', 'a.html'], fileName: 'a.html' });
  assert.throws(() => P.parseDocPath('repo/feat/../../etc'), /invalid/);
  assert.throws(() => P.parseDocPath('repo'), /invalid/);
  assert.throws(() => P.parseDocPath(''), /invalid/);
});

test('companionName is the FULL file name + .comments (design section 5)', () => {
  assert.equal(P.companionName('design.html'), 'design.html.comments');
  assert.equal(P.companionName('design.md'), 'design.md.comments');
});
```

- [ ] **Step 2: Run to verify FAIL:** `node --test designhub/test/paths.test.js` - module not found.

- [ ] **Step 3: Implement `designhub/gas/lib/paths.js`:**

```js
// D14 naming rules: feature folder is ONE sanitized path component; the doc
// keeps its repo-relative subpath under it. Paths are the public addressing
// scheme of the web app (?doc=<repo>/<featureDir>/<subpath...>).
var DH_PATHS = (function () {
  function featureDir(feature) {
    return String(feature).replace(/[\/\\]/g, '--').replace(/[:*?"<>|]/g, '-');
  }
  function docPath(repo, feature, pathInRepo) {
    return [repo, featureDir(feature)].concat(String(pathInRepo).split('/')).join('/');
  }
  function parseDocPath(path) {
    var segs = String(path || '').split('/').filter(function (s) { return s.length; });
    if (segs.length < 3) throw new Error('invalid doc path: ' + path);
    for (var i = 0; i < segs.length; i++) {
      if (segs[i] === '.' || segs[i] === '..') throw new Error('invalid doc path: ' + path);
    }
    return { repo: segs[0], featureDir: segs[1], segments: segs.slice(2),
      fileName: segs[segs.length - 1] };
  }
  function companionName(fileName) { return fileName + '.comments'; }
  return { featureDir: featureDir, docPath: docPath, parseDocPath: parseDocPath,
    companionName: companionName };
})();
if (typeof module !== 'undefined') module.exports = DH_PATHS;
```

- [ ] **Step 4: Run tests, expect PASS:** `node --test designhub/test/paths.test.js`

- [ ] **Step 5: Commit:** `git add designhub/ && git commit -m "designhub: D14 path sanitization + doc-path parsing (TDD)"`

---

### Task 4: `lib/rollup.js` - port the poc5 reconciler logic

poc5's `rollup-lib.mjs` is proven (8/8 tests + live convergence). Port it to the dual-use module convention; port its tests verbatim.

**Files:**
- Create: `designhub/gas/lib/rollup.js` (from `docs/designhub/pocs/poc5/rollup-lib.mjs`)
- Test: `designhub/test/rollup.test.js` (from `docs/designhub/pocs/poc5/rollup-lib.test.mjs`)

- [ ] **Step 1: Create the test** - copy `docs/designhub/pocs/poc5/rollup-lib.test.mjs` to `designhub/test/rollup.test.js`, converting ESM to CJS and importing columns from schema:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { upsertRow, buildRollup } = require('../gas/lib/rollup.js');
const { INDEX_COLS } = require('../gas/lib/schema.js');
```

Then keep every test case from the poc file unchanged (the `row(...)` helper and all 8 tests - copy them verbatim, they only use `INDEX_COLS`, `upsertRow`, `buildRollup`).

- [ ] **Step 2: Run to verify FAIL:** `node --test designhub/test/rollup.test.js`

- [ ] **Step 3: Implement `designhub/gas/lib/rollup.js`** - the poc5 functions wrapped in the dual-use convention, with columns taken from `DH_SCHEMA` (GAS: global; node: require):

```js
// D19 rollup logic: publish-time direct upsert + reconciler rebuild-from-shards.
// Pure functions - the live Sheets I/O lives in drive.js (GAS) / publish.mjs (skill).
var DH_ROLLUP = (function () {
  var COLS = (typeof DH_SCHEMA !== 'undefined') ? DH_SCHEMA.INDEX_COLS
    : require('./schema.js').INDEX_COLS;
  var KEY = COLS.indexOf('driveFileId');
  var UPDATED = COLS.indexOf('updatedAt');
  var REPO = COLS.indexOf('repo');
  var FEATURE = COLS.indexOf('feature');
  var TITLE = COLS.indexOf('title');

  function upsertRow(rows, row) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][KEY] === row[KEY]) {
        var next = rows.slice(); next[i] = row;
        return { action: 'updated', rows: next };
      }
    }
    return { action: 'appended', rows: rows.concat([row]) };
  }

  function buildRollup(shards) {
    var byKey = {};
    shards.forEach(function (rows) {
      rows.forEach(function (r) {
        var k = r[KEY];
        if (!k) return;
        var prev = byKey[k];
        if (!prev || String(r[UPDATED] || '') > String(prev[UPDATED] || '')) byKey[k] = r;
      });
    });
    return Object.keys(byKey).map(function (k) { return byKey[k]; }).sort(function (a, b) {
      return String(a[REPO]).localeCompare(String(b[REPO])) ||
        String(a[FEATURE]).localeCompare(String(b[FEATURE])) ||
        String(a[TITLE]).localeCompare(String(b[TITLE]));
    });
  }
  return { upsertRow: upsertRow, buildRollup: buildRollup };
})();
if (typeof module !== 'undefined') module.exports = DH_ROLLUP;
```

- [ ] **Step 4: Run, expect 8 PASS:** `node --test designhub/test/rollup.test.js`

- [ ] **Step 5: Commit:** `git add designhub/ && git commit -m "designhub: port poc5 rollup logic to dual-use module (D19)"`

---

### Task 5: `lib/render.js` - serving-side HTML builders (pure)

The poc1/poc3-proven injection logic as pure functions: base+anchor handling, widget tag injection, the MD shell, and the tree page.

**Files:**
- Create: `designhub/gas/lib/render.js`
- Test: `designhub/test/render.test.js`

- [ ] **Step 1: Write the failing test** (`designhub/test/render.test.js`):

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../gas/lib/render.js');

const EXEC = 'https://script.google.com/macros/s/XXX/exec';

test('injectBase adds base target=_top inside head', () => {
  const out = R.injectBase('<html><head><title>t</title></head><body>x</body></html>');
  assert.match(out, /<head><base target="_top">/);
});

test('injectBase rewrites bare #anchor links to target=_self (poc1 finding)', () => {
  const out = R.injectBase('<head></head><a href="#sec">jump</a><a href="https://x">out</a>');
  assert.match(out, /<a target="_self" href="#sec">/);
  assert.doesNotMatch(out, /target="_self" href="https/);
});

test('injectBase prepends base when there is no head', () => {
  assert.match(R.injectBase('<p>x</p>'), /^<base target="_top">/);
});

test('serveHtml injects __CCFB config + widget asset tag before </body>', () => {
  const out = R.serveHtml('<html><head></head><body><p>doc</p></body></html>',
    'repo/feat/docs/a.html', EXEC);
  assert.match(out, /window\.__CCFB=\{.*"docPath":"repo\/feat\/docs\/a\.html".*\}/);
  assert.match(out, new RegExp(EXEC.replace(/[/.]/g, '\\$&') + '\\?asset=widget'));
  assert.ok(out.indexOf('?asset=widget') < out.indexOf('</body>'));
  assert.match(out, /"mode":"proxy"/);   // disables the widget's morph path
});

test('mdShell embeds MD as JSON, inlines marked, loads mermaid as asset', () => {
  const out = R.mdShell('# Hi\n```mermaid\ngraph TD;A-->B;\n```', 'var marked={parse:function(){}};',
    EXEC + '?asset=mermaid', 'design.md');
  assert.match(out, /var MD_SOURCE="# Hi/);
  assert.match(out, /var marked=/);
  assert.match(out, /\?asset=mermaid/);
  assert.match(out, /<base target="_top">/);
});

test('mdShell defuses </script> inside the markdown payload', () => {
  const out = R.mdShell('bad </script> here', 'x', 'y', 't');
  assert.doesNotMatch(out, /bad <\/script> here/);
  assert.match(out, /<\\\/script/);
});

test('treeHtml groups rows repo -> feature and links via the url column', () => {
  const rows = [
    { repo: 'r1', feature: 'f1', title: 'Doc A', url: EXEC + '?doc=r1/f1/a.html', status: 'active' },
    { repo: 'r1', feature: 'f2', title: 'Doc B', url: EXEC + '?doc=r1/f2/b.html', status: 'active' },
    { repo: 'r1', feature: 'f1', title: 'gone', url: '#', status: 'archived' },
  ];
  const out = R.treeHtml(rows, EXEC);
  assert.match(out, /r1/);
  assert.match(out, />Doc A</);
  assert.doesNotMatch(out, />gone</);          // archived rows hidden
  assert.match(out, /<h3>f1<\/h3>[\s\S]*Doc A/);
});

test('treeHtml escapes titles', () => {
  const out = R.treeHtml([{ repo: 'r', feature: 'f', title: '<img src=x>', url: '#', status: 'active' }], EXEC);
  assert.doesNotMatch(out, /<img src=x>/);
  assert.match(out, /&lt;img/);
});

test('treeHtml renders an empty state', () => {
  assert.match(R.treeHtml([], EXEC), /No docs published yet/);
});
```

- [ ] **Step 2: Run to verify FAIL:** `node --test designhub/test/render.test.js`

- [ ] **Step 3: Implement `designhub/gas/lib/render.js`:**

```js
// Pure HTML builders for the serving layer. Everything here is verified POC
// behavior: base+anchor handling (poc1), the MD shell (poc3), widget injection
// (same pattern as upstream lib/inject.js, adapted for GAS transport).
var DH_RENDER = (function () {
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // <base target="_top"> is required or in-doc navigation silently fails in the
  // HtmlService iframe - but bare #anchors must NOT inherit it (they would
  // navigate the top window into the raw googleusercontent sandbox URL, losing
  // the page). Both verified in poc1.
  function injectBase(html) {
    var base = '<base target="_top">';
    html = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, function (m) { return m + base; })
      : base + html;
    return html.replace(/<a\s([^>]*href="#)/gi, '<a target="_self" $1');
  }
  function widgetTags(docPath, execUrl) {
    var cfg = { endpoint: '', sessionId: 'designhub', mode: 'proxy',
      ns: 'dh:' + docPath, docPath: docPath };
    // mode:'proxy' makes the upstream widget's scheduleApply() a no-op (no DOM
    // morphing - re-fetching the exec URL from inside the sandbox is meaningless).
    return '<scr' + 'ipt>window.__CCFB=' + JSON.stringify(cfg) + ';</scr' + 'ipt>' +
      '<scr' + 'ipt src="' + esc(execUrl) + '?asset=widget"></scr' + 'ipt>' +
      // identity chip: shows the Google identity the bridge will stamp (D13/D17)
      '<scr' + 'ipt>(function(){var n=0,t=setInterval(function(){' +
      'var h=document.querySelector("#fb-panel .fb-head");' +
      'if((!h||!window.google)&&++n<40)return;clearInterval(t);if(!h||!window.google)return;' +
      'google.script.run.withSuccessHandler(function(r){var d=document.createElement("div");' +
      'd.style.cssText="font:11px monospace;color:#5b6072;padding:2px 0";' +
      'd.textContent="signed in as "+(r.server||"unknown");h.appendChild(d);}).getIdentity();' +
      '},500);})();</scr' + 'ipt>';
  }
  function serveHtml(html, docPath, execUrl) {
    html = injectBase(html);
    var tags = widgetTags(docPath, execUrl);
    return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tags + '</body>') : html + tags;
  }
  // MD shell (poc3): marked inline (39 KB, proven safe), mermaid via asset URL
  // (3.5 MB - inlining it gets truncated by HtmlService). Progressive: text
  // renders in ~50 ms, diagrams pop in when the mermaid asset lands.
  function mdShell(md, markedJs, mermaidSrc, title) {
    var mdJson = JSON.stringify(md).replace(/<\/script/gi, '<\\/script');
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_top">' +
      '<title>' + esc(title) + '</title>' +
      '<style>body{max-width:920px;margin:2rem auto;padding:0 1rem 4rem;' +
      'font:16px/1.6 -apple-system,Segoe UI,sans-serif;color:#1a1a1a}' +
      'table{border-collapse:collapse;font-size:14px}td,th{border:1px solid #ccc;' +
      'padding:4px 8px;vertical-align:top;text-align:left}' +
      'pre{background:#f6f6f6;padding:10px;overflow:auto}code{background:#f2f2f2;padding:1px 4px}' +
      'pre.mermaid{background:none;text-align:center}</style></head><body>' +
      '<div id="md-root">rendering markdown…</div>' +
      '<scr' + 'ipt>' + markedJs + '</scr' + 'ipt>' +
      '<scr' + 'ipt>var MD_SOURCE=' + mdJson + ';\n' +
      'var root=document.getElementById("md-root");\n' +
      'root.innerHTML=marked.parse(MD_SOURCE);\n' +
      'document.querySelectorAll("pre code.language-mermaid").forEach(function(c){\n' +
      '  var d=document.createElement("pre");d.className="mermaid";d.textContent=c.textContent;\n' +
      '  c.parentElement.replaceWith(d);});\n' +
      'if(document.querySelector("pre.mermaid")){\n' +
      '  var m=document.createElement("script");m.src=' + JSON.stringify(mermaidSrc) + ';\n' +
      '  m.onload=function(){mermaid.initialize({startOnLoad:false,securityLevel:"strict"});mermaid.run();};\n' +
      '  document.body.appendChild(m);\n' +
      '}\n' +
      '</scr' + 'ipt></body></html>';
  }
  function treeHtml(rows, execUrl) {
    var active = rows.filter(function (r) { return r.status === 'active'; });
    var body;
    if (!active.length) {
      body = '<p>No docs published yet. Publish one with <code>/publish-design</code>.</p>';
    } else {
      var byRepo = {};
      active.forEach(function (r) {
        byRepo[r.repo] = byRepo[r.repo] || {};
        (byRepo[r.repo][r.feature] = byRepo[r.repo][r.feature] || []).push(r);
      });
      body = Object.keys(byRepo).sort().map(function (repo) {
        return '<h2>' + esc(repo) + '</h2>' + Object.keys(byRepo[repo]).sort().map(function (feat) {
          return '<h3>' + esc(feat) + '</h3><ul>' + byRepo[repo][feat].map(function (r) {
            return '<li><a href="' + esc(r.url) + '">' + esc(r.title) + '</a>' +
              (r.updatedAt ? ' <small>' + esc(String(r.updatedAt).slice(0, 10)) + '</small>' : '') + '</li>';
          }).join('') + '</ul>';
        }).join('');
      }).join('');
    }
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_top">' +
      '<title>DesignHub</title><style>body{max-width:760px;margin:3rem auto;' +
      'font:16px/1.6 -apple-system,Segoe UI,sans-serif;color:#1a1a1a}' +
      'h2{border-bottom:1px solid #ddd;padding-bottom:4px}small{color:#888}</style>' +
      '</head><body><h1>DesignHub</h1>' + body + '</body></html>';
  }
  return { esc: esc, injectBase: injectBase, widgetTags: widgetTags,
    serveHtml: serveHtml, mdShell: mdShell, treeHtml: treeHtml };
})();
if (typeof module !== 'undefined') module.exports = DH_RENDER;
```

- [ ] **Step 4: Run tests, expect PASS:** `node --test designhub/test/render.test.js`

- [ ] **Step 5: Commit:** `git add designhub/ && git commit -m "designhub: pure serving-side HTML builders (poc1/poc3 mechanics, TDD)"`

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
function dhReconcile() {
  var root = DriveApp.getFolderById(DH_CONFIG.rootFolderId);
  var shards = [];
  var queue = [root];
  while (queue.length) {
    var folder = queue.shift();
    var subs = folder.getFolders();
    while (subs.hasNext()) queue.push(subs.next());
    var files = folder.getFilesByName('_index');
    while (files.hasNext()) {
      var ss = SpreadsheetApp.openById(files.next().getId()).getSheetByName('index');
      if (ss) shards.push(ss.getDataRange().getValues().slice(1));
    }
  }
  var rows = DH_ROLLUP.buildRollup(shards);
  var it = root.getFilesByName('_portal-index');
  if (!it.hasNext()) throw new Error('DesignHub: _portal-index missing - first publish creates it');
  var sheet = SpreadsheetApp.openById(it.next().getId()).getSheets()[0];
  sheet.getRange('A2:N10000').clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, DH_SCHEMA.INDEX_COLS.length).setValues(rows);
  return rows.length;
}

// One-time (idempotent) trigger install - run manually from the editor after
// first deploy, or re-run any time; it replaces any existing dhReconcile trigger.
function dhInstallReconcilerTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dhReconcile') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dhReconcile').timeBased()
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

function dhExecUrl_() { return ScriptApp.getService().getUrl(); }

function dhAsset_(name) {
  if (name === 'widget') {
    return ContentService.createTextOutput(HtmlService.createHtmlOutputFromFile('widget').getContent())
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
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
    return HtmlService.createHtmlOutput(DH_RENDER.treeHtml(dhPortalRows_(), dhExecUrl_()))
      .setTitle('DesignHub').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  var r = dhResolveDoc_(p.doc);
  var out;
  if (/\.md$/i.test(r.parsed.fileName)) {
    var md = r.file.getBlob().getDataAsString('UTF-8');
    var markedJs = DriveApp.getFileById(DH_CONFIG.assets.marked).getBlob().getDataAsString('UTF-8');
    var shell = DH_RENDER.mdShell(md, markedJs, dhExecUrl_() + '?asset=mermaid', r.parsed.fileName);
    out = shell.replace('</body></html>', DH_RENDER.widgetTags(p.doc, dhExecUrl_()) + '</body></html>');
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

Generates `designhub/gas/widget.html` (raw widget JS, served via `?asset=widget`) from untouched upstream `feedback-widget.html`. Mirrors upstream `build.js` extraction, then swaps the transport layer. Every replacement asserts its anchor string occurs EXACTLY ONCE so upstream drift fails the build instead of silently shipping a broken widget.

The complete upstream transport surface (verified by reading `feedback-widget.html` at the revision this plan was written; line refs for orientation only - match on strings, not lines):
- `ccfbPost()` - POST `/__ccfb/tickets` (submit)
- `loadTickets()` - GET `/__ccfb/tickets?page=` (board pull)
- `subscribeSSE()` - EventSource `/__ccfb/events` (live updates - dropped in v1 per design section 6, replaced by 30 s polling)
- the Clean handler's POST `/__ccfb/clean` (dropped: on DesignHub the Sheet is authoritative; Clean stays local-view-only, which also sidesteps upstream's known clean-deletes-unseen-tickets issue)
- 9 uses of `location.href` for page keying (2 on the `FILE` line) - on DesignHub the page key is the doc path, injected as `window.__CCFB.docPath`
- `window.__CCFB.mode === 'proxy'` already disables the morph path - we inject `mode:'proxy'`.

**Files:**
- Create: `designhub/build-designhub.js`
- Create: `designhub/gas/widget.html` (generated - never hand-edit)
- Test: `designhub/test/transform.test.js`

- [ ] **Step 1: Write the failing test** (`designhub/test/transform.test.js`) - runs the transform against the REAL upstream source so upstream drift is caught in CI:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transform } = require('../build-designhub.js');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'feedback-widget.html'), 'utf8');

test('transform produces a self-injecting widget with GAS transport', () => {
  const out = transform(src);
  assert.match(out, /google\.script\.run/);
  assert.match(out, /dhRun\('submitComment'/);
  assert.match(out, /dhRun\('listComments'/);
  assert.doesNotMatch(out, /\/__ccfb\//);        // no server endpoints remain
  assert.doesNotMatch(out, /EventSource/);        // SSE fully removed (v1)
  assert.doesNotMatch(out, /location\.href/);     // all page keying goes through dhPage()
  assert.match(out, /function dhPage\(\)/);
  assert.match(out, /setInterval\(loadTickets, 30000\)/);
  assert.match(out, /__fbWidgetLoaded/);          // self-injection guard kept
  assert.ok(out.length > 30000, 'suspiciously small output: ' + out.length);
});

test('transform fails loudly when an anchor string is missing (upstream drift)', () => {
  assert.throws(() => transform(src.replace('function ccfbPost', 'function ccfbPostX')),
    /ccfbPost/);
});
```

- [ ] **Step 2: Run to verify FAIL:** `node --test designhub/test/transform.test.js`

- [ ] **Step 3: Implement `designhub/build-designhub.js`:**

```js
#!/usr/bin/env node
/* Build the DesignHub widget variant from UNTOUCHED upstream feedback-widget.html.
 *   node designhub/build-designhub.js          - write designhub/gas/widget.html
 *   node designhub/build-designhub.js --check  - verify output matches source; exit 1 on drift
 * Transport swap: fetch /__ccfb/* + SSE -> google.script.run bridge (design D16, section 6).
 * FAIL-LOUD CONTRACT: every anchor string below must occur exactly once in the
 * upstream source; if upstream refactors, this build BREAKS instead of shipping
 * a silently wrong widget. Fix by updating the anchors after reviewing the change.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'gas', 'widget.html');

function fail(msg) { console.error('build-designhub.js: ' + msg); process.exit(1); }

function replaceOnce(body, anchor, replacement, label) {
  const i = body.indexOf(anchor);
  if (i === -1) throw new Error('anchor not found (' + label + '): upstream feedback-widget.html changed - review and update build-designhub.js');
  if (body.indexOf(anchor, i + 1) !== -1) throw new Error('anchor not unique (' + label + ')');
  return body.slice(0, i) + replacement + body.slice(i + anchor.length);
}

function transform(src) {
  // -- extraction: same structural contract as upstream build.js --
  const grab = (re, label) => {
    const m = src.match(re);
    if (!m) throw new Error('could not find ' + label);
    return m[1];
  };
  const css = grab(/<style>([\s\S]*?)<\/style>/, '<style> block').trim();
  const markup = grab(/<\/style>([\s\S]*?)<script>/, 'markup').trim().replace(/^<!--[\s\S]*?-->\s*/, '');
  const scriptFull = grab(/<script>([\s\S]*?)<\/script>/, '<script> block').trim();
  const iife = scriptFull.match(/^\(function\(\)\{([\s\S]*)\}\)\(\);?$/);
  if (!iife) throw new Error('source <script> must be a single bare IIFE');
  let body = iife[1];

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

  // -- R5: page keying by doc path. After R4, exactly 8 location.href remain
  //    (FILE x2, restoreDrafts, new-entry page, reconcile, morph fetch [dead in
  //    proxy mode], morph re-anchor, pageParam [now unused]). --
  const count = (body.match(/location\.href/g) || []).length;
  if (count !== 8) throw new Error('expected exactly 8 location.href sites after clean removal, found ' + count + ' - upstream changed, re-audit page keying');
  body = body.replace(/location\.href/g, 'dhPage()');

  // -- prepend the bridge helpers (function declarations hoist above first use) --
  body = "\n  function dhPage(){ return (window.__CCFB && window.__CCFB.docPath) || location.href; }\n" +
    "  function dhRun(fn){ var args = [].slice.call(arguments, 1); return new Promise(function(res, rej){ var r = google.script.run.withSuccessHandler(res).withFailureHandler(rej); r[fn].apply(r, args); }); }\n" + body;

  if (/\/__ccfb\//.test(body)) throw new Error('a /__ccfb/ endpoint survived the transform');

  const esc = s => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return `/*! widget-designhub.js - the cc-htmlfeedback widget with google.script.run transport.
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
}

function main() {
  const src = fs.readFileSync(path.join(root, 'feedback-widget.html'), 'utf8');
  let out;
  try { out = transform(src); } catch (e) { fail(e.message); }
  if (process.argv.includes('--check')) {
    const disk = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (disk !== out) fail('designhub/gas/widget.html is stale - run: node designhub/build-designhub.js');
    console.log('build-designhub: up to date');
    return;
  }
  fs.writeFileSync(OUT, out);
  console.log('wrote ' + OUT + ' (' + out.length + ' bytes)');
}

if (require.main === module) main();
module.exports = { transform };
```

- [ ] **Step 4: Run tests, expect PASS:** `node --test designhub/test/transform.test.js`

- [ ] **Step 5: Generate the artifact and re-check:**

Run: `node designhub/build-designhub.js && node designhub/build-designhub.js --check`
Expected: `wrote .../widget.html (~66000 bytes)` then `build-designhub: up to date`

- [ ] **Step 6: Commit:** `git add designhub/ && git commit -m "designhub: fail-loud widget transform - GAS transport variant (D16)"`

---

### Task 8: Create, deploy, and authorize the production web app

Manual-ish task (browser consent involved) - follow exactly; poc1's Results section is the reference for every quirk you will see.

**Files:**
- Create: `designhub/gas/.clasp.json` (generated by clasp, committed)
- Create: `plugins/designhub/designhub.config.json`

- [ ] **Step 1: Create the Apps Script project without clobbering local files.** `clasp create-script` clones the remote `appsscript.json` over local files, so create in a scratch dir and move the `.clasp.json`:

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$(mktemp -d)" && npx -y @google/clasp create-script --title "DesignHub" --type standalone
mv .clasp.json "$REPO_ROOT/designhub/gas/.clasp.json"
cd "$REPO_ROOT/designhub/gas"
```

Expected: "Created new script: https://script.google.com/d/<SCRIPT_ID>/edit". clasp v3 is installed and logged in as the publisher account `<DH_PUBLISHER_ACCOUNT>` (P1); verify with `clasp show-authorized-user` if unsure.

- [ ] **Step 2: Push and deploy:**

```bash
cd designhub/gas && clasp push -f && clasp create-deployment -d "designhub v1"
```

Expected: `Deployed <DEPLOYMENT_ID> @1`. The exec URL is `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`.

- [ ] **Step 3: One-time owner authorization** (poc1 quirk: the consent screen has PER-SCOPE checkboxes; a partial grant serves pages but breaks the ungranted scope):

Open the exec URL in the logged-in dev-browser (named browser `designhub`), click "REVIEW PERMISSIONS", pick `<DH_PUBLISHER_ACCOUNT>`, on the scope screen **tick ALL FOUR scopes** (email, Drive read, Sheets, script triggers), Continue. The click-through sequence (popup handling, Select all pitfall) is documented in docs/designhub/pocs/poc1/README.md, Operational learnings #1; a human doing it in that browser window is equally fine.

- [ ] **Step 4: Install the D19 reconciler trigger:** open `https://script.google.com/d/<SCRIPT_ID>/edit`, select function `dhInstallReconcilerTrigger`, Run once (grants may re-prompt; approve).

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

- [ ] **Step 6: Create `plugins/designhub/designhub.config.json`** with the real values from Step 2:

```json
{
  "rootFolderId": "<DH_ROOT_FOLDER_ID>",
  "execUrl": "https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec",
  "scriptId": "<SCRIPT_ID>",
  "deploymentId": "<DEPLOYMENT_ID>"
}
```

- [ ] **Step 7: Commit:** `git add designhub/gas/.clasp.json plugins/designhub/ && git commit -m "designhub: production web app deployed (execute-as-me, domain access)"`

---

### Task 9: `anchors.mjs` - the D15 re-anchor pass (pure logic)

Runs at publish time inside the skill. D15 verbatim: every non-terminal ticket (`open` AND `in-progress`) is checked against the NEW doc content using the full anchor triple; quote gone -> `anchor-lost` (never `resolved`), EXCEPT a `strike` whose quote is gone auto-closes `resolved`; a bare quote match whose context no longer matches counts as lost.

**Files:**
- Create: `plugins/designhub/skills/publish-design/scripts/anchors.mjs`
- Test: `designhub/test/anchors.test.js`

- [ ] **Step 1: Write the failing test** (`designhub/test/anchors.test.js`; ESM-under-test via dynamic import):

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mod = () => import('../../plugins/designhub/skills/publish-design/scripts/anchors.mjs');

const DOC = '<html><body><h2>Intro</h2><p>The quick brown fox jumps over the lazy dog.</p></body></html>';
const t = (over) => Object.assign({ id: 'x', type: 'comment', status: 'open',
  quote: 'quick brown fox', context: 'The quick brown fox jumps over the lazy dog.',
  section: 'Intro' }, over);

test('unchanged when quote and context still present', async () => {
  const { reanchorPass } = await mod();
  assert.deepEqual(reanchorPass([t()], DOC, true), []);
});

test('quote gone -> anchor-lost (comment), including in-progress tickets', async () => {
  const { reanchorPass } = await mod();
  for (const status of ['open', 'in-progress']) {
    const out = reanchorPass([t({ status, quote: 'vanished text' })], DOC, true);
    assert.equal(out[0].status, 'anchor-lost');
  }
});

test('strike whose quote is gone auto-resolves (the fix WAS the deletion)', async () => {
  const { reanchorPass } = await mod();
  const out = reanchorPass([t({ type: 'strike', quote: 'vanished text' })], DOC, true);
  assert.equal(out[0].status, 'resolved');
  assert.match(out[0].result, /auto-verified/);
});

test('quote present but context gone -> anchor-lost (different occurrence, D15)', async () => {
  const { reanchorPass } = await mod();
  const out = reanchorPass([t({ context: 'A totally different sentence that held the quote before.' })], DOC, true);
  assert.equal(out[0].status, 'anchor-lost');
});

test('terminal tickets and replies are never touched', async () => {
  const { reanchorPass } = await mod();
  const out = reanchorPass([
    t({ status: 'resolved', quote: 'vanished' }),
    t({ status: 'declined', quote: 'vanished' }),
    t({ status: 'anchor-lost', quote: 'vanished' }),
    t({ type: 'reply', quote: '' }),
  ], DOC, true);
  assert.deepEqual(out, []);
});

test('html tags do not break matching (matching runs on text content)', async () => {
  const { reanchorPass } = await mod();
  const doc = '<p>The <b>quick</b> brown fox jumps over the lazy dog.</p>';
  assert.deepEqual(reanchorPass([t()], doc, true), []);
});

test('context ellipsis from the widget clip is tolerated', async () => {
  const { reanchorPass } = await mod();
  assert.deepEqual(reanchorPass([t({ context: 'The quick brown fox jumps…' })], DOC, true), []);
});
```

- [ ] **Step 2: Run to verify FAIL:** `node --test designhub/test/anchors.test.js`

- [ ] **Step 3: Implement `plugins/designhub/skills/publish-design/scripts/anchors.mjs`:**

```js
// D15 re-anchor pass, pure. Matching runs on normalized TEXT (tags stripped
// for html, whitespace collapsed) because the widget's quote/context come from
// rendered text, not source bytes.
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const textify = (source, isHtml) => norm(isHtml
  ? String(source).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ')
  : String(source));

// The widget clips context to 160 chars with a trailing ellipsis - strip it
// and require a reasonable core before using context as a disambiguator.
const contextCore = (context) => norm(String(context || '').replace(/…\s*$/, ''));

export function reanchorPass(tickets, docSource, isHtml) {
  const text = textify(docSource, isHtml);
  const changes = [];
  for (const t of tickets) {
    if (t.type === 'reply') continue;
    if (t.status !== 'open' && t.status !== 'in-progress') continue;
    const quote = norm(t.quote);
    if (!quote) continue;
    const quoteFound = text.includes(quote);
    if (!quoteFound) {
      changes.push(t.type === 'strike'
        ? { id: t.id, status: 'resolved', result: 'auto-verified on re-publish: struck text is gone (D15)' }
        : { id: t.id, status: 'anchor-lost', result: 'quote not found after re-publish (D15)' });
      continue;
    }
    const ctx = contextCore(t.context);
    if (ctx.length >= 12 && !text.includes(ctx)) {
      changes.push({ id: t.id, status: 'anchor-lost',
        result: 'quote exists but its context moved - treated as lost (D15 full-triple rule)' });
    }
  }
  return changes;
}
```

- [ ] **Step 4: Run tests, expect PASS:** `node --test designhub/test/anchors.test.js`

- [ ] **Step 5: Commit:** `git add designhub/ plugins/designhub/ && git commit -m "designhub: D15 re-anchor pass, full-triple matching (TDD)"`

---

### Task 10: The publish flow - `gauth.mjs`, `publish-lib.mjs`, `publish.mjs`

The Google call sequence is poc2's proven `publish-dry-run.mjs`, upgraded with: D9 metadata inference helpers, the two-severity asset scan (poc2 learning #1), the D15 pass (Task 9), and the D19 rollup upsert (poc5). Pure helpers live in `publish-lib.mjs` (tested); `publish.mjs` is the CLI; `gauth.mjs` owns tokens. (Addendum to the file map: `scripts/publish-lib.mjs`.)

**Files:**
- Create: `plugins/designhub/skills/publish-design/scripts/gauth.mjs`
- Create: `plugins/designhub/skills/publish-design/scripts/publish-lib.mjs`
- Create: `plugins/designhub/skills/publish-design/scripts/publish.mjs`
- Test: `designhub/test/publish.test.js`

- [ ] **Step 1: Write the failing test** (`designhub/test/publish.test.js`):

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mod = () => import('../../plugins/designhub/skills/publish-design/scripts/publish-lib.mjs');

test('scanAssets: asset loads vs navigation links (two severities)', async () => {
  const { scanAssets } = await mod();
  const html = '<img src="./pic.png"><script src="lib/x.js"></script>' +
    '<link rel="stylesheet" href="style.css">' +
    '<a href="./other.md">sibling</a><a href="#sec">in-page</a>' +
    '<a href="https://x.com">out</a><img src="data:image/png;base64,x">';
  const r = scanAssets(html);
  assert.deepEqual(r.assets.sort(), ['./pic.png', 'lib/x.js', 'style.css']);
  assert.deepEqual(r.links, ['./other.md']);   // #, data:, absolute all ignored
});

test('inferMetadata: repo from remote, feature from branch, jira from branch', async () => {
  const { inferMetadata } = await mod();
  const m = inferMetadata({
    remoteUrl: 'git@github.com:example-org/cc-htmlfeedback.git',
    branch: 'design/PROJ-123-designhub' });
  assert.equal(m.repo, 'cc-htmlfeedback');
  assert.equal(m.feature, 'design/PROJ-123-designhub');
  assert.equal(m.jira, 'PROJ-123');
});

test('inferMetadata: unknowns become the explicit "unassigned" placeholder (D9)', async () => {
  const { inferMetadata } = await mod();
  const m = inferMetadata({ remoteUrl: '', branch: 'main' });
  assert.equal(m.repo, 'unassigned');
  assert.equal(m.jira, 'unassigned');
});

test('newIndexRow shapes a section-4 row with stable uuid and active status', async () => {
  const { newIndexRow } = await mod();
  const row = newIndexRow({ type: 'html', title: 'T', repo: 'r', feature: 'f',
    jira: 'unassigned', owner: 'me@example.com', driveFileId: 'F', commentSheetId: 'C',
    url: 'U', now: '2026-07-05T00:00:00Z' });
  assert.equal(row.length, 14);
  assert.match(row[0], /^[0-9a-f-]{36}$/);
  assert.equal(row[8], 'F');
  assert.equal(row[11], 'active');
});
```

- [ ] **Step 2: Run to verify FAIL:** `node --test designhub/test/publish.test.js`

- [ ] **Step 3: Implement `publish-lib.mjs`:**

```js
// Pure helpers for /publish-design. No I/O here - testable under node --test.
import crypto from 'node:crypto';

const REL = (u) => !/^(https?:|#|data:|mailto:|\/\/)/i.test(u);

// poc2 learning: broken ASSET loads break rendering (hard confirm), broken
// NAV links merely 404 on click (soft warn). Classify by tag.
export function scanAssets(html) {
  const assets = [], links = [];
  const re = /<(a|img|script|link|source|iframe|video|audio)\b[^>]*?(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const [, tag, url] = m;
    if (!REL(url)) continue;
    (tag.toLowerCase() === 'a' ? links : assets).push(url);
  }
  return { assets: [...new Set(assets)], links: [...new Set(links)] };
}

export function inferMetadata({ remoteUrl, branch }) {
  const repo = (String(remoteUrl).match(/\/([^/]+?)(\.git)?$/) || [])[1] || 'unassigned';
  const feature = String(branch || '').trim() || 'unassigned';
  const jira = (String(branch).match(/[A-Z][A-Z0-9]+-\d+/) || [])[0] || 'unassigned';
  return { repo, feature, jira };
}

export function newIndexRow({ type, title, repo, feature, jira, owner,
  driveFileId, commentSheetId, url, now }) {
  return [crypto.randomUUID(), type, title, repo, feature, jira, '', owner,
    driveFileId, commentSheetId, url, 'active', now, now];
}

export const TICKET_COLS = ['id', 'parentId', 'type', 'status', 'quote', 'context',
  'section', 'note', 'authorEmail', 'authorName', 'source', 'docVersion',
  'result', 'files', 'createdAt', 'updatedAt'];
export const INDEX_COLS = ['id', 'type', 'title', 'repo', 'feature', 'jira', 'tags',
  'owner', 'driveFileId', 'commentSheetId', 'url', 'status', 'publishedAt', 'updatedAt'];
export const META_COLS = ['repo', 'pathInRepo', 'branch', 'commitSha', 'pr', 'jira',
  'publisher', 'publishedAt', 'note'];
```

- [ ] **Step 4: Run tests, expect PASS:** `node --test designhub/test/publish.test.js`

- [ ] **Step 5: Implement `gauth.mjs`** (refresh-or-consent; the consent listener is the P3-proven localhost pattern):

```js
// OAuth for the publish skill. Publishers publish as THEMSELVES (D13):
// per-developer token cached at ~/.claude/designhub/token.json.
// Client secret: an installed-app OAuth client JSON; default reuses the
// gdoc-md-sync client on this machine, override with DH_CLIENT_SECRET_FILE.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const TOKEN_FILE = process.env.DH_TOKEN_FILE ||
  path.join(os.homedir(), '.claude', 'designhub', 'token.json');
const CLIENT_FILE = process.env.DH_CLIENT_SECRET_FILE ||
  path.join(os.homedir(), '.claude', 'skills', 'gdoc-md-sync', 'client_secret.json');
const SCOPE = 'https://www.googleapis.com/auth/drive';

function clientCreds() {
  const c = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8'));
  const k = c.installed || c.web;
  return { id: k.client_id, secret: k.client_secret };
}

async function refresh(refreshToken) {
  const { id, secret } = clientCreds();
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret,
      refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  if (!r.ok) throw new Error('token refresh failed: ' + await r.text());
  return (await r.json()).access_token;
}

async function consent() {
  const { id, secret } = clientCreds();
  const port = 8765;
  const redirect = `http://localhost:${port}/`;
  const url = 'https://accounts.google.com/o/oauth2/auth?' + new URLSearchParams({
    response_type: 'code', client_id: id, redirect_uri: redirect,
    scope: SCOPE, access_type: 'offline', prompt: 'consent select_account' });
  console.log('\nAuthorize DesignHub publishing - open this URL and approve:\n\n' + url + '\n');
  try { spawn('open', [url], { stdio: 'ignore' }); } catch { /* print-only fallback */ }
  const code = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const q = new URL(req.url, redirect).searchParams;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Done - return to the terminal.</h2>');
      if (q.get('code')) { srv.close(); resolve(q.get('code')); }
    });
    srv.on('error', reject);
    srv.listen(port);
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, code,
      grant_type: 'authorization_code', redirect_uri: redirect }),
  });
  if (!r.ok) throw new Error('code exchange failed: ' + await r.text());
  const tok = await r.json();
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: tok.refresh_token }, null, 2));
  return tok.access_token;
}

export async function accessToken() {
  if (fs.existsSync(TOKEN_FILE)) {
    return refresh(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).refresh_token);
  }
  // machine-local fallback: reuse the gdoc-md-sync token if present
  const legacy = path.join(os.homedir(), '.claude', 'skills', 'gdoc-md-sync', 'token.json');
  if (fs.existsSync(legacy)) {
    return refresh(JSON.parse(fs.readFileSync(legacy, 'utf8')).refresh_token);
  }
  return consent();
}

export async function api(token, url, opts = {}) {
  const r = await fetch(url, { ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${url} -> ${r.status}: ${await r.text()}`);
  return r.json();
}
```

- [ ] **Step 6: Implement `publish.mjs`** - the full flow. Drive/Sheets mechanics are poc2's, therefore only the flow skeleton and the NEW parts are annotated:

```js
#!/usr/bin/env node
// /publish-design workhorse. Called by the skill AFTER the user confirmed the
// metadata (D9 approval happens in conversation, not here).
//
//   node publish.mjs --file docs/designhub/design.html \
//     --repo cc-htmlfeedback --feature design/designhub-platform \
//     [--jira PROJ-1] [--path-in-repo docs/designhub/design.html] \
//     [--allow-assets] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { accessToken, api } from './gauth.mjs';
import { scanAssets, newIndexRow, TICKET_COLS, INDEX_COLS, META_COLS } from './publish-lib.mjs';
import { reanchorPass } from './anchors.mjs';

const CONFIG = JSON.parse(fs.readFileSync(
  new URL('../../../designhub.config.json', import.meta.url), 'utf8'));
const SAD = 'supportsAllDrives=true';
const LIST = `${SAD}&includeItemsFromAllDrives=true`;
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3';

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? dflt : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true);
};
const FILE = arg('file');
const REPO = arg('repo');
const FEATURE = arg('feature');
const JIRA = String(arg('jira', 'unassigned'));
if (!FILE || !REPO || !FEATURE) {
  console.error('usage: publish.mjs --file <p> --repo <r> --feature <f> [--jira K-1] [--allow-assets] [--dry-run]');
  process.exit(2);
}
const PATH_IN_REPO = String(arg('path-in-repo', FILE)).replace(/^\.\//, '');
const FEATURE_DIR = FEATURE.replace(/[\/\\]/g, '--').replace(/[:*?"<>|]/g, '-'); // D14 (mirror of gas/lib/paths.js)
const FILE_NAME = path.basename(FILE);
const IS_MD = /\.md$/i.test(FILE_NAME);
const DOC_PATH = [REPO, FEATURE_DIR, ...PATH_IN_REPO.split('/')].join('/');
const content = fs.readFileSync(FILE, 'utf8');
const now = new Date().toISOString();

// ---- 1. self-contained scan (v1 contract, two severities - poc2 learning) ----
if (!IS_MD) {
  const { assets, links } = scanAssets(content);
  if (links.length) console.warn('WARN relative nav links (will 404 in DesignHub): ' + links.join(', '));
  if (assets.length) {
    console.error('BLOCK relative ASSET refs (page would render broken): ' + assets.join(', '));
    if (!arg('allow-assets')) { console.error('re-run with --allow-assets to publish anyway'); process.exit(3); }
  }
}
if (arg('dry-run')) { console.log(JSON.stringify({ DOC_PATH, FEATURE_DIR, ok: true })); process.exit(0); }

const at = await accessToken();
const q = async (query) => (await api(at, `${DRIVE}/files?q=${encodeURIComponent(query)}&${LIST}&fields=files(id,name)`)).files;
const child = async (parent, name, mime) => (await q(
  `'${parent}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false` +
  (mime ? ` and mimeType = '${mime}'` : '')))[0] || null;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const mkChild = (parent, name, mime) => api(at, `${DRIVE}/files?${SAD}&fields=id`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, mimeType: mime, parents: [parent] }) });
const ensure = async (parent, name, mime) =>
  (await child(parent, name, mime))?.id || (await mkChild(parent, name, mime)).id;
const getVals = async (id, range) =>
  (await api(at, `${SHEETS}/${id}/values/${encodeURIComponent(range)}`)).values ?? [];
const putVals = (id, range, values) => api(at,
  `${SHEETS}/${id}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
  { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });
const appendVals = (id, range, values) => api(at,
  `${SHEETS}/${id}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });

const me = (await api(at, `${DRIVE}/about?fields=user(emailAddress)`)).user.emailAddress;

// ---- 2. folder chain + D14 collision check BEFORE any write ----
const repoF = await ensure(CONFIG.rootFolderId, REPO, FOLDER_MIME);
const featF = await ensure(repoF, FEATURE_DIR, FOLDER_MIME);
const indexId = await ensure(featF, '_index', SHEET_MIME);
let indexRows = await getVals(indexId, 'index!A2:N').catch(() => null);
if (indexRows === null) {   // brand-new sheet: name the tab + header
  const meta = await api(at, `${SHEETS}/${indexId}?fields=sheets(properties(sheetId))`);
  await api(at, `${SHEETS}/${indexId}:batchUpdate`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ updateSheetProperties: {
      properties: { sheetId: meta.sheets[0].properties.sheetId, title: 'index' }, fields: 'title' } }] }) });
  await putVals(indexId, 'index!1:1', [INDEX_COLS]);
  indexRows = [];
}
const FEAT_COL = INDEX_COLS.indexOf('feature');
const foreign = indexRows.find((r) => r[FEAT_COL] && r[FEAT_COL] !== FEATURE);
if (foreign) {
  console.error(`D14 COLLISION: folder '${FEATURE_DIR}' already belongs to feature '${foreign[FEAT_COL]}' - refusing`);
  process.exit(4);
}

// ---- 3. subpath mirror + upload (update-in-place keeps the link + revisions) ----
let docParent = featF;
const segs = PATH_IN_REPO.split('/');
for (const seg of segs.slice(0, -1)) docParent = await ensure(docParent, seg, FOLDER_MIME);
const mime = IS_MD ? 'text/markdown' : 'text/html';
const boundary = 'dh' + Math.random().toString(36).slice(2);
const mpBody = (meta) => `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n${content}\r\n--${boundary}--`;
const mpHdr = { 'Content-Type': `multipart/related; boundary=${boundary}` };
const existing = await child(docParent, FILE_NAME);
const doc = existing
  ? await api(at, `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&${SAD}&fields=id`, { method: 'PATCH', headers: mpHdr, body: mpBody({}) })
  : await api(at, `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&${SAD}&fields=id`, { method: 'POST', headers: mpHdr, body: mpBody({ name: FILE_NAME, parents: [docParent] }) });

// ---- 4. companion Sheet (full-filename convention) + meta history ----
const companionId = await ensure(docParent, `${FILE_NAME}.comments`, SHEET_MIME);
const head = await getVals(companionId, 'tickets!1:1').catch(() => null);
if (head === null || !head.length) {
  const meta = await api(at, `${SHEETS}/${companionId}?fields=sheets(properties(sheetId,title))`);
  const reqs = [];
  const titles = meta.sheets.map((s) => s.properties.title);
  if (!titles.includes('tickets')) reqs.push({ updateSheetProperties: {
    properties: { sheetId: meta.sheets[0].properties.sheetId, title: 'tickets' }, fields: 'title' } });
  if (!titles.includes('meta')) reqs.push({ addSheet: { properties: { title: 'meta' } } });
  if (reqs.length) await api(at, `${SHEETS}/${companionId}:batchUpdate`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: reqs }) });
  await putVals(companionId, 'tickets!1:1', [TICKET_COLS]);
  await putVals(companionId, 'meta!1:1', [META_COLS]);
}
let sha = ''; try { sha = execSync('git rev-parse --short HEAD').toString().trim(); } catch {}
await appendVals(companionId, 'meta!A:I',
  [[REPO, PATH_IN_REPO, FEATURE, sha, '', JIRA, me, now, 'publish']]);

// ---- 5. D15 re-anchor pass against the NEW content ----
const ticketRows = (await getVals(companionId, 'tickets!A2:P'));
const tickets = ticketRows.map((r) => Object.fromEntries(TICKET_COLS.map((c, i) => [c, r[i] ?? ''])));
const changes = reanchorPass(tickets, content, !IS_MD);
for (const ch of changes) {
  const i = tickets.findIndex((t) => t.id === ch.id);
  ticketRows[i][TICKET_COLS.indexOf('status')] = ch.status;
  ticketRows[i][TICKET_COLS.indexOf('result')] = ch.result;
  ticketRows[i][TICKET_COLS.indexOf('updatedAt')] = now;
  await putVals(companionId, `tickets!A${i + 2}:P${i + 2}`, [ticketRows[i]]);
  console.log(`D15: ticket ${ch.id.slice(0, 8)} -> ${ch.status}`);
}

// ---- 6. feature _index upsert (stable row uuid) + title ----
const title = (IS_MD ? (content.match(/^#\s+(.+)$/m) || [])[1]
  : (content.match(/<title>(.*?)<\/title>/i) || [])[1]) || FILE_NAME;
const url = `${CONFIG.execUrl}?doc=${DOC_PATH}`;
const ID_COL = INDEX_COLS.indexOf('driveFileId');
const rowIdx = indexRows.findIndex((r) => r[ID_COL] === doc.id);
let indexRow;
if (rowIdx === -1) {
  indexRow = newIndexRow({ type: IS_MD ? 'md' : 'html', title: title.trim(), repo: REPO,
    feature: FEATURE, jira: JIRA, owner: me, driveFileId: doc.id,
    commentSheetId: companionId, url, now });
  await appendVals(indexId, 'index!A:N', [indexRow]);
} else {
  indexRow = indexRows[rowIdx];
  indexRow[INDEX_COLS.indexOf('title')] = title.trim();
  indexRow[INDEX_COLS.indexOf('url')] = url;
  indexRow[INDEX_COLS.indexOf('jira')] = JIRA;
  indexRow[INDEX_COLS.indexOf('updatedAt')] = now;
  await putVals(indexId, `index!A${rowIdx + 2}:N${rowIdx + 2}`, [indexRow]);
}

// ---- 7. D19: direct _portal-index upsert (reconciler heals any miss) ----
let portal = await child(CONFIG.rootFolderId, '_portal-index', SHEET_MIME);
if (!portal) {
  portal = await mkChild(CONFIG.rootFolderId, '_portal-index', SHEET_MIME);
  await putVals(portal.id, 'A1:N1', [INDEX_COLS]);
}
const pRows = await getVals(portal.id, 'A2:N');
const pIdx = pRows.findIndex((r) => r[ID_COL] === doc.id);
if (pIdx === -1) await appendVals(portal.id, 'A:N', [indexRow]);
else await putVals(portal.id, `A${pIdx + 2}:N${pIdx + 2}`, [indexRow]);

console.log('\nPublished: ' + url);
console.log('Comments Sheet: https://docs.google.com/spreadsheets/d/' + companionId);
```

- [ ] **Step 7: Full suite green:** `node --test designhub/test/`

- [ ] **Step 8: Integration dry-run against the POC area** (NOT prod): edit `plugins/designhub/designhub.config.json`, set `rootFolderId` to `<DH_POC_FOLDER_ID>` (DesignHub-POC, see `environment.local.md`), run the two commands below, then restore with `git checkout -- plugins/designhub/designhub.config.json`:

```bash
node plugins/designhub/skills/publish-design/scripts/publish.mjs \
  --file docs/designhub/design.html --repo cc-htmlfeedback \
  --feature design/designhub-platform --dry-run
node plugins/designhub/skills/publish-design/scripts/publish.mjs \
  --file docs/designhub/design.html --repo cc-htmlfeedback \
  --feature design/designhub-platform --allow-assets   # design.html has nav links only; assets list must be EMPTY - if BLOCK appears, the scan is misclassifying
```

Expected: run 1 prints the dry-run JSON; run 2 prints WARN for the two nav links, no BLOCK, then `Published: <execUrl>?doc=cc-htmlfeedback/design--designhub-platform/docs/designhub/design.html`. Run the publish twice - the second run must not duplicate the index row (check the printed Sheet). Then restore the config (git checkout above).

- [ ] **Step 9: Commit:** `git add plugins/designhub/ designhub/ && git commit -m "designhub: /publish-design flow - poc2 mechanics + D9/D14/D15/D19 (TDD)"`

---

### Task 11: The `/publish-design` skill + plugin manifest + agent docs

**Files:**
- Create: `plugins/designhub/.claude-plugin/plugin.json`
- Create: `plugins/designhub/skills/publish-design/SKILL.md`
- Create: `docs/designhub/agent-access.md`

- [ ] **Step 1: Create `plugins/designhub/.claude-plugin/plugin.json`:**

```json
{
  "name": "designhub",
  "version": "0.1.0",
  "description": "Publish design docs to DesignHub (Google-login-gated hub with in-page comments) and work with their comment Sheets.",
  "author": { "name": "your-org" }
}
```

- [ ] **Step 2: Create `plugins/designhub/skills/publish-design/SKILL.md`:**

```markdown
---
name: publish-design
description: >
  Publish an HTML or Markdown design doc from this repo to DesignHub - the
  company's Google-login-gated design hub with in-page commenting. Use when the
  user runs /publish-design, asks to "publish this design doc", "share this
  dashboard with PMs", or wants company-wide (non-GitHub) review of a design
  file. Uploads to the DesignHub Shared Drive, creates/updates the catalog row
  and companion comment Sheet, runs the re-anchor pass, and returns the link.
---

# /publish-design

TOOLING = ${CLAUDE_PLUGIN_ROOT}/skills/publish-design/scripts

## Flow (D9: infer, then the USER approves - never publish silently)

1. **Resolve the file.** The doc the user wants published (ask if ambiguous).
   Path-in-repo = its path relative to the repo root.
2. **Infer metadata** and SHOW it for approval before publishing:
   - repo: `git remote get-url origin` -> last path segment without `.git`
   - feature: current branch (`git branch --show-current`)
   - jira: first `ABC-123`-shaped token in the branch name, else `unassigned`
   Present the resolved values in one short block and ask the user to confirm
   or correct. Anything unknown stays the literal string `unassigned`.
3. **Publish:**

   ```bash
   node $TOOLING/publish.mjs --file <path> --repo <repo> --feature <branch> \
     --jira <key-or-unassigned> --path-in-repo <repo-relative-path>
   ```

   - First run on a machine may print an OAuth URL - have the user authorize
     (they publish as THEMSELVES, D13).
   - `BLOCK relative ASSET refs`: the page would render broken (v1 serves a
     single file). Show the list to the user; only re-run with
     `--allow-assets` if they explicitly accept broken assets.
   - `WARN relative nav links`: tell the user those links will 404 on the hub;
     publishing proceeds.
4. **Report:** give the user the printed `Published:` URL (viewable by anyone
   in the domain with a Google login) and the comments Sheet link. If the
   output shows `D15:` lines, summarize which old comments auto-closed
   (strike -> resolved) or went `anchor-lost`.

## Notes

- Re-publishing the same file updates it in place: same link, Drive revision
  history, catalog row updated - never duplicated.
- A feature-folder collision error (exit 4) means the sanitized branch name
  clashes with a different feature (D14) - pick an explicit `--feature`.
- The web app, catalog, and Sheet schemas are documented in
  `docs/designhub/design.md`; agents consume comments per
  `docs/designhub/agent-access.md`.
```

- [ ] **Step 3: Create `docs/designhub/agent-access.md`** - "the Sheet is the API", distilled from poc4's proven recipe:

```markdown
# DesignHub agent access - the Sheet is the API

No custom API (design D5): agents use Drive/Sheets REST with their own Google
identity. Verified end-to-end in `docs/designhub/pocs/poc4/`.

## Access (one-time, D18)

Your identity needs membership on the DesignHub Shared Drive (or its folder):
**Viewer** = read everything; **Contributor** = also write comment rows.
Agents get Contributor - it cannot move or delete anything.

## Reading a doc's review state

1. Catalog: read the `_portal-index` Sheet in the DesignHub root - one row per
   doc: `id, type, title, repo, feature, jira, tags, owner, driveFileId,
   commentSheetId, url, status, publishedAt, updatedAt`.
2. Comments: `GET https://sheets.googleapis.com/v4/spreadsheets/{commentSheetId}/values/tickets!A2:P`
   with columns `id, parentId, type, status, quote, context, section, note,
   authorEmail, authorName, source, docVersion, result, files, createdAt, updatedAt`.
   Top-level tickets have empty `parentId`; replies set it.
3. Doc bytes (exact): `GET https://www.googleapis.com/drive/v3/files/{driveFileId}?alt=media&supportsAllDrives=true`
4. Visual context: render the fetched doc locally (dev-browser) and locate each
   ticket's quote/context/section anchor triple on the rendered page.

## Writing (as yourself - your row carries YOUR authorEmail)

- Reply: append a row to `tickets!A:P` with a fresh uuid, `parentId` = the
  ticket you answer, `type=reply`, `source=agent`, your email, ISO timestamps.
- Status: update the ticket row's `status` cell to one of
  `open | in-progress | resolved | declined` (+ bump `updatedAt`); put your
  reasoning/outcome in `result` and touched files in `files`.
- Use `values:append` for new rows (atomic) and row-addressed
  `values:update` for edits; every Drive call takes `supportsAllDrives=true`.

Reference implementation: `docs/designhub/pocs/poc4/agent-path.py`.
```

- [ ] **Step 4: Commit:** `git add plugins/designhub/ docs/designhub/agent-access.md && git commit -m "designhub: /publish-design skill, plugin manifest, agent access docs"`

---

### Task 12: Marketplace entry (the sole upstream-file edit) + CI

**Files:**
- Modify: `.claude-plugin/marketplace.json` (add ONE entry - D16's single sanctioned upstream touch)
- Create: `.github/workflows/designhub.yml`

- [ ] **Step 1: Add the designhub plugin to `.claude-plugin/marketplace.json`.** Read the file first; append to its `plugins` array, matching the existing entry's shape exactly (same key order and style as the `cc-htmlfeedback` entry):

```json
    {
      "name": "designhub",
      "source": "./plugins/designhub",
      "description": "Publish design docs to DesignHub - Google-login-gated review hub with in-page comments stored in Sheets.",
      "version": "0.1.0"
    }
```

(If the real file's entries carry different/extra keys, mirror those instead - the existing entry is the template. Keep the diff to this one addition.)

- [ ] **Step 2: Create `.github/workflows/designhub.yml`** (D16: fork-side CI on every merge - upstream tests must keep passing next to ours):

```yaml
name: designhub
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - name: upstream build is clean (never edited)
        run: node build.js --check
      - name: upstream tests
        run: npm test
      - name: designhub widget transform is fresh + anchors hold
        run: node designhub/build-designhub.js --check
      - name: designhub tests
        run: node --test designhub/test/
```

- [ ] **Step 3: Verify locally the exact commands CI runs:**

```bash
node build.js --check && npm test && node designhub/build-designhub.js --check && node --test designhub/test/
```

Expected: all four green. (`npm test` and `build.js --check` prove the D16 promise: our additions did not disturb upstream.)

- [ ] **Step 4: Commit:** `git add .claude-plugin/marketplace.json .github/ && git commit -m "designhub: marketplace entry + fork-side CI (D16)"`

---

### Task 13: E2E script + dogfood publish (the real thing, end to end)

**Files:**
- Create: `designhub/test/e2e/serve-and-comment.mjs` (dev-browser script - run manually, not in CI)

- [ ] **Step 1: Create `designhub/test/e2e/serve-and-comment.mjs`.** This is a dev-browser stdin script (poc1/poc3 pattern). IMPORTANT: dev-browser scripts run in a QuickJS sandbox with NO `process`/env access - parameters are baked in by `sed` at run time:

```bash
# Run:
sed -e 's|__DH_EXEC__|https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec|' \
    -e 's|__DH_DOC__|cc-htmlfeedback/design--designhub-platform/docs/designhub/design.html|' \
    designhub/test/e2e/serve-and-comment.mjs | dev-browser --browser designhub --timeout 180
```

```js
// Verifies: page serves, widget boots, identity chip shows an org-domain user,
// a programmatic selection submits through the bridge (fix-now path), and the
// board reflects it.
const EXEC = "__DH_EXEC__", DOC = "__DH_DOC__";
const page = await browser.getPage("dh-e2e");
await page.goto(`${EXEC}?doc=${DOC}`, { waitUntil: "domcontentloaded", timeout: 90000 });
let frame = null;
for (let i = 0; i < 45 && !frame; i++) {
  await page.waitForTimeout(1000);
  for (const f of page.frames()) {
    if (await f.evaluate(() => !!document.getElementById("fb-launch")).catch(() => false)) { frame = f; break; }
  }
}
if (!frame) throw new Error("widget never appeared");
const identity = await frame.evaluate(() =>
  (document.querySelector("#fb-panel .fb-head div:last-child") || {}).textContent || "");
console.log("identity chip:", identity);
const selected = await frame.evaluate(() => {
  const p = [...document.querySelectorAll("p,td,li")].find(el => el.innerText.trim().length > 60);
  const r = document.createRange(); r.selectNodeContents(p);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  return p.innerText.trim().slice(0, 40);
});
console.log("selected:", JSON.stringify(selected));
await page.waitForTimeout(800);
// Meta/Ctrl+click on the popover Comment button is the connected-mode
// "fix now" fast path - it calls submitDraft() and therefore the BRIDGE
// immediately (a plain click only creates a local draft).
await frame.click("#fb-comment", { modifiers: ["Meta"] });
// bridge round-trip is async - give it time, then count board cards
await page.waitForTimeout(6000);
console.log("board cards:", await frame.evaluate(() =>
  document.querySelectorAll("#fb-panel li, #fb-panel .fb-card, #fb-panel .fb-item").length));
console.log("screenshot:", await saveScreenshot(await page.screenshot(), "dh-e2e.png"));
```

(The exact popover/panel selectors come from `feedback-widget.html` markup - if `fb-comment`/`fb-list` drifted, read the markup block of the widget source and fix the selectors; do not guess.)

- [ ] **Step 2: Dogfood - publish the real design docs to the PRODUCTION root:**

```bash
node plugins/designhub/skills/publish-design/scripts/publish.mjs \
  --file docs/designhub/design.html --repo cc-htmlfeedback \
  --feature design/designhub-platform --path-in-repo docs/designhub/design.html --allow-assets
node plugins/designhub/skills/publish-design/scripts/publish.mjs \
  --file docs/designhub/design.md --repo cc-htmlfeedback \
  --feature design/designhub-platform --path-in-repo docs/designhub/design.md
```

Expected: two `Published:` URLs under the production exec URL.

- [ ] **Step 3: Run the E2E against both published docs** (html then md) with `DH_EXEC`/`DH_DOC` set accordingly. Expected: identity chip shows `signed in as <DH_PUBLISHER_ACCOUNT>`, a card appears after submit, screenshot looks right (check it - the human eye is part of this step). Verify the rows landed:  read the companion Sheet's `tickets` tab via REST and confirm the new row's `authorEmail`.

- [ ] **Step 4: Check the tree page** (exec URL with no params) in dev-browser: both docs listed under `cc-htmlfeedback / design/designhub-platform`.

- [ ] **Step 5: Commit:** `git add designhub/test/e2e/ && git commit -m "designhub: E2E serve-and-comment script + dogfood publish verified"`

---

### Task 14: Wrap up - README, design doc status, PR

**Files:**
- Create: `designhub/README.md`
- Modify: `docs/designhub/design.md` (status line only)

- [ ] **Step 1: Create `designhub/README.md`:**

```markdown
# DesignHub (v1)

Publish design docs from this repo to a Google-login-gated hub with in-page
commenting; comments live in per-doc Google Sheets that agents read/write over
REST. Spec: `docs/designhub/design.md` (D1-D19). POC evidence:
`docs/designhub/pocs/`. Agent how-to: `docs/designhub/agent-access.md`.

- `build-designhub.js` - generates `gas/widget.html` from upstream
  `feedback-widget.html` (never edit either output or upstream; `--check` in CI).
- `gas/` - the Apps Script web app (clasp project). Deploy:
  `cd designhub/gas && clasp push -f && clasp create-deployment -i <id> -d "<desc>"`.
- `test/` - `node --test designhub/test/`; `test/e2e/` are manual dev-browser scripts.
- Publishing: the `designhub` plugin's `/publish-design` skill
  (`plugins/designhub/`).
```

- [ ] **Step 2: Update the design doc status line** - in `docs/designhub/design.md`, change the `> **Status: draft v0.1 ...**` line to:

```markdown
> **Status: v1 implemented · spike-validated (see pocs/) · 2026-07-05 draft accepted**
```

- [ ] **Step 3: Full verification sweep** (the same four commands as CI) and manual checklist:

```bash
node build.js --check && npm test && node designhub/build-designhub.js --check && node --test designhub/test/
```

Then confirm against `docs/designhub/design.md` §7 "V1 (must-have)": publish skill ✓, self-contained scan ✓, login-gated viewing (html + md + widget) ✓, tree UI ✓, comments with identity/threading/statuses ✓, agent access docs ✓.

- [ ] **Step 4: Commit remaining files, push, open the PR (fork only - PRs never target upstream without the repo owner's explicit approval):**

```bash
git add -A && git commit -m "designhub: v1 - README + design doc status"
git push
gh pr create --repo <DH_FORK_REPO> --base main \
  --title "DesignHub v1: publish skill + GAS serving layer + agent access" \
  --body "Implements docs/designhub/design.md (D1-D19) per docs/designhub/plans/2026-07-05-designhub-v1-implementation.md. All mechanisms POC-validated (docs/designhub/pocs/). Upstream files untouched except the marketplace.json entry (D16)."
```

---

## Post-v1 backlog (explicitly OUT of this plan - do not build)

- Phase 2 (design §7): Sync-to-PR, quote -> source-line mapping, the comment-driven agent fix loop skill (`plugins/designhub/skills/designhub-agent/`), multi-file docs.
- Widget thread/reply UI (v1 shows top-level tickets; threads live in the Sheet).
- Mermaid publish-time pre-render (poc3 finding 2, if the ~30 s diagram pop-in annoys) and `marked-gfm-heading-id` for MD TOC anchors.
- Live updates (SSE equivalent) - v1 polls every 30 s.
- `designhub@` service account migration for the script owner (D13).

## Verification checklist (run after the last task)

- [ ] `node --test designhub/test/` - all green
- [ ] `node designhub/build-designhub.js --check` + `node build.js --check` - both clean
- [ ] `npm test` (upstream) - untouched and green
- [ ] Tree page lists the dogfooded docs; both serve with the widget
- [ ] A comment submitted in the browser lands in the companion Sheet with the VIEWER's email (not any client-claimed identity)
- [ ] `home-knowledge@` can reply via REST per `agent-access.md` (poc4 recipe) against a PRODUCTION companion Sheet
- [ ] Re-publish of an edited doc: same URL, D15 statuses flip where expected
- [ ] `git log upstream/main..HEAD -- feedback-widget.html build.js server.js lib/ plugins/cc-htmlfeedback/` is EMPTY (D16 honored)
