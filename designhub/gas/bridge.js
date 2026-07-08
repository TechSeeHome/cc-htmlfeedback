// The google.script.run bridge (design section 5). Note: section 5 also lists
// getDoc(path); in v1 doc retrieval IS doGet(?doc=path) - a bridge getDoc has
// no consumer until a client-side router exists, so it is deliberately absent.
// D17 containment: this file is the ONLY privileged surface doc scripts can
// reach. It must never grow beyond comment-Sheet rows + catalog reads, and
// every mutating call stamps identity server-side from the session.

function getIdentity(clientClaim) {
  return { server: Session.getActiveUser().getEmail(), clientClaim: clientClaim || null };
}

function listCatalog(filter) {
  var rows = dhPortalRows_();
  if (filter && filter.repo) rows = rows.filter(function (r) { return r.repo === filter.repo; });
  return { rows: rows };
}

// Returns tickets in the WIDGET's shape: page keyed by docPath, status mapped
// to board states, replies excluded (v1 widget shows top-level tickets only;
// threads live in the Sheet and the agent docs).
function listComments(docPath) {
  var c = dhCommentsFor_(docPath);
  var values = c.ss.getSheetByName('tickets').getDataRange().getValues().slice(1);
  // 'deleted' rows stay in the Sheet (setStatus's audit-tab log preserves who/when -
  // D17(c)) but never reach the widget for anyone - this is how the widget's
  // per-card discard() becomes a real removal instead of a per-tab-only hide.
  var tickets = values.map(function (row) { return DH_SCHEMA.rowToTicket(row); })
    .filter(function (t) { return !t.parentId && t.status !== 'deleted'; })
    .map(function (t) {
      return { id: t.id, quote: t.quote, context: t.context, section: t.section,
        note: t.note, type: t.type, page: docPath,
        // rawStatus: the lifecycle value before widgetStatus's lossy board-state
        // mapping (WIDGET_STATUS folds both 'declined' and 'anchor-lost' into
        // 'error') - callers that need to tell them apart use this instead.
        status: DH_SCHEMA.widgetStatus(t.status), rawStatus: t.status,
        result: t.result, files: DH_SCHEMA.filesToArray(t.files) };
    });
  return { tickets: tickets };
}

function submitComment(docPath, ticket) {
  ticket = ticket || {};
  var c = dhCommentsFor_(docPath);
  var now = new Date().toISOString();
  var t = { id: Utilities.getUuid(), parentId: '', type: ticket.type === 'strike' ? 'strike' : 'comment',
    status: 'open', quote: DH_SCHEMA.sanitizeField(ticket.quote),
    context: DH_SCHEMA.sanitizeField(ticket.context),
    section: DH_SCHEMA.sanitizeField(ticket.section),
    note: DH_SCHEMA.sanitizeField(ticket.note),
    authorEmail: Session.getActiveUser().getEmail(),   // client-supplied identity ignored (D17)
    authorName: '', source: 'web', docVersion: String(c.indexRow.updatedAt || ''),
    result: '', files: '', createdAt: now, updatedAt: now };
  c.ss.getSheetByName('tickets').appendRow(DH_SCHEMA.ticketToRow(t));
  return { id: t.id };
}

function reply(docPath, parentId, note) {
  var c = dhCommentsFor_(docPath);
  var now = new Date().toISOString();
  var t = { id: Utilities.getUuid(), parentId: String(parentId || ''), type: 'reply',
    status: 'open', quote: '', context: '', section: '', note: DH_SCHEMA.sanitizeField(note),
    authorEmail: Session.getActiveUser().getEmail(), authorName: '', source: 'web',
    docVersion: '', result: '', files: '', createdAt: now, updatedAt: now };
  c.ss.getSheetByName('tickets').appendRow(DH_SCHEMA.ticketToRow(t));
  return { id: t.id };
}

function setStatus(docPath, id, status) {
  if (DH_SCHEMA.VALID_STATUSES.indexOf(status) === -1) throw new Error('invalid status: ' + status);
  var c = dhCommentsFor_(docPath);
  var sheet = c.ss.getSheetByName('tickets');
  var email = Session.getActiveUser().getEmail();
  var now = new Date().toISOString();
  var ID = DH_SCHEMA.TICKET_COLS.indexOf('id');
  var STATUS = DH_SCHEMA.TICKET_COLS.indexOf('status');
  var UPDATED = DH_SCHEMA.TICKET_COLS.indexOf('updatedAt');
  // Lock-protected: the status setValue and the updatedAt setValue are two
  // separate calls, and reading the prior status happens before either -
  // without a lock, two concurrent setStatus calls on the same ticket can
  // interleave those reads/writes (e.g. both read the same old status, or
  // one's status write lands between the other's status and updatedAt
  // writes), corrupting either the row or the audit trail.
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (values[i][ID] === id) {
        var oldStatus = values[i][STATUS];
        sheet.getRange(i + 1, STATUS + 1).setValue(status);
        sheet.getRange(i + 1, UPDATED + 1).setValue(now);
        // D17(c): status changes land in the audit history (meta tab), so forged
        // or surprising activity is detectable and reversible. Recording the
        // prior value (not just the new one) makes the log actually useful for
        // reconstructing history instead of just the latest transition.
        c.ss.getSheetByName('meta').appendRow(['', '', '', '', '', '', email, now,
          'setStatus ' + id + ': ' + oldStatus + ' -> ' + status]);
        return { id: id, status: status };
      }
    }
    throw new Error('ticket not found: ' + id);
  } finally {
    lock.releaseLock();
  }
}
