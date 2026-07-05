# DesignHub v1 Implementation Plan - part 1 of 4: core libraries (pure, TDD)

> Tasks 1-5. Read [00-overview.md](00-overview.md) FIRST - it holds the goal,
> the non-negotiable constraints (D16, dual-use modules, HtmlService gotchas,
> Shared Drive REST discipline, hyphens-only), the fixed configuration
> placeholders, the file map, and the final verification checklist. Task
> numbering is global across the four part files. Steps use checkbox
> (`- [ ]`) syntax for tracking.

---

### Task 1: Scaffold the GAS project skeleton

**Files:**
- Create: `designhub/gas/appsscript.json`
- Create: `designhub/config.example.js` (+ gitignored working copy `designhub/gas/config.js`)
- Create: `designhub/test/.gitkeep`
- Modify: `.gitignore` (fork-local file - already carries fork-only sections; NOT in D16's upstream list)

- [ ] **Step 0: Confirm a non-main work branch** (repo rule: never commit to main - branch + PR): `git branch --show-current` must NOT print `main`; if it does, `git checkout -b feat/designhub-v1` first. Task 14 opens the PR.

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

- [ ] **Step 2: Create `designhub/config.example.js`** (committed TEMPLATE - the real
`gas/config.js` is gitignored in Step 2b so org-specific ids never land in the public
fork, same policy as `environment.local.md`. The template deliberately lives OUTSIDE
`gas/`: `clasp push` uploads every `.js` under its rootDir, and a second file assigning
`DH_CONFIG` would load after `config` in GAS's alphabetical order and clobber the real
values with placeholders):

```js
// DesignHub deployment configuration TEMPLATE (committed). Copy to
// designhub/gas/config.js and fill in the real ids from
// docs/designhub/plans/environment.local.md. gas/config.js is gitignored: the
// ids are not secrets (access is enforced by Drive ACLs), but they are
// org-specific and this fork stays generic. clasp pushes gas/config.js from
// disk regardless of git. Keep this template OUT of gas/ (clasp would push it
// and its load would overwrite the real DH_CONFIG).
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

- [ ] **Step 2b: Gitignore the local config files, then create the real `config.js`.**
Append to `.gitignore`:

```text
# DesignHub local deployment values (org-specific - never committed; the committed
# templates are designhub/config.example.js + plugins/designhub/designhub.config.json,
# real values come from docs/designhub/plans/environment.local.md)
designhub/gas/config.js
designhub/gas/.clasp.json
plugins/designhub/designhub.config.local.json
```

Then `cp designhub/config.example.js designhub/gas/config.js` and replace the three
`<DH_*>` placeholders with the real values from `environment.local.md`. With the ignore
rules in place, every later `git add designhub/` in this plan is safe - git never sees
the filled file. (Node tests never require `config.js`; only `clasp push` reads it.)

- [ ] **Step 3: Sanity-run the (empty) test suite**

Run: `node --test designhub/test/ 2>&1 | tail -3`
Expected: `pass 0` (no test files yet, exit 0). If node errors on the empty dir, `touch designhub/test/.gitkeep` and re-run.

- [ ] **Step 4: Commit**

```bash
git add designhub/ .gitignore
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
  // Columns resolve LAZILY, inside each call. Load-time resolution would kill
  // the whole GAS project: clasp pushes files alphabetically, so this file
  // loads BEFORE lib/schema.js - DH_SCHEMA would be undefined at load and
  // require() does not exist in the GAS runtime, so doGet and every bridge
  // call would die with a load-time ReferenceError.
  function cols_() {
    return (typeof DH_SCHEMA !== 'undefined') ? DH_SCHEMA.INDEX_COLS
      : require('./schema.js').INDEX_COLS;
  }

  function upsertRow(rows, row) {
    var KEY = cols_().indexOf('driveFileId');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][KEY] === row[KEY]) {
        var next = rows.slice(); next[i] = row;
        return { action: 'updated', rows: next };
      }
    }
    return { action: 'appended', rows: rows.concat([row]) };
  }

  function buildRollup(shards) {
    var COLS = cols_();
    var KEY = COLS.indexOf('driveFileId');
    var UPDATED = COLS.indexOf('updatedAt');
    var REPO = COLS.indexOf('repo');
    var FEATURE = COLS.indexOf('feature');
    var TITLE = COLS.indexOf('title');
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
  // single-quoted attributes get the same treatment
  assert.match(R.injectBase("<head></head><a href='#s2'>j</a>"), /<a target="_self" href='#s2'>/);
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
  assert.match(out, /d\.id="dh-identity"/);   // the Task 13 E2E finds the chip by this id
});

test('mdShell embeds MD as JSON, inlines marked, loads mermaid as asset', () => {
  const out = R.mdShell('# Hi\n```mermaid\ngraph TD;A-->B;\n```', 'var marked={parse:function(){}};',
    EXEC + '?asset=mermaid', 'design.md');
  assert.match(out, /var MD_SOURCE="# Hi/);
  assert.match(out, /var marked=/);
  assert.match(out, /\?asset=mermaid/);
  assert.match(out, /<base target="_top">/);
  // poc1: rendered #anchor links must get target=_self at runtime or a TOC
  // click navigates the top window out of the sandbox
  assert.match(out, /a\.target="_self"/);
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
    return html.replace(/<a\s([^>]*href=["']#)/gi, '<a target="_self" $1');
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
      'd.id="dh-identity";d.style.cssText="font:11px monospace;color:#5b6072;padding:2px 0";' +
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
      // poc1 MANDATORY rewrite, MD flavor: marked renders <a href="#..."> at
      // runtime, after injectBase-style source rewrites could ever see them -
      // without target="_self" a TOC click navigates the TOP window into the
      // raw googleusercontent sandbox URL (page + widget lost). marked emits no
      // heading ids in v1 (poc3), so these clicks are safe no-ops until
      // marked-gfm-heading-id lands (backlog).
      'document.querySelectorAll("a").forEach(function(a){var h=a.getAttribute("href");if(h&&h.charAt(0)==="#")a.target="_self";});\n' +
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

