const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mimeToType,
  planSync,
  planRewriteRanges,
  planTabsEnsure,
} = require('../gas/lib/knowledge.js');

function driveFile(over) {
  return Object.assign(
    {
      id: 'F1',
      name: 'Doc',
      mimeType: 'application/vnd.google-apps.document',
      path: 'Research',
      url: 'https://drive/F1',
      owner: 'a@example.com',
      modifiedTime: '2026-01-01T00:00:00.000Z',
      trashed: false,
    },
    over
  );
}
function row(over) {
  return Object.assign(
    {
      id: 'F1',
      type: 'gdoc',
      title: 'Doc',
      path: 'Research',
      url: 'https://drive/F1',
      driveFileId: 'F1',
      owner: 'a@example.com',
      tags: '',
      source: 'drive-sync',
      status: 'active',
      modifiedTime: '2026-01-01T00:00:00.000Z',
      syncedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    over
  );
}
const NOW = '2026-02-01T00:00:00.000Z';

test('mimeToType maps every documented Google type', () => {
  assert.equal(mimeToType('application/vnd.google-apps.document'), 'gdoc');
  assert.equal(mimeToType('application/vnd.google-apps.spreadsheet'), 'gsheet');
  assert.equal(mimeToType('application/vnd.google-apps.presentation'), 'gslides');
  assert.equal(mimeToType('application/vnd.google-apps.folder'), 'gfolder');
});

test('mimeToType maps pdf and office powerpoint variants', () => {
  assert.equal(mimeToType('application/pdf'), 'pdf');
  assert.equal(
    mimeToType('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    'pptx'
  );
  assert.equal(mimeToType('application/vnd.ms-powerpoint'), 'pptx');
});

test('mimeToType maps image/video/audio by prefix, any subtype', () => {
  assert.equal(mimeToType('image/png'), 'image');
  assert.equal(mimeToType('image/jpeg'), 'image');
  assert.equal(mimeToType('video/mp4'), 'video');
  assert.equal(mimeToType('audio/mpeg'), 'audio');
});

test('mimeToType falls back to file for unknown, empty, or missing MIME types', () => {
  assert.equal(mimeToType('application/vnd.google-apps.script'), 'file');
  assert.equal(mimeToType('application/octet-stream'), 'file');
  assert.equal(mimeToType(''), 'file');
  assert.equal(mimeToType(undefined), 'file');
});

test('planSync creates a new drive-sync row for a file never seen before', () => {
  const plan = planSync([], [driveFile()], { now: NOW });
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.stats.created, 1);
  assert.equal(plan.stats.updated, 0);
  const r = plan.rows[0];
  assert.equal(r.type, 'gdoc');
  assert.equal(r.source, 'drive-sync');
  assert.equal(r.status, 'active');
  assert.equal(r.createdAt, NOW);
  assert.equal(r.syncedAt, NOW);
  assert.equal(r.updatedAt, NOW);
});

test('planSync shapes rows with exactly the KNOWLEDGE_COLS keys (schema round-trip)', () => {
  const { KNOWLEDGE_COLS, rowToKnowledge, knowledgeToRow } = require('../gas/lib/schema.js');
  const plan = planSync([], [driveFile()], { now: NOW });
  const roundTripped = rowToKnowledge(knowledgeToRow(plan.rows[0]));
  assert.deepEqual(roundTripped, plan.rows[0]);
  assert.deepEqual(Object.keys(plan.rows[0]).sort(), [...KNOWLEDGE_COLS].sort());
});

test('planSync is a no-op update (unchanged) when nothing about the file changed, but bumps syncedAt', () => {
  const existing = [row({ syncedAt: '2026-01-15T00:00:00.000Z' })];
  const plan = planSync(existing, [driveFile()], { now: NOW });
  assert.equal(plan.stats.created, 0);
  assert.equal(plan.stats.updated, 0);
  assert.equal(plan.stats.unchanged, 1);
  const r = plan.rows[0];
  assert.equal(r.updatedAt, existing[0].updatedAt); // preserved, not bumped
  assert.equal(r.syncedAt, NOW); // bumped - this run re-confirmed it
  assert.equal(r.createdAt, existing[0].createdAt); // preserved
});

test('planSync counts updated and bumps updatedAt when title/path/owner changed', () => {
  const existing = [row({ title: 'Old title' })];
  const plan = planSync(existing, [driveFile({ name: 'New title' })], { now: NOW });
  assert.equal(plan.stats.updated, 1);
  assert.equal(plan.stats.created, 0);
  assert.equal(plan.rows[0].title, 'New title');
  assert.equal(plan.rows[0].updatedAt, NOW);
  assert.equal(plan.rows[0].createdAt, existing[0].createdAt); // still preserved
});

test('planSync preserves curator-set tags across a sync (v2 hook, never written by the walk)', () => {
  const existing = [row({ tags: 'onboarding,eng' })];
  const plan = planSync(existing, [driveFile()], { now: NOW });
  assert.equal(plan.rows[0].tags, 'onboarding,eng');
});

test('planSync flags a drive-sync row stale when its file is missing from the walk (K7)', () => {
  const existing = [row()];
  const plan = planSync(existing, [], { now: NOW });
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.stats.staled, 1);
  assert.equal(plan.rows[0].status, 'stale');
  assert.equal(plan.rows[0].updatedAt, NOW);
  assert.equal(plan.rows[0].syncedAt, NOW);
});

test('planSync flags a drive-sync row stale when the walk reports it trashed', () => {
  const existing = [row()];
  const plan = planSync(existing, [driveFile({ trashed: true })], { now: NOW });
  assert.equal(plan.stats.staled, 1);
  assert.equal(plan.rows[0].status, 'stale');
});

test('planSync re-activates a stale row whose file reappears live in the walk', () => {
  const existing = [row({ status: 'stale' })];
  const plan = planSync(existing, [driveFile()], { now: NOW });
  assert.equal(plan.rows[0].status, 'active');
  assert.equal(plan.stats.created, 0);
  assert.equal(plan.stats.updated, 1); // status stale -> active counts as a real change
});

test('planSync does not re-count a row that stays stale across runs, but still bumps syncedAt', () => {
  const existing = [row({ status: 'stale', updatedAt: '2026-01-10T00:00:00.000Z' })];
  const plan = planSync(existing, [], { now: NOW });
  assert.equal(plan.stats.staled, 0); // already stale - no NEW staling to report
  assert.equal(plan.rows[0].updatedAt, '2026-01-10T00:00:00.000Z'); // not re-bumped
  assert.equal(plan.rows[0].syncedAt, NOW);
});

test('planSync never touches source=manual rows - byte-identical output, no field stamped', () => {
  const manual = {
    id: 'M1',
    type: 'link',
    title: 'Wiki',
    path: 'Research',
    url: 'https://wiki',
    driveFileId: '',
    owner: 'curator@example.com',
    tags: 'onboarding',
    source: 'manual',
    status: 'active',
    modifiedTime: '',
    syncedAt: '',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
  const plan = planSync([manual, row()], [driveFile()], { now: NOW });
  const out = plan.rows.find((r) => r.id === 'M1');
  assert.deepEqual(out, manual);
});

test('planSync handles multiple files independently (create + update + stale in one run)', () => {
  const existing = [
    row({ id: 'F1', driveFileId: 'F1', title: 'Stays same' }),
    row({ id: 'F2', driveFileId: 'F2', title: 'Old name' }),
    row({ id: 'F3', driveFileId: 'F3', title: 'Goes missing' }),
  ];
  const walk = [
    driveFile({ id: 'F1', name: 'Stays same' }),
    driveFile({ id: 'F2', name: 'New name' }),
    driveFile({ id: 'F4', name: 'Brand new' }),
  ];
  const plan = planSync(existing, walk, { now: NOW });
  assert.equal(plan.stats.created, 1);
  assert.equal(plan.stats.updated, 1);
  assert.equal(plan.stats.unchanged, 1);
  assert.equal(plan.stats.staled, 1);
  assert.equal(plan.rows.length, 4);
  assert.equal(plan.rows.find((r) => r.driveFileId === 'F3').status, 'stale');
  assert.equal(plan.rows.find((r) => r.driveFileId === 'F4').type, 'gdoc');
});

test('planSync is idempotent: replanning from its own output over the same walk converges', () => {
  const existing = [row({ title: 'Old' })];
  const first = planSync(existing, [driveFile({ name: 'New' })], { now: NOW });
  const LATER = '2026-03-01T00:00:00.000Z';
  const second = planSync(first.rows, [driveFile({ name: 'New' })], { now: LATER });
  assert.equal(second.stats.updated, 0);
  assert.equal(second.stats.unchanged, 1);
  assert.equal(second.rows[0].title, 'New');
  assert.equal(second.rows[0].updatedAt, first.rows[0].updatedAt); // unchanged since first run
  assert.equal(second.rows[0].syncedAt, LATER);
});

test('planSync tolerates empty existing rows and empty walk (fresh Sheet, empty drive)', () => {
  assert.deepEqual(planSync([], [], { now: NOW }), {
    rows: [],
    stats: { created: 0, updated: 0, unchanged: 0, staled: 0 },
  });
});

test('planSync defaults now to the current time when opts is omitted', () => {
  const before = Date.now();
  const plan = planSync([], [driveFile()]);
  const stamped = Date.parse(plan.rows[0].createdAt);
  assert.ok(stamped >= before && stamped <= Date.now() + 1000);
});

// Formula-injection defense (P2 review finding): a Drive file/folder name or
// path starting with =,+,-,@ must not reach the planned row raw - Sheets
// would parse it as a formula once refreshKnowledge writes it with setValues.
test('planSync sanitizes a title starting with = so Sheets cannot parse it as a formula', () => {
  const plan = planSync(
    [],
    [driveFile({ name: '=HYPERLINK("http://evil.example","click")', path: '=EvilFolder/Sub' })],
    { now: NOW }
  );
  assert.equal(plan.rows[0].title, '\'=HYPERLINK("http://evil.example","click")');
  assert.equal(plan.rows[0].path, "'=EvilFolder/Sub");
});

test('planSync sanitizes a title starting with + so Sheets cannot parse it as a formula', () => {
  const plan = planSync([], [driveFile({ name: '+SUM(A1)', path: '+EvilFolder' })], { now: NOW });
  assert.equal(plan.rows[0].title, "'+SUM(A1)");
  assert.equal(plan.rows[0].path, "'+EvilFolder");
});

test('planSync sanitizes an owner starting with - or @ the same way', () => {
  const plan = planSync([], [driveFile({ owner: '-drop@example.com' })], { now: NOW });
  assert.equal(plan.rows[0].owner, "'-drop@example.com");
});

test('planSync leaves safe titles/paths/owners untouched (no spurious apostrophe)', () => {
  const plan = planSync([], [driveFile()], { now: NOW });
  assert.equal(plan.rows[0].title, 'Doc');
  assert.equal(plan.rows[0].path, 'Research');
  assert.equal(plan.rows[0].owner, 'a@example.com');
});

// Write-then-trim range math (P2 review, chatgpt-codex-connector thread
// PRRT_kwDOTLZBvs6QJ9lW) - refreshKnowledge must write the new rows before
// trimming any leftover old rows, never clear first, so a crash mid-write
// never leaves the `links` tab (and its source=manual rows) empty.
test('planRewriteRanges: new set shorter than old - writes new rows then trims the leftover tail', () => {
  const ranges = planRewriteRanges(5, 3);
  assert.deepEqual(ranges.write, { row: 2, numRows: 3 });
  assert.deepEqual(ranges.trim, { row: 5, numRows: 2 });
});

test('planRewriteRanges: new set longer than old - writes new rows, no trim needed', () => {
  const ranges = planRewriteRanges(3, 5);
  assert.deepEqual(ranges.write, { row: 2, numRows: 5 });
  assert.equal(ranges.trim, null);
});

test('planRewriteRanges: new set same length as old - writes new rows, no trim needed', () => {
  const ranges = planRewriteRanges(4, 4);
  assert.deepEqual(ranges.write, { row: 2, numRows: 4 });
  assert.equal(ranges.trim, null);
});

test('planRewriteRanges: new set empty but old rows existed - no write, trims the whole old range', () => {
  const ranges = planRewriteRanges(5, 0);
  assert.equal(ranges.write, null);
  assert.deepEqual(ranges.trim, { row: 2, numRows: 5 });
});

test('planRewriteRanges: both empty (fresh sheet, nothing to sync) - no write, no trim', () => {
  const ranges = planRewriteRanges(0, 0);
  assert.equal(ranges.write, null);
  assert.equal(ranges.trim, null);
});

test('planRewriteRanges: old empty, new has rows - writes new rows, no trim needed', () => {
  const ranges = planRewriteRanges(0, 3);
  assert.deepEqual(ranges.write, { row: 2, numRows: 3 });
  assert.equal(ranges.trim, null);
});

test('planRewriteRanges defaults missing counts to 0', () => {
  assert.deepEqual(planRewriteRanges(undefined, 3), { write: { row: 2, numRows: 3 }, trim: null });
  assert.deepEqual(planRewriteRanges(5, undefined), { write: null, trim: { row: 2, numRows: 5 } });
});

// Idempotent-ensure decision for dhKnowledgeSheetEnsure_ (drive.js) - the
// production bug this guards against: a spreadsheet created by the Node
// importer (home-rnd-productivity-v2) has ONLY a `links` tab, and the old
// ensure function's early-return-if-exists never checked for `meta` at all,
// so refreshKnowledge (bridge.js) crashed appending the audit row.
test('planTabsEnsure: brand-new spreadsheet (no sheets match yet) needs both tabs', () => {
  assert.deepEqual(planTabsEnsure(['Sheet1']), { needsLinks: true, needsMeta: true });
});

test('planTabsEnsure: importer-created spreadsheet has links but no meta - the production bug', () => {
  assert.deepEqual(planTabsEnsure(['links']), { needsLinks: false, needsMeta: true });
});

test('planTabsEnsure: both tabs already present - nothing to do', () => {
  assert.deepEqual(planTabsEnsure(['links', 'meta']), { needsLinks: false, needsMeta: false });
});

test('planTabsEnsure: extra unrelated tabs do not confuse the check', () => {
  assert.deepEqual(planTabsEnsure(['links', 'meta', 'Sheet1']), {
    needsLinks: false,
    needsMeta: false,
  });
});

test('planTabsEnsure defaults missing/undefined sheet-name list to needing both tabs', () => {
  assert.deepEqual(planTabsEnsure(undefined), { needsLinks: true, needsMeta: true });
  assert.deepEqual(planTabsEnsure([]), { needsLinks: true, needsMeta: true });
});
