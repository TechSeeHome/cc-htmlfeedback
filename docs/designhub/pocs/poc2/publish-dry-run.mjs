// POC-2: publish-surface dry run - the exact Drive/Sheets REST sequence
// /publish-design will make (design.md §5 contracts, D14/D18 semantics).
//
//   node publish-dry-run.mjs            normal publish (idempotent - run twice)
//   node publish-dry-run.mjs --collide  D14 negative test: same folder, different
//                                       original feature -> must fail loudly
//
// Auth: reuses the gdoc-md-sync OAuth client refresh token (igora@techsee.me).
// All artifacts go under Home - R&D/DesignHub-POC/ - never the real DesignHub root.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TOKEN_FILE = '/Users/igor/.claude/skills/gdoc-md-sync/token.json';
const HOME_RND = '1H7S4iRkH_V9OmcLpSa6hLEefobbIBid2'; // Home - R&D folder (shared drive 0AIDe9QcffDv_Uk9PVA)
const POC_ROOT_NAME = 'DesignHub-POC';

const REPO = 'cc-htmlfeedback';
// --collide: a *different* original feature whose sanitized dir is the SAME
// ('design--designhub-platform' literal vs 'design/designhub-platform' slashed) -
// exactly the D14 case the check must refuse.
const FEATURE_ORIGINAL = process.argv.includes('--collide')
  ? 'design--designhub-platform'
  : 'design/designhub-platform';
const FEATURE_DIR = FEATURE_ORIGINAL.replaceAll('/', '--'); // D14 sanitization
const DOC_LOCAL = path.resolve(import.meta.dirname, '../../design.html');
const DOC_SUBPATH = ['docs', 'designhub']; // D14: repo-relative subpath preserved
const DOC_NAME = 'design.html';

const INDEX_COLS = ['id', 'type', 'title', 'repo', 'feature', 'jira', 'tags', 'owner',
  'driveFileId', 'commentSheetId', 'url', 'status', 'publishedAt', 'updatedAt'];
const TICKET_COLS = ['id', 'parentId', 'type', 'status', 'quote', 'context', 'section',
  'note', 'authorEmail', 'authorName', 'source', 'docVersion', 'result', 'files',
  'createdAt', 'updatedAt'];
const META_COLS = ['repo', 'pathInRepo', 'branch', 'commitSha', 'pr', 'jira',
  'publisher', 'publishedAt', 'note'];

// ---------- auth + api ----------
let ACCESS_TOKEN;
async function auth() {
  const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: t.client_id, client_secret: t.client_secret,
      refresh_token: t.refresh_token, grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) throw new Error(`token refresh failed: ${await r.text()}`);
  ACCESS_TOKEN = (await r.json()).access_token;
}

async function api(url, { method = 'GET', headers = {}, body } = {}) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, ...headers },
    body,
  });
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

// ---------- drive helpers (all supportsAllDrives) ----------
const SAD = 'supportsAllDrives=true';
const LIST_EXTRA = `${SAD}&includeItemsFromAllDrives=true`;

async function findChild(parentId, name, mimeType) {
  let q = `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
  if (mimeType) q += ` and mimeType = '${mimeType}'`;
  const r = await api(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&${LIST_EXTRA}&fields=files(id,name,mimeType)`);
  if (r.files.length > 1) throw new Error(`ambiguous: ${r.files.length} children named '${name}' under ${parentId}`);
  return r.files[0] ?? null;
}

async function ensureFolder(parentId, name) {
  const existing = await findChild(parentId, name, 'application/vnd.google-apps.folder');
  if (existing) return { id: existing.id, created: false };
  const r = await api(`https://www.googleapis.com/drive/v3/files?${SAD}&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  return { id: r.id, created: true };
}

async function ensureSpreadsheet(parentId, name) {
  const existing = await findChild(parentId, name, 'application/vnd.google-apps.spreadsheet');
  if (existing) return { id: existing.id, created: false };
  const r = await api(`https://www.googleapis.com/drive/v3/files?${SAD}&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [parentId] }),
  });
  return { id: r.id, created: true };
}

async function uploadDoc(parentId, name, localPath) {
  const content = fs.readFileSync(localPath, 'utf8');
  const boundary = 'ccfb-' + crypto.randomBytes(8).toString('hex');
  const mkBody = (meta) => [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}`,
    `\r\n--${boundary}\r\nContent-Type: text/html\r\n\r\n${content}`,
    `\r\n--${boundary}--`,
  ].join('');
  const hdr = { 'Content-Type': `multipart/related; boundary=${boundary}` };

  const existing = await findChild(parentId, name);
  if (existing) {
    await api(`https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&${SAD}`, {
      method: 'PATCH', headers: hdr, body: mkBody({}),
    });
    return { id: existing.id, created: false };
  }
  const r = await api(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&${SAD}&fields=id`, {
    method: 'POST', headers: hdr, body: mkBody({ name, parents: [parentId] }),
  });
  return { id: r.id, created: true };
}

// ---------- sheets helpers ----------
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

async function tabTitles(spreadsheetId) {
  const r = await api(`${SHEETS}/${spreadsheetId}?fields=sheets(properties(sheetId,title))`);
  return r.sheets.map((s) => s.properties);
}

async function ensureTabs(spreadsheetId, wanted) {
  // renames the default first tab to wanted[0], adds the rest
  const tabs = await tabTitles(spreadsheetId);
  const requests = [];
  const titles = tabs.map((t) => t.title);
  if (!titles.includes(wanted[0])) {
    requests.push({ updateSheetProperties: { properties: { sheetId: tabs[0].sheetId, title: wanted[0] }, fields: 'title' } });
  }
  for (const w of wanted.slice(1)) {
    if (!titles.includes(w)) requests.push({ addSheet: { properties: { title: w } } });
  }
  if (requests.length) {
    await api(`${SHEETS}/${spreadsheetId}:batchUpdate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }),
    });
  }
}

async function getValues(spreadsheetId, range) {
  const r = await api(`${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(range)}`);
  return r.values ?? [];
}

async function setValues(spreadsheetId, range, values) {
  await api(`${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }),
  });
}

async function appendValues(spreadsheetId, range, values) {
  await api(`${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }),
  });
}

async function ensureHeader(spreadsheetId, tab, cols) {
  const head = await getValues(spreadsheetId, `${tab}!1:1`);
  if (!head.length) await setValues(spreadsheetId, `${tab}!1:1`, [cols]);
}

// ---------- the publish sequence ----------
const log = (step, x) => console.log(`[${step}]`, typeof x === 'string' ? x : JSON.stringify(x));

await auth();
log('auth', 'token minted (igora@)');

// 1. relative-asset scan (v1 self-contained contract)
const html = fs.readFileSync(DOC_LOCAL, 'utf8');
const relRefs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
  .map((m) => m[1])
  .filter((u) => !/^(https?:|#|data:|mailto:|\/\/)/i.test(u));
log('asset-scan', relRefs.length ? { WARNING_relative_refs: relRefs } : 'self-contained OK');

// 2. folder chain: DesignHub-POC/<repo>/<feature>/
const pocRoot = await ensureFolder(HOME_RND, POC_ROOT_NAME);
const repoF = await ensureFolder(pocRoot.id, REPO);
const featF = await ensureFolder(repoF.id, FEATURE_DIR);
log('folders', { pocRoot, repoF, featF, featureDir: FEATURE_DIR });

// 3. feature _index + D14 collision check BEFORE any write
const indexSheet = await ensureSpreadsheet(featF.id, '_index');
await ensureTabs(indexSheet.id, ['index']);
await ensureHeader(indexSheet.id, 'index', INDEX_COLS);
const rows = await getValues(indexSheet.id, 'index!A2:N');
const FEAT_COL = INDEX_COLS.indexOf('feature');
const foreign = rows.find((r) => r[FEAT_COL] && r[FEAT_COL] !== FEATURE_ORIGINAL);
if (foreign) {
  console.error(`[D14-COLLISION] folder '${FEATURE_DIR}' already belongs to feature '${foreign[FEAT_COL]}', not '${FEATURE_ORIGINAL}' - refusing to publish`);
  process.exit(2);
}
log('_index', { ...indexSheet, existingRows: rows.length });

// 4. doc subpath + upload (create or same-id update)
let docParent = featF.id;
for (const seg of DOC_SUBPATH) docParent = (await ensureFolder(docParent, seg)).id;
const doc = await uploadDoc(docParent, DOC_NAME, DOC_LOCAL);
log('doc', doc);

// 5. revisions accrue on re-publish
const revs = await api(`https://www.googleapis.com/drive/v3/files/${doc.id}/revisions?fields=revisions(id,modifiedTime)`);
log('revisions', { count: revs.revisions.length });

// 6. companion Sheet named after the FULL filename
const companion = await ensureSpreadsheet(docParent, `${DOC_NAME}.comments`);
await ensureTabs(companion.id, ['tickets', 'meta']);
await ensureHeader(companion.id, 'tickets', TICKET_COLS);
await ensureHeader(companion.id, 'meta', META_COLS);
const now = new Date().toISOString();
await appendValues(companion.id, 'meta!A:I', [[REPO, DOC_SUBPATH.join('/') + '/' + DOC_NAME,
  FEATURE_ORIGINAL, 'poc2-dry-run', '', 'unassigned', 'igora@techsee.me', now, 'publish (poc2)']]);
log('companion', companion);

// 7. _index upsert keyed by driveFileId (stable id, updatedAt bumps)
const ID_COL = INDEX_COLS.indexOf('driveFileId');
const rowIdx = rows.findIndex((r) => r[ID_COL] === doc.id);
const title = (html.match(/<title>(.*?)<\/title>/i)?.[1] ?? DOC_NAME).trim();
const url = `https://drive.google.com/file/d/${doc.id}/view`; // placeholder until the web app exists
if (rowIdx === -1) {
  await appendValues(indexSheet.id, 'index!A:N', [[crypto.randomUUID(), 'html', title, REPO,
    FEATURE_ORIGINAL, 'unassigned', '', 'igora@techsee.me', doc.id, companion.id, url, 'active', now, now]]);
  log('upsert', 'APPENDED new index row');
} else {
  const row = rows[rowIdx];
  row[INDEX_COLS.indexOf('updatedAt')] = now;
  await setValues(indexSheet.id, `index!A${rowIdx + 2}:N${rowIdx + 2}`, [row]);
  log('upsert', `UPDATED index row ${rowIdx + 2} (id stable: ${row[0]})`);
}

// 8. D18: no permissions.create - record what access the doc has by inheritance
const perms = await api(`https://www.googleapis.com/drive/v3/files/${doc.id}/permissions?${SAD}&fields=permissions(type,role,emailAddress,domain)`);
log('permissions(inherited)', perms.permissions);

log('DONE', { docId: doc.id, companionId: companion.id, indexId: indexSheet.id, revisions: revs.revisions.length });
