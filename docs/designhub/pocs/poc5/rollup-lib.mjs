// POC-5: pure rollup logic - no Google APIs, `node --test`-able (design D5/§6:
// logic that tests without Apps Script migrates to any host without Apps Script).

export const INDEX_COLS = ['id', 'type', 'title', 'repo', 'feature', 'jira', 'tags',
  'owner', 'driveFileId', 'commentSheetId', 'url', 'status', 'publishedAt', 'updatedAt'];

const KEY = INDEX_COLS.indexOf('driveFileId');
const UPDATED = INDEX_COLS.indexOf('updatedAt');
const REPO = INDEX_COLS.indexOf('repo');
const FEATURE = INDEX_COLS.indexOf('feature');
const TITLE = INDEX_COLS.indexOf('title');

// Upsert one row into rollup rows, keyed by driveFileId.
// Returns { action: 'appended' | 'updated', rows }.
export function upsertRow(rows, row) {
  const i = rows.findIndex((r) => r[KEY] === row[KEY]);
  if (i === -1) return { action: 'appended', rows: [...rows, row] };
  const next = rows.slice();
  next[i] = row;
  return { action: 'updated', rows: next };
}

// Rebuild the whole rollup from feature _index shards (the reconciler).
// Shards are arrays of rows. Duplicates across shards resolve to the newest
// updatedAt. Output is deterministically sorted (repo, feature, title).
export function buildRollup(shards) {
  const byKey = new Map();
  for (const rows of shards) {
    for (const r of rows) {
      const k = r[KEY];
      if (!k) continue;
      const prev = byKey.get(k);
      if (!prev || String(r[UPDATED] ?? '') > String(prev[UPDATED] ?? '')) byKey.set(k, r);
    }
  }
  return [...byKey.values()].sort((a, b) =>
    String(a[REPO]).localeCompare(String(b[REPO])) ||
    String(a[FEATURE]).localeCompare(String(b[FEATURE])) ||
    String(a[TITLE]).localeCompare(String(b[TITLE])));
}
