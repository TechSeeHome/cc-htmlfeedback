// POC-5 live driver against the real Shared Drive (DesignHub-POC).
//
//   node run-live.mjs upsert '<json row array>'   candidate A: publish-time direct upsert
//   node run-live.mjs rebuild                     reconciler: rebuild rollup from all _index shards
//   node run-live.mjs show                        print rollup rows
//   node run-live.mjs clear                       wipe rollup data rows (simulates corruption)
//
// Uses the same auth as poc2 (igora@ refresh token).

import fs from 'node:fs';
import { buildRollup, INDEX_COLS } from './rollup-lib.mjs';

const TOKEN_FILE = '/Users/igor/.claude/skills/gdoc-md-sync/token.json';
const POC_ROOT = '1TgoFYQddjDZXc8O0eVH-W3Rx9NVO5a0V'; // DesignHub-POC
const SAD = 'supportsAllDrives=true';
const LIST = `${SAD}&includeItemsFromAllDrives=true`;
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

let ACCESS_TOKEN;
async function auth() {
  const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: t.client_id, client_secret: t.client_secret,
      refresh_token: t.refresh_token, grant_type: 'refresh_token' }),
  });
  ACCESS_TOKEN = (await r.json()).access_token;
}
async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${url} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

async function ensureRollup() {
  const q = encodeURIComponent(`'${POC_ROOT}' in parents and name = '_portal-index' and trashed = false`);
  const r = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&${LIST}&fields=files(id)`);
  if (r.files.length) return r.files[0].id;
  const c = await api(`https://www.googleapis.com/drive/v3/files?${SAD}&fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '_portal-index', mimeType: 'application/vnd.google-apps.spreadsheet', parents: [POC_ROOT] }),
  });
  await api(`${SHEETS}/${c.id}/values/${encodeURIComponent('A1:N1')}?valueInputOption=RAW`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [INDEX_COLS] }),
  });
  return c.id;
}

const getRows = async (id, tab = 'Sheet1') =>
  (await api(`${SHEETS}/${id}/values/${encodeURIComponent(tab + '!A2:N')}`)).values ?? [];

async function writeAllRows(id, rows) {
  await api(`${SHEETS}/${id}/values/${encodeURIComponent('Sheet1!A2:N10000')}:clear`, { method: 'POST' });
  if (rows.length) {
    await api(`${SHEETS}/${id}/values/${encodeURIComponent('Sheet1!A2')}?valueInputOption=RAW`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: rows }),
    });
  }
}

// BFS the POC tree for feature _index shards (the rollup itself lives at the
// root as _portal-index and is excluded).
async function findShards() {
  const shards = [];
  const queue = [POC_ROOT];
  while (queue.length) {
    const parent = queue.shift();
    const q = encodeURIComponent(`'${parent}' in parents and trashed = false`);
    const r = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&${LIST}&fields=files(id,name,mimeType)`);
    for (const f of r.files) {
      if (f.mimeType === 'application/vnd.google-apps.folder') queue.push(f.id);
      else if (f.name === '_index' && f.mimeType === 'application/vnd.google-apps.spreadsheet') shards.push(f.id);
    }
  }
  return shards;
}

await auth();
const rollupId = await ensureRollup();
const mode = process.argv[2];

if (mode === 'upsert') {
  const row = JSON.parse(process.argv[3]);
  // publish-time candidate A: read-modify-write keyed by driveFileId; new keys
  // use the atomic :append (no clobber under concurrency for distinct keys)
  const KEY = INDEX_COLS.indexOf('driveFileId');
  const rows = await getRows(rollupId);
  const i = rows.findIndex((r) => r[KEY] === row[KEY]);
  if (i === -1) {
    await api(`${SHEETS}/${rollupId}/values/${encodeURIComponent('Sheet1!A:N')}:append?valueInputOption=RAW`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] }),
    });
    console.log(`upsert(${row[KEY]}): appended`);
  } else {
    await api(`${SHEETS}/${rollupId}/values/${encodeURIComponent(`Sheet1!A${i + 2}:N${i + 2}`)}?valueInputOption=RAW`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] }),
    });
    console.log(`upsert(${row[KEY]}): updated row ${i + 2}`);
  }
} else if (mode === 'rebuild') {
  const shardIds = await findShards();
  const shards = [];
  for (const id of shardIds) shards.push(await getRows(id, 'index'));
  const rows = buildRollup(shards);
  await writeAllRows(rollupId, rows);
  console.log(`rebuild: ${shardIds.length} shard(s) -> ${rows.length} rollup row(s)`);
} else if (mode === 'show') {
  const rows = await getRows(rollupId);
  const KEY = INDEX_COLS.indexOf('driveFileId');
  console.log(rows.map((r) => ({ key: r[KEY], title: r[2], feature: r[4], updatedAt: r[13] })));
} else if (mode === 'clear') {
  await writeAllRows(rollupId, []);
  console.log('rollup data rows cleared (corruption simulated)');
} else {
  throw new Error('mode: upsert | rebuild | show | clear');
}
