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

  function mimeToType(mimeType) {
    var m = String(mimeType || '');
    if (EXACT_MIME_MAP[m]) return EXACT_MIME_MAP[m];
    for (var i = 0; i < PREFIX_MIME_MAP.length; i++) {
      if (PREFIX_MIME_MAP[i][0].test(m)) return PREFIX_MIME_MAP[i][1];
    }
    return 'file';
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
      title: file.name,
      path: file.path || '',
      url: file.url || '',
      driveFileId: file.id,
      owner: file.owner || '',
      tags: prev ? prev.tags : '',
      source: 'drive-sync',
      status: 'active',
      modifiedTime: file.modifiedTime || '',
      syncedAt: now,
      createdAt: prev ? prev.createdAt : now,
      updatedAt: now
    };
  }

  // Fields that make a row "the same" for updatedAt-bump purposes. tags is
  // deliberately excluded: it is the v2 curation hook (design section 4.2) and
  // is never written by the walk, only preserved (driveFileToRow above) - it
  // can never be the reason a drive-sync row changed.
  var DIFF_FIELDS = ['type', 'title', 'path', 'url', 'owner', 'status', 'modifiedTime'];
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

  return { mimeToType: mimeToType, planSync: planSync };
})();
if (typeof module !== 'undefined') module.exports = DH_KNOWLEDGE;
