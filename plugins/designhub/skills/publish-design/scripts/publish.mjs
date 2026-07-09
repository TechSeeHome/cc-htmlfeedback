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
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { accessToken, api } from './gauth.mjs';
import { scanAssets, featureDir, newIndexRow, upsertRowIndex, docUrl,
  TICKET_COLS, INDEX_COLS, META_COLS } from './publish-lib.mjs';
import { reanchorPass } from './anchors.mjs';

// ---- pure helpers (no I/O) - kept above main() and exported so they're
// unit-testable by importing this module directly. Everything below main()
// is side-effecting (argv/config/network/exit) and only runs when this file
// is executed as the CLI entry point (see the isMain guard at the bottom) -
// NOT merely by importing it, which would otherwise crash a test runner the
// moment a required --flag or the local designhub.config.local.json isn't
// present.

// Bug #2 fix: arg() (below, inside main()) returns the literal boolean
// `true` when a flag is present with no following value (e.g. `--feature`
// at the very end of argv, or immediately followed by another `--flag`). A
// caller that only checks falsiness (`!FILE`) lets that `true` slip through
// as if it were a real value. requireString closes that gap for every
// string-valued flag.
export function requireString(name, val) {
  if (!val || val === true) throw new Error(`missing value for --${name}`);
  return val;
}

// Bug #7 fix: PATH_IN_REPO's segments become the tail of DOC_PATH
// (`[repo, featureDir, ...pathInRepo.split('/')]`), which is exactly what
// gas/lib/paths.js's parseDocPath() re-splits and validates when doGet later
// resolves a doc. Mirrors parseDocPath's exact rejection rule (no empty
// segments, no '.'/'..' segments) so a bad --path-in-repo fails HERE, before
// any Drive folder/file gets created for an address the web app could never
// serve, instead of "succeeding" into a row nothing can ever resolve.
export function validatePathInRepo(pathInRepo) {
  for (const seg of String(pathInRepo).split('/')) {
    if (seg.length === 0) throw new Error(`invalid --path-in-repo (empty path segment): ${pathInRepo}`);
    if (seg === '.' || seg === '..') throw new Error(`invalid --path-in-repo ('.'/'..' segment): ${pathInRepo}`);
  }
  return pathInRepo;
}

// Bug #5 fix: mirrors the pre-existing rootFolderId placeholder check so
// execUrl gets the same early, fail-fast treatment - checked in main()
// BEFORE any Drive/Sheets mutation, not after (previously execUrl was only
// read in Step 6, well after upload + companion-Sheet init had already run).
// Unanchored (not /^<DH_/): rootFolderId's placeholder IS the whole value
// (`<DH_ROOT_FOLDER_ID>`), but execUrl's placeholder is EMBEDDED mid-string
// (`https://script.google.com/macros/s/<DH_DEPLOYMENT_ID>/exec`, per the
// committed designhub.config.json template) - a real Drive id/URL never
// contains the literal substring "<DH_", so this stays safe for both.
export function findConfigProblem(config) {
  if (!config || /<DH_/.test(String(config.rootFolderId || ''))) return 'rootFolderId';
  if (!config.execUrl || /<DH_/.test(String(config.execUrl))) return 'execUrl';
  return null;
}

// Bug #6 fix: Markdown-aware asset scan, mirroring scanAssets' (publish-
// lib.mjs) HTML classification - an image embed is the ASSET-equivalent (a
// broken `![]()` 404s the <img> DesignHub's markdown renderer produces from
// it, exactly like a broken HTML img/script/link src does), a bare
// `[text](path)` link is the NAV-equivalent (only 404s on click). This is a
// small local relative-vs-absolute classifier rather than an import of
// publish-lib.mjs's own (unexported) REL - deliberately scoped to this file
// only, per this fix pass's file boundary.
const isRelativeTarget = (u) => !/^(https?:|#|data:|mailto:|\/\/)/i.test(u);
export function scanMdAssets(md) {
  const assets = [], links = [];
  const img = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const link = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = img.exec(md))) if (isRelativeTarget(m[1])) assets.push(m[1]);
  while ((m = link.exec(md))) if (isRelativeTarget(m[1])) links.push(m[1]);
  return { assets: [...new Set(assets)], links: [...new Set(links)] };
}

// Bug #8 fix: pure "patch the existing _index row" step, pulled out of
// main()'s Step 6 so the exact field list is unit-testable without a live
// Sheets call. Republishing a doc whose companion Sheet was deleted/
// recreated resolves a NEW companionId (Step 4's ensure()) - the pre-fix
// code patched title/url/jira/updatedAt on the existing row but never
// commentSheetId, so the bridge kept resolving comments against the
// stale/deleted sheet.
export function patchIndexRow(row, { title, url, jira, commentSheetId, now }, cols) {
  const next = row.slice();
  next[cols.indexOf('title')] = title;
  next[cols.indexOf('url')] = url;
  next[cols.indexOf('jira')] = jira;
  next[cols.indexOf('commentSheetId')] = commentSheetId;
  next[cols.indexOf('updatedAt')] = now;
  return next;
}

async function main() {
  // Config: the gitignored .local file (real org values, Task 8) wins; the
  // committed designhub.config.json is a generic placeholder template.
  const cfgLocal = new URL('../../../designhub.config.local.json', import.meta.url);
  const cfgMain = new URL('../../../designhub.config.json', import.meta.url);
  const CONFIG = JSON.parse(fs.readFileSync(fs.existsSync(cfgLocal) ? cfgLocal : cfgMain, 'utf8'));
  // Bug #5 fix: also validates execUrl (not just rootFolderId), and does so
  // here - before Steps 3-4 upload the doc and initialize the companion
  // Sheet - so a missing/placeholder execUrl can never lead to a broken
  // catalog link after Drive/Sheets have already been mutated.
  const cfgProblem = findConfigProblem(CONFIG);
  if (cfgProblem) {
    console.error(`designhub.config.local.json is missing (or has an unfilled placeholder for) ` +
      `${cfgProblem} - copy designhub.config.json next to it and fill the real values ` +
      '(see docs/designhub/plans/environment.local.md)');
    process.exit(2);
  }
  const SAD = 'supportsAllDrives=true';
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  const DRIVE = 'https://www.googleapis.com/drive/v3';

  const arg = (name, dflt) => {
    const i = process.argv.indexOf('--' + name);
    return i === -1 ? dflt : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true);
  };
  const USAGE = 'usage: publish.mjs --file <p> --repo <r> --feature <f> [--jira K-1] ' +
    '[--path-in-repo <p>] [--allow-assets] [--dry-run]';
  const FILE = arg('file');
  const REPO = arg('repo');
  const FEATURE = arg('feature');
  let JIRA, PATH_IN_REPO;
  try {
    requireString('file', FILE);
    requireString('repo', REPO);
    requireString('feature', FEATURE);
    JIRA = String(requireString('jira', arg('jira', 'unassigned')));
    // Bug #2 (tail) + Bug #7: requireString closes the "flag present, no
    // value" gap; validatePathInRepo closes the "value present but an
    // unresolvable . / .. path" gap - applied AFTER the ./ strip below,
    // matching parseDocPath, which never sees a leading ./ either.
    PATH_IN_REPO = validatePathInRepo(
      String(requireString('path-in-repo', arg('path-in-repo', FILE))).replace(/^\.\//, ''));
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }
  const FEATURE_DIR = featureDir(FEATURE);   // D14 (publish-lib mirror, test-pinned to gas/lib/paths.js)
  const FILE_NAME = path.basename(FILE);
  const IS_MD = /\.md$/i.test(FILE_NAME);
  const DOC_PATH = [REPO, FEATURE_DIR, ...PATH_IN_REPO.split('/')].join('/');
  const content = fs.readFileSync(FILE, 'utf8');
  const now = new Date().toISOString();

  // ---- 1. self-contained scan (v1 contract, two severities - poc2 learning) ----
  // Bug #6 fix: previously gated with `if (!IS_MD)`, so a Markdown doc with
  // a broken relative asset (e.g. `![diagram](./arch.png)`) published
  // successfully and then rendered broken - DesignHub serves one Drive
  // file, no asset route. scanMdAssets (above) gives Markdown the same
  // classification scanAssets gives HTML; both paths hit the same gate.
  const { assets, links } = IS_MD ? scanMdAssets(content) : scanAssets(content);
  if (links.length) console.warn('WARN relative nav links (will 404 in DesignHub): ' + links.join(', '));
  if (assets.length) {
    console.error('BLOCK relative ASSET refs (page would render broken): ' + assets.join(', '));
    if (!arg('allow-assets')) { console.error('re-run with --allow-assets to publish anyway'); process.exit(3); }
  }
  if (arg('dry-run')) { console.log(JSON.stringify({ DOC_PATH, FEATURE_DIR, ok: true })); process.exit(0); }

  const at = await accessToken();
  // Bug #3 fix: files.list defaults to corpora=user (only items the CALLER
  // has personally "opened") when no explicit corpora is given - it silently
  // misses Shared Drive children the caller has never individually opened,
  // even though rootFolderId lives on (and this script exclusively operates
  // within) a Shared Drive. Resolve rootFolderId's driveId once and scope
  // every files.list call (via q()/child() below) to
  // corpora=drive&driveId=<id> - the documented way to see the FULL
  // contents of a specific Shared Drive. Falls back to the broader
  // corpora=allDrives if rootFolderId unexpectedly has no driveId, rather
  // than failing outright.
  const rootMeta = await api(at, `${DRIVE}/files/${CONFIG.rootFolderId}?fields=driveId&${SAD}`);
  const LIST = rootMeta.driveId
    ? `${SAD}&includeItemsFromAllDrives=true&corpora=drive&driveId=${rootMeta.driveId}`
    : `${SAD}&includeItemsFromAllDrives=true&corpora=allDrives`;
  const q = async (query) => (await api(at, `${DRIVE}/files?q=${encodeURIComponent(query)}&${LIST}&fields=files(id,name),nextPageToken`)).files;
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
  const url = docUrl(CONFIG.execUrl, DOC_PATH);
  const ID_COL = INDEX_COLS.indexOf('driveFileId');
  // D19 direct-upsert decision (see 00-overview.md "Two items for whoever
  // executes Task 6 and Task 10", item 2, and publish-lib.mjs's upsertRowIndex
  // comment for the full reasoning): this find-by-key lookup is the same
  // decision gas/lib/rollup.js's upsertRow tests, factored out because
  // publish.mjs cannot import that GAS-side file (self-containment) and this
  // exact lookup is needed twice (here and in Step 7 below) against different
  // in-memory row arrays.
  //
  // Bug #9 best-effort mitigation (documented as such - NOT full mutual
  // exclusion; a real fix needs a server-side lock, e.g. a new Apps Script
  // bridge function using LockService): indexRows was read back in Step 2,
  // an upload and several Sheets round-trips ago - re-read it fresh here,
  // as close as possible to the write, to shrink (not close) the window
  // where a concurrent publish of the SAME doc could append its own row in
  // between. Read-then-write is still not atomic, so the post-write
  // self-heal pass below catches whatever slips through anyway.
  indexRows = await valsOrNull(indexId, 'index!A2:N') ?? [];
  const rowIdx = upsertRowIndex(indexRows, ID_COL, doc.id);
  let indexRow;
  if (rowIdx === -1) {
    indexRow = newIndexRow({ type: IS_MD ? 'md' : 'html', title: title.trim(), repo: REPO,
      feature: FEATURE, jira: JIRA, owner: me, driveFileId: doc.id,
      commentSheetId: companionId, url, now });
    await appendVals(indexId, 'index!A:N', [indexRow]);
  } else {
    // Bug #8 fix: patchIndexRow also refreshes commentSheetId - previously
    // only title/url/jira/updatedAt were rewritten here, so a republish
    // whose companion Sheet had been deleted/recreated (new companionId
    // from Step 4's ensure(), above) left the bridge resolving comments
    // against the stale/deleted sheet id.
    indexRow = patchIndexRow(indexRows[rowIdx],
      { title: title.trim(), url, jira: JIRA, commentSheetId: companionId, now }, INDEX_COLS);
    await putVals(indexId, `index!A${rowIdx + 2}:N${rowIdx + 2}`, [indexRow]);
  }

  // Bug #9 (cont.) - best-effort post-write self-heal: if a concurrent
  // publish still snuck in a second row for this driveFileId despite the
  // re-read above, delete the extra row(s), keeping the first. Documented
  // mitigation only, not a substitute for a server-side lock (see comment
  // above Step 6).
  {
    const rows = await getVals(indexId, 'index!A2:N');
    const dupes = rows.reduce((acc, r, i) => (r[ID_COL] === doc.id ? [...acc, i] : acc), []);
    if (dupes.length > 1) {
      const idxMeta = await api(at, `${SHEETS}/${indexId}?fields=sheets(properties(sheetId,title))`);
      const sheetId = idxMeta.sheets.find((s) => s.properties.title === 'index').properties.sheetId;
      // Delete from the bottom up: each deleteDimension request in this
      // batch is applied against the sheet state left by the PRECEDING
      // requests in the same batch, so higher row indices must go first or
      // they'd shift out from under a lower-index request queued after them.
      const requests = dupes.slice(1).sort((a, b) => b - a).map((i) => ({
        deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: i + 1, endIndex: i + 2 } } }));
      await api(at, `${SHEETS}/${indexId}:batchUpdate`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }) });
      console.warn(`race mitigation (Bug #9, best-effort): removed ${requests.length} duplicate ` +
        `_index row(s) for driveFileId ${doc.id} - a real fix needs a server-side lock`);
    }
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
}

// Only run the CLI flow when this file is executed directly (`node
// publish.mjs ...`), not when it's imported - e.g. by unit tests that just
// want the pure helpers above. Without this guard, merely importing the
// module would run argv validation (exit(2) with no args) and try to read
// designhub.config.local.json (exit(2) if that file, or its checked-in
// placeholder fallback, isn't filled in) before a single test could run.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();
