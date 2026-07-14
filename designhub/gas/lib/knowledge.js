// Knowledge Portal design (apps/knowledge-portal in home-rnd-productivity-v2,
// K9/Option B) - pure logic for refreshKnowledge's server-side re-sync of the
// `_knowledge-index` Sheet from the team Shared Drive. Same split as rollup.js
// (D19): the walk itself needs DriveApp (drive.js), everything decidable from
// plain data lives here so it stays node --test-able and boundary-free (D5).
// Operates entirely on row OBJECTS (not raw Sheet arrays) - drive.js converts
// via DH_SCHEMA.rowToKnowledge/knowledgeToRow at the Sheet boundary, so this
// file never needs schema.js's column list and carries no load-order
// constraint (contrast rollup.js's lazy cols_(), needed only because IT works
// on raw arrays).
var DH_KNOWLEDGE = (function () {
  // Design section 4.2 lists the full type enum (gdoc/gsheet/gslides/gfolder/
  // pdf/image/video/audio/file/appscript/link); `appscript` and `link` are
  // never produced by a MIME lookup here - `link` only exists for manual rows
  // (never touched by this module, see planSync) and an Apps Script project's
  // MIME type simply falls through to the `file` fallback the design already
  // documents ("unknown kinds fall back to file"). `pptx` covers real
  // PowerPoint files kept in their native Office format (not converted to
  // Google Slides) - not in the design's enum yet but a real shape found in
  // the team drive, and `file` already exists as the safe catch-all so adding
  // a sibling exact-match bucket for it is free.
  var EXACT_MIME_MAP = {
    'application/vnd.google-apps.document': 'gdoc',
    'application/vnd.google-apps.spreadsheet': 'gsheet',
    'application/vnd.google-apps.presentation': 'gslides',
    'application/vnd.google-apps.folder': 'gfolder',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.ms-powerpoint': 'pptx'
  };
  var PREFIX_MIME_MAP = [
    [/^image\//, 'image'],
    [/^video\//, 'video'],
    [/^audio\//, 'audio']
  ];

  // Drive-tree child path (design section 4.2 contract, extracted out of
  // dhWalkTeamDrive_ (drive.js) the same way planRewriteRanges was pulled out
  // of refreshKnowledge below: the walk itself needs DriveApp and can't run
  // under node --test, but the one line of path arithmetic it depends on can,
  // so that line lives here instead of being duplicated inline). A folder's
  // row carries its OWN full path (parent joined with its own name); a
  // file's row carries its CONTAINING folder's path unchanged (the parent
  // path, not run through this function). Getting that swapped - passing a
  // folder the PARENT's path instead of its own - is exactly the bug this
  // function exists to make impossible to reintroduce: the portal's
  // buildDriveTree Object.assigns a folder row onto the tree node named by
  // its path, so a folder row carrying its parent's path renames the parent
  // node instead of creating its own.
  function childPath(parentPath, name) {
    return parentPath ? parentPath + '/' + name : name;
  }

  function mimeToType(mimeType) {
    var m = String(mimeType || '');
    if (EXACT_MIME_MAP[m]) return EXACT_MIME_MAP[m];
    for (var i = 0; i < PREFIX_MIME_MAP.length; i++) {
      if (PREFIX_MIME_MAP[i][0].test(m)) return PREFIX_MIME_MAP[i][1];
    }
    return 'file';
  }

  // Formula-injection defense (P2 review finding): a team-drive editor can
  // name a file/folder starting with =,+,-,@, and that name/path/owner would
  // otherwise be copied straight into the row and land in the Sheet via
  // setValues (bridge.js's refreshKnowledge) - Sheets parses a leading one of
  // those characters as a formula, the same class of attack the comment
  // pipeline already guards against with DH_SCHEMA.sanitizeField (schema.js).
  // Resolved lazily like rollup.js's cols_(): clasp pushes files
  // alphabetically, so this file (k) loads before lib/schema.js (s) and
  // DH_SCHEMA would be undefined at load time in the live GAS project.
  function sanitize_(v) {
    return (typeof DH_SCHEMA !== 'undefined') ? DH_SCHEMA.sanitizeField(v)
      : require('./schema.js').sanitizeField(v);
  }

  // One walked Drive file/folder -> one `drive-sync` knowledge row. `prev` is
  // the existing row for this driveFileId (if any) - only its `createdAt` is
  // ever carried forward; every other field is recomputed fresh from the walk
  // so a row converges to ground truth every run (same spirit as D19's
  // reconciler rebuild), rather than accumulating drift.
  function driveFileToRow(file, prev, now) {
    return {
      id: file.id,
      type: mimeToType(file.mimeType),
      title: sanitize_(file.name),
      path: sanitize_(file.path || ''),
      url: file.url || '',
      driveFileId: file.id,
      owner: sanitize_(file.owner || ''),
      tags: prev ? prev.tags : '',
      source: 'drive-sync',
      status: 'active',
      modifiedTime: file.modifiedTime || '',
      syncedAt: now,
      createdAt: prev ? prev.createdAt : now,
      updatedAt: now,
      // Sync enhancement (Slice B1): Drive's own file/folder description,
      // sanitized the same way title/path/owner already are (P2 review's
      // formula-injection defense - a description is free text a team-drive
      // editor controls, same threat model as a file name).
      description: sanitize_(file.description || '')
    };
  }

  // Fields that make a row "the same" for updatedAt-bump purposes. tags is
  // deliberately excluded: it is the v2 curation hook (design section 4.2) and
  // is never written by the walk, only preserved (driveFileToRow above) - it
  // can never be the reason a drive-sync row changed. description IS
  // included: a description-only edit in Drive is real, sync-worthy
  // curation, unlike tags (which the walk never writes at all).
  var DIFF_FIELDS = ['type', 'title', 'path', 'url', 'owner', 'status', 'modifiedTime', 'description'];
  function rowsDiffer(a, b) {
    return DIFF_FIELDS.some(function (f) { return (a[f] || '') !== (b[f] || ''); });
  }

  // The diff/upsert/stale-detection planner (design section 4.3, steps 2-3).
  // `existingRows` is the full current `_knowledge-index` `links` tab (both
  // source=manual and source=drive-sync rows); `driveFiles` is the flat walk
  // result (plain descriptors: id, name, mimeType, path, url, owner,
  // modifiedTime, trashed). Returns the FULL replacement row set plus counts,
  // matching D19's buildRollup/upsertRow style of returning ready-to-write
  // data rather than mutating in place.
  function planSync(existingRows, driveFiles, opts) {
    opts = opts || {};
    var now = opts.now || new Date().toISOString();
    existingRows = existingRows || [];
    driveFiles = driveFiles || [];

    // K4/design section 4.2: "The Importer only ever touches source=drive-sync
    // rows" - manual rows pass through byte-identical, not even syncedAt
    // stamped, so curation and sync can never fight.
    var manualRows = existingRows.filter(function (r) { return r.source === 'manual'; });
    var prevByFileId = {};
    existingRows.forEach(function (r) {
      if (r.source === 'drive-sync') prevByFileId[r.driveFileId] = r;
    });

    var created = 0, updated = 0, unchanged = 0;
    var seen = {};
    var liveRows = [];
    driveFiles.forEach(function (file) {
      if (file.trashed) return;   // trashed = missing (see staled below)
      seen[file.id] = true;
      var prev = prevByFileId[file.id];
      var next = driveFileToRow(file, prev, now);
      if (!prev) {
        created++;
      } else if (rowsDiffer(prev, next)) {
        updated++;
      } else {
        // Converged: keep the prior updatedAt (only syncedAt marks that this
        // run re-confirmed the row - see the file-level comment above
        // driveFileToRow) so an unchanged file doesn't look like it "changed"
        // on every hourly sync. This is what makes planSync idempotent: a
        // second run over an unchanged Drive produces byte-identical rows
        // aside from syncedAt (mirrors rollup.test.js's convergence test).
        next.updatedAt = prev.updatedAt;
        unchanged++;
      }
      liveRows.push(next);
    });

    // Missing (not in this walk at all) or trashed (in the walk, flagged
    // trashed - skipped by the `return` above so never marked `seen`) -> both
    // collapse to the same "not currently live" case, which becomes stale
    // (K7: "never silent drops"). A row already stale that stays missing gets
    // syncedAt bumped (this run re-confirmed it's still gone) but not
    // updatedAt (its state didn't change) - same convergence reasoning as the
    // unchanged branch above.
    var staled = 0;
    var staleRows = [];
    Object.keys(prevByFileId).forEach(function (id) {
      if (seen[id]) return;
      var prev = prevByFileId[id];
      var wasAlreadyStale = prev.status === 'stale';
      if (!wasAlreadyStale) staled++;
      staleRows.push(Object.assign({}, prev, {
        status: 'stale',
        syncedAt: now,
        updatedAt: wasAlreadyStale ? prev.updatedAt : now
      }));
    });

    return {
      rows: manualRows.concat(liveRows).concat(staleRows),
      stats: { created: created, updated: updated, unchanged: unchanged, staled: staled }
    };
  }

  // Write-then-trim range math for refreshKnowledge's Sheet rewrite (P2
  // review, chatgpt-codex-connector thread PRRT_kwDOTLZBvs6QJ9lW): the old
  // clear-then-write left a crash window - if execution died between the
  // clearContent() and the setValues(), the `links` tab sat empty and a retry
  // permanently lost source=manual rows, which (unlike drive-sync rows) are
  // never reproducible from a Drive walk (K4). Writing the new rows first and
  // trimming only the now-unused leftover tail afterward closes that window:
  // a crash before the write leaves the old data intact, and a crash after
  // the write leaves stale leftover rows below the new data at worst, never a
  // hole. oldRowCount/newRowCount are DATA row counts (i.e. excluding header
  // row 1); the returned write/trim are 1-based ranges ready for
  // sheet.getRange(row, 1, numRows, width), or null when that step is a
  // no-op. Pure arithmetic - no Sheet object touches this function, so it
  // stays node --test-able (D5).
  function planRewriteRanges(oldRowCount, newRowCount) {
    oldRowCount = oldRowCount || 0;
    newRowCount = newRowCount || 0;
    // newRowCount === 0 should only happen when the index is genuinely empty
    // (no manual rows AND no drive-sync/stale rows): planSync always concats
    // manualRows back into plan.rows untouched, so as long as ANY manual row
    // exists, newRowCount can never be 0. If it legitimately is 0, there is
    // nothing to preserve, so clearing the old tail below is safe.
    var write = newRowCount > 0 ? { row: 2, numRows: newRowCount } : null;
    var leftover = oldRowCount - newRowCount;
    var trim = leftover > 0 ? { row: newRowCount + 2, numRows: leftover } : null;
    return { write: write, trim: trim };
  }

  // Idempotent-ensure decision for dhKnowledgeSheetEnsure_ (drive.js):
  // production hit "Cannot read properties of null (reading 'appendRow')"
  // because the Node importer (home-rnd-productivity-v2) creates
  // `_knowledge-index` with only a `links` tab, so the old ensure function's
  // early-return-if-exists never checked for `meta` at all. Pure sheet-name
  // check so the decision itself stays node --test-able (D5) even though
  // actually creating a sheet needs SpreadsheetApp.
  function planTabsEnsure(existingSheetNames) {
    existingSheetNames = existingSheetNames || [];
    return {
      needsLinks: existingSheetNames.indexOf('links') === -1,
      needsMeta: existingSheetNames.indexOf('meta') === -1
    };
  }

  // Header-migration decision for dhKnowledgeSheetEnsure_ (drive.js), added
  // alongside the `description` column: a production `links` tab written by
  // OLDER code has a header row shorter than the CURRENT KNOWLEDGE_COLS -
  // same production-drift shape as planTabsEnsure's `meta`-tab gap above,
  // just for a column instead of a whole tab. KNOWLEDGE_COLS only ever
  // grows by APPENDING a new column at the end (never inserted/reordered),
  // specifically so an old header row is always a safe, unambiguous PREFIX
  // of the current one - this function trusts that invariant rather than
  // re-deriving it, so it only needs a length comparison, not a per-column
  // diff.
  function planHeaderEnsure(existingHeaderRow, canonicalCols) {
    existingHeaderRow = existingHeaderRow || [];
    canonicalCols = canonicalCols || [];
    if (existingHeaderRow.length >= canonicalCols.length) {
      return { needsUpdate: false, header: existingHeaderRow };
    }
    return { needsUpdate: true, header: canonicalCols.slice() };
  }

  return { childPath: childPath, mimeToType: mimeToType, planSync: planSync,
    planRewriteRanges: planRewriteRanges, planTabsEnsure: planTabsEnsure,
    planHeaderEnsure: planHeaderEnsure };
})();
if (typeof module !== 'undefined') module.exports = DH_KNOWLEDGE;
