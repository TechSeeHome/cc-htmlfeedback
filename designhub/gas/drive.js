// DriveApp/SpreadsheetApp adapters. Thin by design (D5): everything testable
// lives in lib/, this file only touches Google services.

function dhChildFolder_(folder, name) {
  var it = folder.getFoldersByName(name);
  if (!it.hasNext()) throw new Error('DesignHub: folder not found: ' + name);
  return it.next();
}

// Resolve ?doc=<repo>/<featureDir>/<subpath...> to the Drive file + its
// feature folder. Path is the public addressing scheme; the feature _index
// row (matched by driveFileId) is the authoritative pointer to the companion
// Sheet (design section 5: resolve by id, never by name).
function dhResolveDoc_(path) {
  var p = DH_PATHS.parseDocPath(path);
  var folder = DriveApp.getFolderById(DH_CONFIG.rootFolderId);
  folder = dhChildFolder_(folder, p.repo);
  var featureFolder = dhChildFolder_(folder, p.featureDir);
  folder = featureFolder;
  for (var i = 0; i < p.segments.length - 1; i++) folder = dhChildFolder_(folder, p.segments[i]);
  var files = folder.getFilesByName(p.fileName);
  if (!files.hasNext()) throw new Error('DesignHub: doc not found: ' + path);
  return { file: files.next(), featureFolder: featureFolder, parsed: p };
}

function dhIndexRows_(featureFolder) {
  var it = featureFolder.getFilesByName('_index');
  if (!it.hasNext()) throw new Error('DesignHub: _index missing for feature ' + featureFolder.getName());
  var sheet = SpreadsheetApp.openById(it.next().getId()).getSheetByName('index');
  var values = sheet.getDataRange().getValues();
  return values.slice(1).map(function (row) { return DH_SCHEMA.rowToIndex(row); });
}

// path -> the doc's companion tickets spreadsheet (+ file id for audit rows)
function dhCommentsFor_(path) {
  var r = dhResolveDoc_(path);
  var fileId = r.file.getId();
  var row = dhIndexRows_(r.featureFolder).filter(function (o) { return o.driveFileId === fileId; })[0];
  if (!row || !row.commentSheetId) throw new Error('DesignHub: no index row / commentSheetId for ' + path);
  return { ss: SpreadsheetApp.openById(row.commentSheetId), indexRow: row, fileId: fileId };
}

function dhPortalRows_() {
  var root = DriveApp.getFolderById(DH_CONFIG.rootFolderId);
  var it = root.getFilesByName('_portal-index');
  if (!it.hasNext()) return [];   // nothing published yet
  var sheet = SpreadsheetApp.openById(it.next().getId()).getSheets()[0];
  var values = sheet.getDataRange().getValues();
  return values.slice(1).map(function (row) { return DH_SCHEMA.rowToIndex(row); });
}

// D19 reconciler: rebuild _portal-index from every feature _index shard.
//
// Shard-ordering decision (00-overview.md, "Two items for whoever executes
// Task 6 and Task 10"): rollup.js's buildRollup breaks an exact updatedAt
// tie by first-row-wins, which is only deterministic for a FIXED `shards`
// order - it has no way to impose one itself (see its own comment). Drive's
// getFolders()/getFilesByName() iteration order is NOT guaranteed, so if we
// pushed shards in raw traversal order, the tie-break winner on an
// exact-timestamp collision (and therefore what the portal index shows)
// could flap between reconciler runs with no underlying data change. We
// already compute each folder's path while walking the tree, so recording
// it alongside its shard and sorting by path before calling buildRollup is
// free and makes the result deterministic run-to-run regardless of Drive's
// listing order.
// Trailing underscore (final-review finding): a top-level GAS function without
// one is reachable from a published doc's own script via google.script.run -
// this function isn't part of D17(a)'s bridge contract (comment-Sheet rows +
// catalog reads only) and shouldn't be client-callable at all. Correction
// (live redeploy, 2026-07-06): the Apps Script editor's manual "Run" dropdown
// and the Trigger dialog's function picker BOTH hide underscore-suffixed
// functions too - confirmed empirically, not just a google.script.run effect.
// ScriptApp.newTrigger('dhReconcile_') from CODE (as dhInstallReconcilerTrigger_
// does below) still works fine - only the two UI pickers filter it out. Net
// effect: reinstalling this trigger after a rename needs a temporary
// non-underscore wrapper function pushed, run once via the UI, then removed -
// see 00-overview.md.
function dhReconcile_() {
  var root = DriveApp.getFolderById(DH_CONFIG.rootFolderId);
  var shards = [];
  var queue = [{ folder: root, path: '' }];
  while (queue.length) {
    var entry = queue.shift();
    var folder = entry.folder;
    var subs = folder.getFolders();
    while (subs.hasNext()) {
      var sub = subs.next();
      queue.push({ folder: sub, path: entry.path + '/' + sub.getName() });
    }
    var files = folder.getFilesByName('_index');
    while (files.hasNext()) {
      var ss = SpreadsheetApp.openById(files.next().getId()).getSheetByName('index');
      if (ss) shards.push({ path: entry.path, rows: ss.getDataRange().getValues().slice(1) });
    }
  }
  shards.sort(function (a, b) { return a.path.localeCompare(b.path); });
  var rows = DH_ROLLUP.buildRollup(shards.map(function (s) { return s.rows; }));
  var it = root.getFilesByName('_portal-index');
  var sheet;
  if (!it.hasNext()) {
    // _portal-index doesn't exist yet - create it with the header row
    var newSs = SpreadsheetApp.create('_portal-index');
    var newFile = DriveApp.getFileById(newSs.getId());
    root.addFile(newFile);
    DriveApp.getRootFolder().removeFile(newFile);
    sheet = newSs.getSheets()[0];
    sheet.appendRow(DH_SCHEMA.INDEX_COLS);
  } else {
    sheet = SpreadsheetApp.openById(it.next().getId()).getSheets()[0];
  }
  // Clear existing data rows (keeping the header) using the actual sheet extent
  var lastRow = Math.max(sheet.getLastRow() - 1, 0);
  if (lastRow > 0) {
    sheet.getRange(2, 1, lastRow, DH_SCHEMA.INDEX_COLS.length).clearContent();
  }
  if (rows.length) sheet.getRange(2, 1, rows.length, DH_SCHEMA.INDEX_COLS.length).setValues(rows);
  return rows.length;
}

// --- Knowledge Portal (K9/Option B) --------------------------------------
// listKnowledge/refreshKnowledge (bridge.js) extend the bridge per the
// Knowledge Portal design (apps/knowledge-portal in home-rnd-productivity-v2,
// section 4.2/4.3). `_knowledge-index` is root-level like `_portal-index`
// (D19) but is its OWN Sheet (K4) - the Importer/reconciler here never reads
// or writes `_portal-index`, and DesignHub's reconciler never touches this
// one.

// Root-level lookup, mirrors dhPortalRows_ - returns null (not an error) when
// nothing has synced yet, matching listKnowledge's "missing Sheet returns
// {rows: []}" contract (portal falls back gracefully).
function dhKnowledgeSheet_() {
  var root = DriveApp.getFolderById(DH_CONFIG.rootFolderId);
  var it = root.getFilesByName('_knowledge-index');
  return it.hasNext() ? SpreadsheetApp.openById(it.next().getId()) : null;
}

function dhKnowledgeRows_() {
  var ss = dhKnowledgeSheet_();
  var sheet = ss && ss.getSheetByName('links');
  if (!sheet) return [];
  return sheet.getDataRange().getValues().slice(1).map(function (row) { return DH_SCHEMA.rowToKnowledge(row); });
}

// Idempotent create: 'links' (data) + 'meta' (audit log, same append-only
// pattern setStatus already uses on the comment Sheet's meta tab - D17(c)).
// root.addFile/DriveApp.getRootFolder().removeFile below reparent the new
// Spreadsheet into DH_CONFIG.rootFolderId - Apps Script only allows
// Folder.addFile/removeFile under the full 'https://www.googleapis.com/auth/
// drive' scope, not 'drive.readonly' (P1 review fix; see appsscript.json's
// oauthScopes). In production the Sheet already exists (created by the Node
// importer, 2026-07-12), so this bootstrap path only runs in a fresh
// environment - but the full scope is what makes refreshKnowledge
// self-sufficient there too, instead of depending on someone running the
// importer by hand first.
function dhKnowledgeSheetEnsure_() {
  var existing = dhKnowledgeSheet_();
  if (existing) return existing;
  var root = DriveApp.getFolderById(DH_CONFIG.rootFolderId);
  var ss = SpreadsheetApp.create('_knowledge-index');
  var file = DriveApp.getFileById(ss.getId());
  root.addFile(file);
  DriveApp.getRootFolder().removeFile(file);
  var links = ss.getSheets()[0];
  links.setName('links');
  links.appendRow(DH_SCHEMA.KNOWLEDGE_COLS);
  ss.insertSheet('meta').appendRow(DH_SCHEMA.META_COLS);
  return ss;
}

// Walk the team Shared Drive (folder id is config, not a hardcode - same
// treatment as DH_CONFIG.rootFolderId) and return plain file/folder
// descriptors for DH_KNOWLEDGE.planSync. Same BFS shape as dhReconcile_'s
// walk. Uses DriveApp (design section 4.3 allows "DriveApp or the Drive
// advanced service"; the manifest's Drive scope is broader than a read-only
// walk needs (see dhKnowledgeSheetEnsure_'s comment) and ~100 files is well
// within a plain-DriveApp walk's quota, so there is no reason to add the
// advanced service and its extra manifest surface for this).
//
// getFolders()/getFiles() do not enumerate trashed items at all - a
// deleted/trashed file simply never appears here, which already produces the
// right outcome (planSync's "missing" branch flags it stale). The `trashed`
// field is still read per-item (cheap: no extra API call, isTrashed() is a
// property of the same Drive object) so planSync's own trashed handling stays
// exercised if a future advanced-service walker starts returning trashed rows.
//
// owner (design section 4.2: "Drive last-modifying user") uses getOwner()
// instead: DriveApp has no last-modifying-user getter (only the Drive
// advanced service's `lastModifyingUser` field does), and Shared Drive items
// can throw or return null from getOwner() (they are drive-owned, not
// user-owned) - guarded per-file so one file's owner lookup can never abort
// the whole sync.
// Folder's MIME type is fixed and NOT exposed via getMimeType() - unlike
// File, the Folder class has no such method at all - so it is supplied by the
// caller instead of read off the object (see dhDriveDescriptor_).
var DH_FOLDER_MIME_TYPE_ = 'application/vnd.google-apps.folder';

function dhWalkTeamDrive_() {
  var folderId = DH_CONFIG.teamDriveFolderId;
  if (!folderId) throw new Error('DesignHub: teamDriveFolderId not configured');
  var out = [];
  var queue = [{ folder: DriveApp.getFolderById(folderId), path: '' }];
  while (queue.length) {
    var entry = queue.shift();
    var files = entry.folder.getFiles();
    while (files.hasNext()) {
      var f = files.next();
      out.push(dhDriveDescriptor_(f, entry.path, f.getMimeType()));
    }
    var subs = entry.folder.getFolders();
    while (subs.hasNext()) {
      var sub = subs.next();
      out.push(dhDriveDescriptor_(sub, entry.path, DH_FOLDER_MIME_TYPE_));
      queue.push({ folder: sub, path: entry.path ? entry.path + '/' + sub.getName() : sub.getName() });
    }
  }
  return out;
}

function dhDriveDescriptor_(item, parentPath, mimeType) {
  var owner = '';
  try {
    var o = item.getOwner();
    if (o) owner = o.getEmail();
  } catch (e) { /* Shared Drive items are drive-owned, not user-owned - '' is fine */ }
  return {
    id: item.getId(), name: item.getName(), mimeType: mimeType,
    path: parentPath, url: item.getUrl(), owner: owner,
    modifiedTime: item.getLastUpdated().toISOString(), trashed: item.isTrashed()
  };
}

// One-time (idempotent) trigger install - invoke after first deploy, or
// re-run any time. Also underscore-suffixed (see dhReconcile_'s comment) -
// it isn't part of the bridge contract either, and per that same comment
// can't be run directly from the editor's UI (a temporary non-underscore
// wrapper is needed - see 00-overview.md). Only cleans up an existing
// trigger already pointed at 'dhReconcile_' - a trigger left over from a
// PRIOR function name (like 'dhReconcile' before this file's rename) is not
// recognized or removed here and needs deleting separately.
function dhInstallReconcilerTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dhReconcile_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dhReconcile_').timeBased()
    .everyHours(DH_CONFIG.reconcilerEveryHours).create();
}
