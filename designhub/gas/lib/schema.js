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
  // Knowledge Portal design (apps/knowledge-portal in home-rnd-productivity-v2,
  // section 4.2) - the `_knowledge-index` Sheet's `links` tab. A peer of
  // INDEX_COLS: same shape of concern (one catalog row per known asset), owned
  // by a different Sheet so the Importer and the DesignHub reconciler (D19)
  // never contend on the same rows (K4).
  var KNOWLEDGE_COLS = ['id', 'type', 'title', 'path', 'url', 'driveFileId',
    'owner', 'tags', 'source', 'status', 'modifiedTime', 'syncedAt',
    'createdAt', 'updatedAt', 'description'];
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

  // google.script.run's return value (listKnowledge's whole point) cannot
  // carry a Date instance, and getValues() returns a real Date object for
  // any date-formatted cell - a manually edited modifiedTime/createdAt/
  // updatedAt/syncedAt column, say - so a single such cell made
  // listKnowledge() fail outright instead of serving a stringified date (P2
  // review, thread PRRT_kwDOTLZBvs6QKAqu). Normalize at this pure schema
  // boundary rather than in bridge.js/drive.js, and in both directions: no
  // known input reaches knowledgeToRow still holding a Date (every row it
  // writes has already passed through rowToKnowledge first), but leaving one
  // direction unnormalized is a trap for whoever adds a write path later.
  function dateToIso_(v) {
    return v instanceof Date ? v.toISOString() : v;
  }
  function normalizeKnowledgeDates_(o) {
    var out = {};
    for (var i = 0; i < KNOWLEDGE_COLS.length; i++) {
      var c = KNOWLEDGE_COLS[i];
      out[c] = dateToIso_(o[c]);
    }
    return out;
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
      } catch { /* not JSON - fall through to delimited-text parsing */ }
    }
    return s.split(/[,\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  return {
    TICKET_COLS: TICKET_COLS, INDEX_COLS: INDEX_COLS, META_COLS: META_COLS,
    KNOWLEDGE_COLS: KNOWLEDGE_COLS,
    VALID_STATUSES: VALID_STATUSES,
    rowToTicket: function (row) { return rowToObj(TICKET_COLS, row); },
    ticketToRow: function (t) { return objToRow(TICKET_COLS, t); },
    rowToIndex: function (row) { return rowToObj(INDEX_COLS, row); },
    indexToRow: function (o) { return objToRow(INDEX_COLS, o); },
    rowToKnowledge: function (row) { return normalizeKnowledgeDates_(rowToObj(KNOWLEDGE_COLS, row)); },
    knowledgeToRow: function (o) { return objToRow(KNOWLEDGE_COLS, normalizeKnowledgeDates_(o)); },
    widgetStatus: function (s) { return WIDGET_STATUS[s] || 'todo'; },
    sanitizeField: sanitizeField,
    filesToArray: filesToArray
  };
})();
if (typeof module !== 'undefined') module.exports = DH_SCHEMA;
