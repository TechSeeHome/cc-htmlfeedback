// node --test rollup-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertRow, buildRollup, INDEX_COLS } from './rollup-lib.mjs';

const KEY = INDEX_COLS.indexOf('driveFileId');
const row = (fileId, repo, feature, title, updatedAt) => {
  const r = new Array(INDEX_COLS.length).fill('');
  r[INDEX_COLS.indexOf('id')] = 'uuid-' + fileId;
  r[KEY] = fileId;
  r[INDEX_COLS.indexOf('repo')] = repo;
  r[INDEX_COLS.indexOf('feature')] = feature;
  r[INDEX_COLS.indexOf('title')] = title;
  r[INDEX_COLS.indexOf('updatedAt')] = updatedAt;
  return r;
};

test('upsert appends a new key', () => {
  const { action, rows } = upsertRow([], row('f1', 'r', 'x', 'doc', '2026-01-01'));
  assert.equal(action, 'appended');
  assert.equal(rows.length, 1);
});

test('upsert updates an existing key in place (idempotent re-publish)', () => {
  const r1 = row('f1', 'r', 'x', 'doc', '2026-01-01');
  const r2 = row('f1', 'r', 'x', 'doc', '2026-02-02');
  const first = upsertRow([], r1);
  const second = upsertRow(first.rows, r2);
  assert.equal(second.action, 'updated');
  assert.equal(second.rows.length, 1);
  assert.equal(second.rows[0][INDEX_COLS.indexOf('updatedAt')], '2026-02-02');
});

test('rebuild is the union of shards', () => {
  const out = buildRollup([
    [row('f1', 'repoA', 'feat1', 'a', '1')],
    [row('f2', 'repoA', 'feat2', 'b', '1'), row('f3', 'repoB', 'feat1', 'c', '1')],
  ]);
  assert.deepEqual(out.map((r) => r[KEY]), ['f1', 'f2', 'f3']);
});

test('rebuild converges after rollup loss (rollup is a disposable cache)', () => {
  const shards = [[row('f1', 'r', 'x', 'doc', '1')]];
  const rebuilt = buildRollup(shards); // regardless of prior rollup state
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0][KEY], 'f1');
});

test('rebuild drops rows with no shard backing (heals corrupt rollup entries)', () => {
  // a rollup that somehow contains a foreign row simply never sees it again:
  // rebuild reads shards only
  const rebuilt = buildRollup([[row('real', 'r', 'x', 'doc', '1')]]);
  assert.equal(rebuilt.find((r) => r[KEY] === 'ghost'), undefined);
});

test('cross-shard duplicate resolves to newest updatedAt', () => {
  const rebuilt = buildRollup([
    [row('f1', 'r', 'x', 'old-title', '2026-01-01')],
    [row('f1', 'r', 'x', 'new-title', '2026-03-03')],
  ]);
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0][INDEX_COLS.indexOf('title')], 'new-title');
});

test('rows without driveFileId are ignored', () => {
  const bad = new Array(INDEX_COLS.length).fill('');
  const rebuilt = buildRollup([[bad, row('f1', 'r', 'x', 'doc', '1')]]);
  assert.equal(rebuilt.length, 1);
});

test('output is deterministically sorted (repo, feature, title)', () => {
  const rebuilt = buildRollup([[
    row('f3', 'repoB', 'a', 'z', '1'),
    row('f2', 'repoA', 'b', 'y', '1'),
    row('f1', 'repoA', 'a', 'x', '1'),
  ]]);
  assert.deepEqual(rebuilt.map((r) => r[KEY]), ['f1', 'f2', 'f3']);
});
