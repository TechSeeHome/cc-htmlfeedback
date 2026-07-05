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
import { scanAssets, featureDir, newIndexRow, upsertRowIndex,
  TICKET_COLS, INDEX_COLS, META_COLS } from './publish-lib.mjs';
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
// !indexRows.length (not just === null): a crash between the tab-rename and
// the header write below would leave a real, non-null empty result on retry
// (the range genuinely has zero rows) - re-running this idempotent setup is
// the only way to heal that, and redoing it on an already-correct header is
// a harmless no-op.
if (indexRows === null || !indexRows.length) {   // brand-new (or partially-initialized) sheet: name the tab + header
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
// D19 direct-upsert decision (see 00-overview.md "Two items for whoever
// executes Task 6 and Task 10", item 2, and publish-lib.mjs's upsertRowIndex
// comment for the full reasoning): this find-by-key lookup is the same
// decision gas/lib/rollup.js's upsertRow tests, factored out because
// publish.mjs cannot import that GAS-side file (self-containment) and this
// exact lookup is needed twice (here and in Step 7 below) against different
// in-memory row arrays.
const rowIdx = upsertRowIndex(indexRows, ID_COL, doc.id);
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
const pIdx = upsertRowIndex(pRows, ID_COL, doc.id);   // same decision as Step 6, second array
if (pIdx === -1) await appendVals(portal.id, 'A:N', [indexRow]);
else await putVals(portal.id, `A${pIdx + 2}:N${pIdx + 2}`, [indexRow]);

console.log('\nPublished: ' + url);
console.log('Comments Sheet: https://docs.google.com/spreadsheets/d/' + companionId);
