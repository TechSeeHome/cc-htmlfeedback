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

// D19 direct-upsert decision point (00-overview.md "Two items for whoever
// executes Task 6 and Task 10", item 2): gas/lib/rollup.js exports a tested
// upsertRow(rows, row) - find a row by its key column, replace it in place,
// else append - but publish.mjs's Step 6 (_index) and Step 7 (_portal-index)
// upserts reimplement the same find-or-append decision inline against live
// Sheets REST calls instead of calling it, and structurally CANNOT call it:
// the installed plugins/designhub/ skill is self-contained and can't import
// designhub/gas/lib/ at runtime (the same constraint documented on
// featureDir above). Deliberate choice: extract this small pure helper
// mirroring upsertRow's DECISION shape (not its full "return a new rows
// array" shape - unlike a rollup rebuild, publish.mjs's two call sites do
// different things with the answer: Step 6 patches selected fields of the
// existing row, Step 7 PUTs a full replacement row) rather than leaving the
// inline `rows.findIndex((r) => r[keyCol] === key)` duplicated (verbatim) at
// both call sites with no test coverage of its own. Symmetry: this is the
// same find-by-key contract upsertRow tests, just returning the index
// instead of a rebuilt array, so callers stay free to act on it differently.
export const upsertRowIndex = (rows, keyCol, key) => rows.findIndex((r) => r[keyCol] === key);

export const TICKET_COLS = ['id', 'parentId', 'type', 'status', 'quote', 'context',
  'section', 'note', 'authorEmail', 'authorName', 'source', 'docVersion',
  'result', 'files', 'createdAt', 'updatedAt'];
export const INDEX_COLS = ['id', 'type', 'title', 'repo', 'feature', 'jira', 'tags',
  'owner', 'driveFileId', 'commentSheetId', 'url', 'status', 'publishedAt', 'updatedAt'];
export const META_COLS = ['repo', 'pathInRepo', 'branch', 'commitSha', 'pr', 'jira',
  'publisher', 'publishedAt', 'note'];
