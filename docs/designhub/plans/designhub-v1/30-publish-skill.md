# DesignHub v1 Implementation Plan - part 3 of 4: the /publish-design skill

> Tasks 9-11. Read [00-overview.md](00-overview.md) FIRST - it holds the goal,
> the non-negotiable constraints (D16, dual-use modules, HtmlService gotchas,
> Shared Drive REST discipline, hyphens-only), the fixed configuration
> placeholders, the file map, and the final verification checklist. Task
> numbering is global across the four part files. Steps use checkbox
> (`- [ ]`) syntax for tracking.

---

### Task 9: `anchors.mjs` - the D15 re-anchor pass (pure logic)

Runs at publish time inside the skill. D15 verbatim: every non-terminal ticket (`open` AND `in-progress`) is checked against the NEW doc content using the full anchor triple (quote + context + section); quote gone -> `anchor-lost` (never `resolved`), EXCEPT a `strike` whose quote is gone auto-closes `resolved`; a quote that matches but whose context OR section no longer matches counts as lost. Matching must run on RENDERED-equivalent text: widget quotes come from rendered pages, so HTML docs get tags stripped and MD docs get inline markdown syntax stripped - raw-source matching would false-flag every quote spanning `**bold**` or a link.

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
  const doc = '<h2>Intro</h2><p>The <b>quick</b> brown fox jumps over the lazy dog.</p>';
  assert.deepEqual(reanchorPass([t()], doc, true), []);
});

test('markdown syntax does not break matching (quotes come from RENDERED text)', async () => {
  const { reanchorPass } = await mod();
  const md = '## Intro\n\nThe **quick** `brown` [fox](https://x.example) jumps over the lazy dog.\n';
  assert.deepEqual(reanchorPass([t()], md, false), []);
});

test('markdown table decoration is stripped before matching', async () => {
  const { reanchorPass } = await mod();
  const md = '## Intro\n\n| a | b |\n|---|---|\n| The quick brown fox jumps over the lazy dog. | x |\n';
  assert.deepEqual(reanchorPass([t()], md, false), []);
});

test('quote and context present but section heading gone -> anchor-lost (full triple)', async () => {
  const { reanchorPass } = await mod();
  const doc = '<html><body><h2>Renamed</h2><p>The quick brown fox jumps over the lazy dog.</p></body></html>';
  const out = reanchorPass([t()], doc, true);
  assert.equal(out[0].status, 'anchor-lost');
  assert.match(out[0].result, /section/);
});

test('context ellipsis from the widget clip is tolerated', async () => {
  const { reanchorPass } = await mod();
  assert.deepEqual(reanchorPass([t({ context: 'The quick brown fox jumps…' })], DOC, true), []);
});

test('html entities are decoded before matching (source encodes what the browser rendered)', async () => {
  const { reanchorPass } = await mod();
  const doc = '<html><body><h2>Intro</h2><p>Foo &amp; Bar &lt;3 the quick brown fox jumps over the lazy dog.</p></body></html>';
  const ticket = t({ quote: 'Foo & Bar <3 the quick brown fox',
    context: 'Foo & Bar <3 the quick brown fox jumps over the lazy dog.' });
  assert.deepEqual(reanchorPass([ticket], doc, true), []);
});

test('nested emphasis fully unwraps (fixed-point strip) - a strike must NOT auto-resolve when the text is unchanged', async () => {
  const { reanchorPass } = await mod();
  const md = '## Intro\n\nThis is **bold _italic_ text** in a sentence.\n';
  const out = reanchorPass([t({ type: 'strike', quote: 'is bold italic text in',
    context: 'This is bold italic text in a sentence.' })], md, false);
  assert.deepEqual(out, []);
});

test('an escaped table pipe is preserved as a literal | (not confused with table decoration)', async () => {
  const { reanchorPass } = await mod();
  const md = '## Intro\n\n| type | note |\n|---|---|\n| string \\| number | primary key |\n';
  const out = reanchorPass([t({ type: 'strike', quote: 'string | number',
    context: 'string | number' })], md, false);
  assert.deepEqual(out, []);
});

test('a link whose text contains nested brackets still matches end to end', async () => {
  const { reanchorPass } = await mod();
  const md = '## Intro\n\nSee the [quick [brown] fox](https://example.com) jumps over the lazy dog.\n';
  const out = reanchorPass([t({ type: 'strike', quote: 'quick [brown] fox jumps over the lazy dog',
    context: 'quick [brown] fox jumps over the lazy dog' })], md, false);
  assert.deepEqual(out, []);
});

test('html entities are decoded on the markdown path too', async () => {
  const { reanchorPass } = await mod();
  const md = '## Intro\n\nFoo &amp; Bar &lt;3 the quick brown fox jumps over the lazy dog.\n';
  const ticket = t({ quote: 'Foo & Bar <3 the quick brown fox',
    context: 'Foo & Bar <3 the quick brown fox jumps over the lazy dog.' });
  assert.deepEqual(reanchorPass([ticket], md, false), []);
});
```

- [ ] **Step 2: Run to verify FAIL:** `node --test designhub/test/anchors.test.js`

- [ ] **Step 3: Implement `plugins/designhub/skills/publish-design/scripts/anchors.mjs`:**

```js
// D15 re-anchor pass, pure. Matching runs on normalized RENDERED-equivalent
// TEXT (html: tags stripped + entities decoded; md: inline markdown syntax
// stripped; whitespace collapsed) because the widget's quote/context come
// from rendered text, not source bytes - raw-source matching would false-lose
// any quote spanning **bold**, `code`, a [link](url), or an HTML entity like
// &amp; (a strike whose quote only LOOKS gone due to entity mismatch would
// otherwise wrongly auto-resolve as fixed - the exact outcome D15 exists to
// prevent).
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const decodeEntities = (s) => String(s)
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&(?:#0*39|apos);/g, "'")
  .replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));

// Approximate md-to-text: conservative in the right direction - leftovers only
// ADD characters to the haystack; the needle (quote/context) is rendered text.
// Placeholder for an ESCAPED pipe (\|), so the blanket table-pipe strip below
// doesn't erase a literal '|' a doc means to display (e.g. a "string | number"
// type union in a spec table) - restored to '|' as the final step.
const PIPE_PLACEHOLDER = String.fromCharCode(0);
const mdText = (md) => {
  let text = String(md)
    .replace(/^```[^\n]*$/gm, ' ')             // code-fence delimiter lines
    .replace(/`([^`]*)`/g, '$1')               // inline code
    .replace(/\\\|/g, PIPE_PLACEHOLDER)        // escaped pipe -> placeholder, restored below
    // Lazy [\s\S]*? (not [^\]]*): a link/image whose text itself contains a
    // "]" (e.g. "[quick [brown] fox](url)") must still match end-to-end -
    // a match that fails outright leaves the raw "[...](url)" (URL and all)
    // sitting in the haystack, breaking any quote that spans past it.
    .replace(/!\[([\s\S]*?)\]\([^)]*\)/g, '$1') // images -> alt text
    .replace(/\[([\s\S]*?)\]\([^)]*\)/g, '$1')  // links -> link text
    .replace(/^#{1,6}\s+/gm, '')                // heading markers
    .replace(/^\s*[-*+]\s+/gm, '')              // list bullets
    .replace(/^\s*>\s?/gm, '')                  // blockquote markers
    .replace(/\|/g, ' ');                       // remaining (unescaped/table) pipes
  // Bold/emphasis run to a FIXED POINT: nested markers (e.g. "**bold _italic_
  // text**") don't fully strip in one pass - the bold regex can't match
  // through the inner "_..._" content, so a single pass leaves literal "**"
  // characters injected mid-haystack, breaking any quote spanning them.
  let prev;
  do {
    prev = text;
    text = text
      .replace(/(\*\*|__)([^*_]+)\1/g, '$2')    // bold
      .replace(/(\*|_)([^*_]+)\1/g, '$2');       // emphasis
  } while (text !== prev);
  return text.replace(new RegExp(PIPE_PLACEHOLDER, 'g'), '|');
};

const textify = (source, isHtml) => norm(decodeEntities(isHtml
  ? String(source).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ')
  : mdText(source)));

// The widget clips context to 160 chars with a trailing ellipsis - strip it
// and require a reasonable core before using context as a disambiguator.
// 12 chars is a deliberately lenient floor, not a tuned constant: the widget
// stops context capture at the enclosing TD/TH, so a comparison-table cell
// ("Yes", "N/A") legitimately produces a very short context - below the floor
// this falls back to quote+section only rather than treating "too short to
// be meaningful" as a mismatch.
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
      continue;
    }
    // Third leg of the triple: the section heading must still exist somewhere
    // in the doc (headings are body text once tags/markers are stripped).
    const sec = norm(t.section);
    if (sec && !text.includes(sec)) {
      changes.push({ id: t.id, status: 'anchor-lost',
        result: 'quote exists but its section heading is gone (D15 full-triple rule)' });
    }
  }
  return changes;
}
```

- [ ] **Step 4: Run tests, expect PASS:** `node --test designhub/test/anchors.test.js`

- [ ] **Step 5: Commit:** `git add designhub/ plugins/designhub/ && git commit -m "designhub: D15 re-anchor pass, full-triple matching (TDD)"`

---

### Task 10: The publish flow - `gauth.mjs`, `publish-lib.mjs`, `publish.mjs`

The Google call sequence is poc2's proven `publish-dry-run.mjs`, upgraded with: D9 metadata inference helpers, the two-severity asset scan (poc2 learning #1), the D15 pass (Task 9), and the D19 rollup upsert (poc5). Pure helpers live in `publish-lib.mjs` (tested); `publish.mjs` is the CLI; `gauth.mjs` owns tokens.

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

test('featureDir mirrors gas/lib/paths.js exactly (D14 - keep the two in sync)', async () => {
  const { featureDir } = await mod();
  const gas = require('../gas/lib/paths.js');
  for (const f of ['design/designhub-platform', 'a\\b:c', 'x*y?"<>|', 'plain'])
    assert.equal(featureDir(f), gas.featureDir(f));
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

// D14 sanitizer - deliberate MIRROR of designhub/gas/lib/paths.js featureDir():
// the installed plugin is self-contained and cannot import repo files at run
// time. The repo test suite pins the two together - change BOTH or it fails.
export const featureDir = (feature) =>
  String(feature).replace(/[\/\\]/g, '--').replace(/[:*?"<>|]/g, '-');

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
  // dev-machine assumptions: fixed local port + macOS `open`; on other OSes
  // the printed URL is the path (the spawn failure is swallowed on purpose)
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
  if (!r.ok) {
    // status is attached so callers can tell "missing tab" (400) from real
    // failures (403/5xx) instead of swallowing everything
    const e = new Error(`${opts.method || 'GET'} ${url} -> ${r.status}: ${await r.text()}`);
    e.status = r.status;
    throw e;
  }
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
import { scanAssets, featureDir, newIndexRow, TICKET_COLS, INDEX_COLS, META_COLS } from './publish-lib.mjs';
import { reanchorPass } from './anchors.mjs';

// Config: the gitignored .local file (real org values, Task 8) wins; the
// committed designhub.config.json is a generic placeholder template.
const cfgLocal = new URL('../../../designhub.config.local.json', import.meta.url);
const cfgMain = new URL('../../../designhub.config.json', import.meta.url);
const CONFIG = JSON.parse(fs.readFileSync(fs.existsSync(cfgLocal) ? cfgLocal : cfgMain, 'utf8'));
if (/^<DH_/.test(String(CONFIG.rootFolderId || ''))) {
  console.error('designhub.config.local.json is missing - copy designhub.config.json ' +
    'next to it and fill the real values (see docs/designhub/plans/environment.local.md)');
  process.exit(2);
}
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
const FEATURE_DIR = featureDir(FEATURE);   // D14 (publish-lib mirror, test-pinned to gas/lib/paths.js)
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
// A brand-new spreadsheet has no named tab yet -> Sheets answers 400 ("Unable
// to parse range"). ONLY that means "initialize this sheet"; 403/5xx/network
// must surface, not silently re-create headers over an unreadable sheet.
const valsOrNull = (id, range) => getVals(id, range).catch((e) => {
  if (e.status === 400) return null;
  throw e;
});
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
let indexRows = await valsOrNull(indexId, 'index!A2:N');
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
const head = await valsOrNull(companionId, 'tickets!1:1');
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

- [ ] **Step 8: Integration dry-run against the POC area** (NOT prod): edit `plugins/designhub/designhub.config.local.json`, set `rootFolderId` to `<DH_POC_FOLDER_ID>` (DesignHub-POC, see `environment.local.md`), run the two commands below, then put the prod `rootFolderId` back (the file is gitignored - restore it by hand, there is nothing to `git checkout`):

```bash
node plugins/designhub/skills/publish-design/scripts/publish.mjs \
  --file docs/designhub/design.html --repo cc-htmlfeedback \
  --feature design/designhub-platform --dry-run
node plugins/designhub/skills/publish-design/scripts/publish.mjs \
  --file docs/designhub/design.html --repo cc-htmlfeedback \
  --feature design/designhub-platform --allow-assets   # design.html has nav links only; assets list must be EMPTY - if BLOCK appears, the scan is misclassifying
```

Expected: run 1 prints the dry-run JSON; run 2 prints WARN listing the three relative nav links (`./design.md`, `../how-it-works.md`, `../how-it-works.html`), no BLOCK, then `Published: <execUrl>?doc=cc-htmlfeedback/design--designhub-platform/docs/designhub/design.html`. Run the publish twice - the second run must not duplicate the index row (check the printed Sheet). Then restore the prod `rootFolderId` in the local config.

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

- One-time machine setup: if publish.mjs exits complaining that
  `designhub.config.local.json` is missing, copy the plugin's
  `designhub.config.json` to `designhub.config.local.json` (same directory) and
  fill the real `rootFolderId`/`execUrl` - the committed file is a placeholder
  template, the real org values are never committed.
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

