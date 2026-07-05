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

// upsertRowIndex: the decision point flagged in 00-overview.md ("Two items
// for whoever executes Task 6 and Task 10", item 2) - a small local pure
// helper mirroring gas/lib/rollup.js's upsertRow "find by key, else append"
// decision shape, since publish.mjs cannot import that GAS-side file
// (self-containment) and its own Step 6/Step 7 upserts both do the same
// `rows.findIndex(r => r[keyCol] === key)` lookup inline.
test('upsertRowIndex: -1 when the key is new (caller should append)', async () => {
  const { upsertRowIndex } = await mod();
  assert.equal(upsertRowIndex([['a', 1], ['b', 2]], 0, 'z'), -1);
});

test('upsertRowIndex: the row index when the key already exists (caller should update in place)', async () => {
  const { upsertRowIndex } = await mod();
  assert.equal(upsertRowIndex([['a', 1], ['b', 2]], 0, 'b'), 1);
});

test('upsertRowIndex: empty rows always means append', async () => {
  const { upsertRowIndex } = await mod();
  assert.equal(upsertRowIndex([], 0, 'anything'), -1);
});
