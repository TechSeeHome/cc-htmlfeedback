// DesignHub sheet schemas (design.md section 4 + 5) and the mapping between
// DesignHub ticket lifecycle (D12) and the upstream widget's board states.
// Plain GAS script + guarded CommonJS export (dual-use: clasp and node --test).
var DH_SCHEMA = (function () {
  var TICKET_COLS = ['id', 'parentId', 'type', 'status', 'quote', 'context',
    'section', 'note', 'authorEmail', 'authorName', 'source', 'docVersion',
    'result', 'files', 'createdAt', 'updatedAt'];
  var INDEX_COLS = ['id', 'type', 'title', 'repo', 'feature', 'jira', 'tags',
    'owner', 'driveFileId', 'commentSheetId', 'url', 'status', 'publishedAt',
    'updatedAt'];
  var META_COLS = ['repo', 'pathInRepo', 'branch', 'commitSha', 'pr', 'jira',
    'publisher', 'publishedAt', 'note'];
  var VALID_STATUSES = ['open', 'in-progress', 'resolved', 'declined', 'anchor-lost', 'deleted'];
  var WIDGET_STATUS = { open: 'todo', 'in-progress': 'in-progress',
    resolved: 'done', declined: 'error', 'anchor-lost': 'error' };

  function rowToObj(cols, row) {
    var o = {};
    for (var i = 0; i < cols.length; i++) o[cols[i]] = row[i] === undefined ? '' : row[i];
    return o;
  }
  function objToRow(cols, o) {
    return cols.map(function (c) { return o[c] === undefined ? '' : o[c]; });
  }

  // Formula/CSV injection defense: a user-supplied string that starts with
  // one of =,+,-,@ is interpreted by Sheets (appendRow/setValues mimic
  // typed-in-the-UI parsing) as a formula, not literal text. Prefixing a
  // leading apostrophe is the standard "force text" marker - Sheets strips
  // it on commit for exactly this class of leading character, so the value
  // read back later (listComments, the audit tab, a REST GET by an agent)
  // is the original text, not `'=...`. Call this on every free-text field
  // before it reaches appendRow (bridge.js's submitComment/reply) - one
  // place so no call site can forget it.
  var UNSAFE_LEADING = /^[=+\-@]/;
  function sanitizeField(v) {
    var s = String(v === undefined || v === null ? '' : v);
    return UNSAFE_LEADING.test(s) ? "'" + s : s;
  }

  // The `files` ticket column (design.md section 5) is filled in by agents
  // per docs/designhub/agent-access.md as free text, not a typed value -
  // accept a JSON array, or fall back to a comma/newline-delimited string
  // (matching the widget's own `files.join(', ')` display convention).
  function filesToArray(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    var s = String(v).trim();
    if (s.charAt(0) === '[') {
      try {
        var parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) { /* not JSON - fall through to delimited-text parsing */ }
    }
    return s.split(/[,\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  return {
    TICKET_COLS: TICKET_COLS, INDEX_COLS: INDEX_COLS, META_COLS: META_COLS,
    VALID_STATUSES: VALID_STATUSES,
    rowToTicket: function (row) { return rowToObj(TICKET_COLS, row); },
    ticketToRow: function (t) { return objToRow(TICKET_COLS, t); },
    rowToIndex: function (row) { return rowToObj(INDEX_COLS, row); },
    indexToRow: function (o) { return objToRow(INDEX_COLS, o); },
    widgetStatus: function (s) { return WIDGET_STATUS[s] || 'todo'; },
    sanitizeField: sanitizeField,
    filesToArray: filesToArray
  };
})();
if (typeof module !== 'undefined') module.exports = DH_SCHEMA;
