const { test } = require('node:test');
const assert = require('node:assert/strict');
const { upsertRow, buildRollup } = require('../gas/lib/rollup.js');
const { INDEX_COLS } = require('../gas/lib/schema.js');

function row(over) {
  const o = Object.assign(
    {
      id: 'u1',
      type: 'html',
      title: 't',
      repo: 'r',
      feature: 'f',
      jira: 'unassigned',
      tags: '',
      owner: 'me@example.com',
      driveFileId: 'F1',
      commentSheetId: 'C1',
      url: 'U',
      status: 'active',
      publishedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    over
  );
  return INDEX_COLS.map((c) => o[c]);
}
const DFI = INDEX_COLS.indexOf('driveFileId');
const TITLE = INDEX_COLS.indexOf('title');

test('upsertRow appends when the key is new', () => {
  const r = upsertRow([], row({ driveFileId: 'F1' }));
  assert.equal(r.action, 'appended');
  assert.equal(r.rows.length, 1);
});

test('upsertRow updates in place without mutating the input array', () => {
  const original = [row({ driveFileId: 'F1', title: 'old' })];
  const r = upsertRow(original, row({ driveFileId: 'F1', title: 'new' }));
  assert.equal(r.action, 'updated');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0][TITLE], 'new');
  assert.equal(original[0][TITLE], 'old'); // input array untouched
});

test('buildRollup returns [] for no shards', () => {
  assert.deepEqual(buildRollup([]), []);
});

test('buildRollup unions rows across multiple shards', () => {
  const out = buildRollup([[row({ driveFileId: 'F1' })], [row({ driveFileId: 'F2' })]]);
  assert.equal(out.length, 2);
});

test('buildRollup dedups by driveFileId, newest updatedAt wins', () => {
  const stale = row({ driveFileId: 'F1', title: 'stale', updatedAt: '2026-01-01T00:00:00Z' });
  const fresh = row({ driveFileId: 'F1', title: 'fresh', updatedAt: '2026-02-01T00:00:00Z' });
  const out = buildRollup([[stale], [fresh]]);
  assert.equal(out.length, 1);
  assert.equal(out[0][TITLE], 'fresh');
});

test('buildRollup skips ghost rows (empty driveFileId)', () => {
  const out = buildRollup([[row({ driveFileId: '' }), row({ driveFileId: 'F1' })]]);
  assert.equal(out.length, 1);
  assert.equal(out[0][DFI], 'F1');
});

test('buildRollup skips multiple ghost rows in the same shard', () => {
  const out = buildRollup([
    [row({ driveFileId: '' }), row({ driveFileId: '' }), row({ driveFileId: 'F1' })],
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0][DFI], 'F1');
});

test('buildRollup treats a fully empty shard as a no-op alongside a real one', () => {
  const out = buildRollup([[], [row({ driveFileId: 'F1' })]]);
  assert.equal(out.length, 1);
  assert.equal(out[0][DFI], 'F1');
});

test('buildRollup on an exact updatedAt tie: the first row seen for the key wins (documented, not arbitrary)', () => {
  const first = row({ driveFileId: 'F1', title: 'first', updatedAt: '2026-01-01T00:00:00.000Z' });
  const second = row({ driveFileId: 'F1', title: 'second', updatedAt: '2026-01-01T00:00:00.000Z' });
  const out = buildRollup([[first], [second]]);
  assert.equal(out.length, 1);
  assert.equal(out[0][TITLE], 'first');
});

test('buildRollup sorts by repo, then feature, then title', () => {
  const out = buildRollup([
    [
      row({ driveFileId: 'F1', repo: 'b', feature: 'x', title: 'z' }),
      row({ driveFileId: 'F2', repo: 'a', feature: 'y', title: 'a' }),
      row({ driveFileId: 'F3', repo: 'a', feature: 'x', title: 'z' }),
    ],
  ]);
  assert.deepEqual(
    out.map((r) => r[DFI]),
    ['F3', 'F2', 'F1']
  );
});

test('buildRollup is idempotent: rebuilding from its own output converges', () => {
  const shards = [
    [row({ driveFileId: 'F1', updatedAt: '2026-01-01T00:00:00Z' })],
    [row({ driveFileId: 'F1', updatedAt: '2026-01-02T00:00:00Z' })],
  ];
  const first = buildRollup(shards);
  const second = buildRollup([first]);
  assert.deepEqual(second, first);
});
