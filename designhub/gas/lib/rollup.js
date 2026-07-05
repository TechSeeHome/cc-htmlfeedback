// D19 rollup logic: publish-time direct upsert + reconciler rebuild-from-shards.
// Pure functions - the live Sheets I/O lives in drive.js (GAS) / publish.mjs (skill).
var DH_ROLLUP = (function () {
  // Columns resolve LAZILY, inside each call. Load-time resolution would kill
  // the whole GAS project: clasp pushes files alphabetically, so this file
  // loads BEFORE lib/schema.js - DH_SCHEMA would be undefined at load and
  // require() does not exist in the GAS runtime, so doGet and every bridge
  // call would die with a load-time ReferenceError.
  function cols_() {
    return (typeof DH_SCHEMA !== 'undefined') ? DH_SCHEMA.INDEX_COLS
      : require('./schema.js').INDEX_COLS;
  }

  function upsertRow(rows, row) {
    var KEY = cols_().indexOf('driveFileId');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][KEY] === row[KEY]) {
        var next = rows.slice(); next[i] = row;
        return { action: 'updated', rows: next };
      }
    }
    return { action: 'appended', rows: rows.concat([row]) };
  }

  function buildRollup(shards) {
    var COLS = cols_();
    var KEY = COLS.indexOf('driveFileId');
    var UPDATED = COLS.indexOf('updatedAt');
    var REPO = COLS.indexOf('repo');
    var FEATURE = COLS.indexOf('feature');
    var TITLE = COLS.indexOf('title');
    var byKey = {};
    shards.forEach(function (rows) {
      rows.forEach(function (r) {
        var k = r[KEY];
        if (!k) return;
        var prev = byKey[k];
        if (!prev || String(r[UPDATED] || '') > String(prev[UPDATED] || '')) byKey[k] = r;
      });
    });
    return Object.keys(byKey).map(function (k) { return byKey[k]; }).sort(function (a, b) {
      return String(a[REPO]).localeCompare(String(b[REPO])) ||
        String(a[FEATURE]).localeCompare(String(b[FEATURE])) ||
        String(a[TITLE]).localeCompare(String(b[TITLE]));
    });
  }
  return { upsertRow: upsertRow, buildRollup: buildRollup };
})();
if (typeof module !== 'undefined') module.exports = DH_ROLLUP;
