const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../gas/lib/schema.js');

test('ticket columns match design.md section 5 exactly', () => {
  assert.deepEqual(S.TICKET_COLS, ['id', 'parentId', 'type', 'status', 'quote',
    'context', 'section', 'note', 'authorEmail', 'authorName', 'source',
    'docVersion', 'result', 'files', 'createdAt', 'updatedAt']);
});

test('index columns match design.md section 4 exactly', () => {
  assert.deepEqual(S.INDEX_COLS, ['id', 'type', 'title', 'repo', 'feature',
    'jira', 'tags', 'owner', 'driveFileId', 'commentSheetId', 'url', 'status',
    'publishedAt', 'updatedAt']);
});

test('rowToTicket and ticketToRow round-trip', () => {
  const t = { id: 'u1', parentId: '', type: 'comment', status: 'open',
    quote: 'q', context: 'c', section: 's', note: 'n',
    authorEmail: 'a@example.com', authorName: '', source: 'web', docVersion: '',
    result: '', files: '', createdAt: 't1', updatedAt: 't2' };
  assert.deepEqual(S.rowToTicket(S.ticketToRow(t)), t);
});

test('rowToTicket tolerates short rows (Sheets trims trailing empties)', () => {
  const t = S.rowToTicket(['u1', '', 'comment', 'open', 'q']);
  assert.equal(t.note, '');
  assert.equal(t.updatedAt, '');
});

test('rowToIndex and indexToRow round-trip', () => {
  const i = { id: 'u1', type: 'html', title: 'T', repo: 'r', feature: 'f',
    jira: 'unassigned', tags: '', owner: 'me@example.com', driveFileId: 'F',
    commentSheetId: 'C', url: 'U', status: 'active',
    publishedAt: 't1', updatedAt: 't2' };
  assert.deepEqual(S.rowToIndex(S.indexToRow(i)), i);
});

test('rowToIndex tolerates short rows (Sheets trims trailing empties)', () => {
  const i = S.rowToIndex(['u1', 'html', 'T']);
  assert.equal(i.driveFileId, '');
  assert.equal(i.updatedAt, '');
});

test('knowledge columns match the Knowledge Portal design (section 4.2) exactly', () => {
  assert.deepEqual(S.KNOWLEDGE_COLS, ['id', 'type', 'title', 'path', 'url',
    'driveFileId', 'owner', 'tags', 'source', 'status', 'modifiedTime',
    'syncedAt', 'createdAt', 'updatedAt']);
});

test('rowToKnowledge and knowledgeToRow round-trip', () => {
  const k = { id: 'F1', type: 'gdoc', title: 'T', path: 'Research/CRM', url: 'U',
    driveFileId: 'F1', owner: 'a@example.com', tags: '', source: 'drive-sync',
    status: 'active', modifiedTime: 't0', syncedAt: 't1', createdAt: 't2', updatedAt: 't3' };
  assert.deepEqual(S.rowToKnowledge(S.knowledgeToRow(k)), k);
});

test('rowToKnowledge tolerates short rows (Sheets trims trailing empties)', () => {
  const k = S.rowToKnowledge(['F1', 'gdoc', 'T']);
  assert.equal(k.driveFileId, '');
  assert.equal(k.updatedAt, '');
});

test('widgetStatus maps DesignHub lifecycle to widget board states', () => {
  // widget knows: todo | in-progress | error | done (ORDER map in feedback-widget.html)
  assert.equal(S.widgetStatus('open'), 'todo');
  assert.equal(S.widgetStatus('in-progress'), 'in-progress');
  assert.equal(S.widgetStatus('resolved'), 'done');
  assert.equal(S.widgetStatus('declined'), 'error');
  assert.equal(S.widgetStatus('anchor-lost'), 'error');
  assert.equal(S.widgetStatus('bogus'), 'todo');
});

test('VALID_STATUSES gates setStatus input', () => {
  assert.ok(S.VALID_STATUSES.includes('open'));
  assert.ok(S.VALID_STATUSES.includes('anchor-lost'));
  assert.ok(!S.VALID_STATUSES.includes('done'));
});

// The widget's per-card ✕ (discard) is wired (build-designhub.js R7) to
// setStatus(..., 'deleted') for already-submitted tickets, so a click removes
// it for everyone, not just the clicker's tab - bridge.js's listComments
// filters 'deleted' rows out entirely rather than mapping them to a widget
// board state (there's no "deleted" column in the widget's own status set).
test('deleted is a valid status (real removal, not a widget board state)', () => {
  assert.ok(S.VALID_STATUSES.includes('deleted'));
  assert.equal(S.widgetStatus('deleted'), 'todo',
    'unmapped by design - listComments filters deleted rows before this is ever called');
});
