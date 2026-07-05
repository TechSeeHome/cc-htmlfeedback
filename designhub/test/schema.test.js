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
