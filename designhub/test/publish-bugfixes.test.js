// Regression tests for the 9-bug review pass on publish.mjs. Kept in a
// separate file from publish.test.js (which covers publish-lib.mjs) so this
// pass's additions don't collide with unrelated concurrent edits to that
// file. publish.mjs guards its side-effecting CLI flow (argv validation,
// config load, network calls) behind an isMain check, so importing it here
// only evaluates its pure, exported helpers - no process.exit, no file
// reads, no network calls happen just by importing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mod = () => import('../../plugins/designhub/skills/publish-design/scripts/publish.mjs');

// ---- Bug #2: arg() returns literal `true` for a flag with no value ----
test('requireString: throws for a missing value (undefined)', async () => {
  const { requireString } = await mod();
  assert.throws(() => requireString('feature', undefined), /missing value for --feature/);
});

test('requireString: throws for the literal boolean true (flag present, no value)', async () => {
  const { requireString } = await mod();
  assert.throws(() => requireString('repo', true), /missing value for --repo/);
});

test('requireString: throws for an empty string', async () => {
  const { requireString } = await mod();
  assert.throws(() => requireString('file', ''), /missing value for --file/);
});

test('requireString: returns the value unchanged when it is a real string', async () => {
  const { requireString } = await mod();
  assert.equal(requireString('feature', 'design/x'), 'design/x');
});

// ---- Bug #7: no path-traversal guard on PATH_IN_REPO ----
test('validatePathInRepo: accepts an ordinary repo-relative path', async () => {
  const { validatePathInRepo } = await mod();
  assert.equal(validatePathInRepo('docs/designhub/design.html'), 'docs/designhub/design.html');
  assert.equal(validatePathInRepo('design.html'), 'design.html');
});

test('validatePathInRepo: rejects a ".." segment (parent traversal)', async () => {
  const { validatePathInRepo } = await mod();
  assert.throws(() => validatePathInRepo('../../etc/passwd'), /'\.'\/'\.\.' segment/);
  assert.throws(() => validatePathInRepo('docs/../../../etc/passwd'), /'\.'\/'\.\.' segment/);
});

test('validatePathInRepo: rejects a "." segment', async () => {
  const { validatePathInRepo } = await mod();
  assert.throws(() => validatePathInRepo('docs/./design.html'), /'\.'\/'\.\.' segment/);
});

test('validatePathInRepo: rejects empty segments (leading/trailing/doubled slash) - mirrors parseDocPath', async () => {
  const { validatePathInRepo } = await mod();
  assert.throws(() => validatePathInRepo('/docs/design.html'), /empty path segment/);
  assert.throws(() => validatePathInRepo('docs/design.html/'), /empty path segment/);
  assert.throws(() => validatePathInRepo('docs//design.html'), /empty path segment/);
});

// Cross-check against the actual gas/lib/paths.js rule, the same way
// publish.test.js pins featureDir against it (D14) - the whole point of
// this fix is that PATH_IN_REPO's segments become DOC_PATH's tail, which
// parseDocPath re-validates on the doGet side.
test('validatePathInRepo accepts exactly what parseDocPath would also accept as the doc-path tail', async () => {
  const { validatePathInRepo } = await mod();
  const P = require('../gas/lib/paths.js');
  const ok = 'docs/designhub/design.html';
  validatePathInRepo(ok);   // must not throw
  const parsed = P.parseDocPath(['repo', 'feat--x', ok].join('/'));
  assert.deepEqual(parsed.segments, ok.split('/'));
});

test('validatePathInRepo rejects exactly what parseDocPath would also reject as the doc-path tail', async () => {
  const { validatePathInRepo } = await mod();
  const P = require('../gas/lib/paths.js');
  const bad = 'docs/../../secret';
  assert.throws(() => validatePathInRepo(bad));
  assert.throws(() => P.parseDocPath(['repo', 'feat--x', bad].join('/')), /invalid/);
});

// ---- Bug #5: execUrl not validated before catalog upserts ----
test('findConfigProblem: flags a missing rootFolderId placeholder', async () => {
  const { findConfigProblem } = await mod();
  assert.equal(findConfigProblem({ rootFolderId: '<DH_ROOT_FOLDER_ID>', execUrl: 'https://x/exec' }), 'rootFolderId');
});

test('findConfigProblem: flags a missing execUrl', async () => {
  const { findConfigProblem } = await mod();
  assert.equal(findConfigProblem({ rootFolderId: 'real-id' }), 'execUrl');
});

test('findConfigProblem: flags an unfilled execUrl placeholder', async () => {
  const { findConfigProblem } = await mod();
  assert.equal(findConfigProblem({
    rootFolderId: 'real-id',
    execUrl: 'https://script.google.com/macros/s/<DH_DEPLOYMENT_ID>/exec',
  }), 'execUrl');
});

test('findConfigProblem: null when both are filled in', async () => {
  const { findConfigProblem } = await mod();
  assert.equal(findConfigProblem({ rootFolderId: 'real-id', execUrl: 'https://script.google.com/macros/s/X/exec' }), null);
});

// ---- Bug #6: Markdown docs skip the asset-scan gate entirely ----
test('scanMdAssets: classifies image embeds as assets (hard-block equivalent)', async () => {
  const { scanMdAssets } = await mod();
  const r = scanMdAssets('# T\n\n![diagram](./arch.png) and ![x](assets/x.svg)');
  assert.deepEqual(r.assets.sort(), ['./arch.png', 'assets/x.svg']);
  assert.deepEqual(r.links, []);
});

test('scanMdAssets: classifies bare links as nav links (soft-warn equivalent)', async () => {
  const { scanMdAssets } = await mod();
  const r = scanMdAssets('see [the other doc](./other.md) for details');
  assert.deepEqual(r.links, ['./other.md']);
  assert.deepEqual(r.assets, []);
});

test('scanMdAssets: ignores absolute/external/anchor/data/mailto targets', async () => {
  const { scanMdAssets } = await mod();
  const r = scanMdAssets(
    '![ext](https://x.com/a.png) ![data](data:image/png;base64,x) ' +
    '[abs](https://x.com/doc) [anchor](#sec) [mail](mailto:a@b.com)');
  assert.deepEqual(r.assets, []);
  assert.deepEqual(r.links, []);
});

test('scanMdAssets: does not double-count an image as also a link', async () => {
  const { scanMdAssets } = await mod();
  const r = scanMdAssets('![diagram](./arch.png)');
  assert.deepEqual(r.assets, ['./arch.png']);
  assert.deepEqual(r.links, []);
});

test('scanMdAssets: a clean doc with no relative refs reports nothing', async () => {
  const { scanMdAssets } = await mod();
  assert.deepEqual(scanMdAssets('# Title\n\njust text, no links or images'), { assets: [], links: [] });
});

// ---- Bug #8: commentSheetId never refreshed on republish ----
const INDEX_COLS = ['id', 'type', 'title', 'repo', 'feature', 'jira', 'tags',
  'owner', 'driveFileId', 'commentSheetId', 'url', 'status', 'publishedAt', 'updatedAt'];

test('patchIndexRow: refreshes commentSheetId along with title/url/jira/updatedAt', async () => {
  const { patchIndexRow } = await mod();
  const row = ['u1', 'html', 'Old Title', 'r', 'f', 'unassigned', '', 'me@example.com',
    'FILE1', 'OLD-SHEET-ID', 'https://old-url', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'];
  const patched = patchIndexRow(row,
    { title: 'New Title', url: 'https://new-url', jira: 'PROJ-9', commentSheetId: 'NEW-SHEET-ID', now: '2026-07-08T00:00:00Z' },
    INDEX_COLS);
  assert.equal(patched[INDEX_COLS.indexOf('title')], 'New Title');
  assert.equal(patched[INDEX_COLS.indexOf('url')], 'https://new-url');
  assert.equal(patched[INDEX_COLS.indexOf('jira')], 'PROJ-9');
  assert.equal(patched[INDEX_COLS.indexOf('commentSheetId')], 'NEW-SHEET-ID',
    'republishing after the companion Sheet was deleted/recreated must repoint the index row at the NEW sheet id');
  assert.equal(patched[INDEX_COLS.indexOf('updatedAt')], '2026-07-08T00:00:00Z');
  // Untouched fields (id, type, repo, feature, driveFileId, status, publishedAt) survive as-is.
  assert.equal(patched[INDEX_COLS.indexOf('id')], 'u1');
  assert.equal(patched[INDEX_COLS.indexOf('driveFileId')], 'FILE1');
  assert.equal(patched[INDEX_COLS.indexOf('status')], 'active');
});

test('patchIndexRow: does not mutate the input row array', async () => {
  const { patchIndexRow } = await mod();
  const row = ['u1', 'html', 'Old', 'r', 'f', 'unassigned', '', 'me@example.com',
    'FILE1', 'OLD-SHEET-ID', 'https://old-url', 'active', 't1', 't1'];
  const original = row.slice();
  patchIndexRow(row, { title: 'New', url: 'u', jira: 'j', commentSheetId: 'NEW-SHEET-ID', now: 't2' }, INDEX_COLS);
  assert.deepEqual(row, original);
});
