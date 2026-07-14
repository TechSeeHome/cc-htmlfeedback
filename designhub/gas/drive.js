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

// Write-side ACL probe target resolution (Knowledge Portal design, "Users
// and permissions", Slice B1): mirrors dhResolveDoc_'s exact folder walk,
// but PERMISSIVE instead of throwing - it walks as far as Drive already has
// and stops there, so publishDesignDoc (bridge.js) can run the write-ACL
// check against whichever object actually exists ("the existing file when
// updating, the nearest existing ancestor folder when creating a new folder
// chain... the outermost boundary is the DesignHub root folder"), before
// creating anything. Returns:
//  - {aclTarget: <existing File>, existingFile: true, parentFolder: <its
//    folder>, missingFolderNames: []} - the full chain AND the file exist
//    (an update).
//  - {aclTarget: <the deepest existing Folder>, existingFile: false,
//    parentFolder: <same folder>, missingFolderNames: []} - the full folder
//    chain exists but the file itself does not yet (a create with no
//    folders to make).
//  - {aclTarget: <the deepest existing Folder>, existingFile: false,
//    parentFolder: <same folder>, missingFolderNames: [<names still
//    needed>]} - some folder in the chain is missing; aclTarget is the
//    nearest existing ancestor per the design doc's wording.
function dhResolveWriteTarget_(repo, featureDir, folderSegments, fileName) {
  var root = DriveApp.getFolderById(DH_CONFIG.rootFolderId);
  var names = [repo, featureDir].concat(folderSegments);
  var folder = root;
  for (var i = 0; i < names.length; i++) {
    var it = folder.getFoldersByName(names[i]);
    if (!it.hasNext()) {
      return {
        aclTarget: folder,
        existingFile: false,
        parentFolder: folder,
        missingFolderNames: names.slice(i),
      };
    }
    folder = it.next();
  }
  var files = folder.getFilesByName(fileName);
  if (files.hasNext()) {
    return {
      aclTarget: files.next(),
      existingFile: true,
      parentFolder: folder,
      missingFolderNames: [],
    };
  }
  return { aclTarget: folder, existingFile: false, parentFolder: folder, missingFolderNames: [] };
}

// Best-effort owner lookup - same guard dhDriveDescriptor_ already uses:
// Shared Drive items are drive-owned, not user-owned, and getOwner() can
// throw or return null. '' is fine; DH_ACCESS.decideWrite treats a falsy
// fileOwnerEmail as "no owner match possible", never a crash. Works
// identically for a File or a Folder target (both expose getOwner()).
function dhOwnerEmail_(driveItem) {
  try {
    var o = driveItem.getOwner();
    return o ? o.getEmail() : '';
  } catch (e) {
    return '';
  }
}

// The one live Drive.Permissions.list call the write-side ACL probe needs -
// same Advanced Drive Service (v3) B0's dhCanRead_ already depends on, same
// {supportsAllDrives, fields} call shape.
function dhFilePermissions_(driveItem) {
  var response = Drive.Permissions.list(driveItem.getId(), {
    supportsAllDrives: true,
    fields: 'permissions(emailAddress,type,domain,role)',
  });
  return (response && response.permissions) || [];
}

// Read-side ACL check (Knowledge Portal design, "Users and permissions",
// Slice B0): before doGet() returns a resolved doc's bytes, verify the
// REQUESTING user's real Drive permission on the underlying file. Drive
// ACLs are the single permission authority (the standing ADR) - the
// decision itself lives in the pure DH_ACCESS.decideRead (gas/lib/access.js);
// this function only fetches what Drive says and hands it over.
//
// Cached per user+file via CacheService.getUserCache() (scoped to this
// script + the CURRENT signed-in user, which is exactly the "per user+file"
// scope the design doc calls for) with a 600-second (10-minute) TTL - so a
// Drive un-share takes effect within minutes, not instantly (documented,
// accepted limitation - see the design doc's read-side bullet). CacheService
// only stores strings, so the boolean is stored as '1'/'0' and parsed back.
//
// Deliberately does NOT catch anything itself: if Drive.Permissions.list
// (via dhFilePermissions_) throws (e.g. a transient API error), this
// propagates up and doGet() fails closed (GAS's generic error page, no doc
// served) rather than risk a bug in this check ever serving unauthorized
// bytes. Only the AUDIT-LOG call in doGet() (dhLogReadDenial_, below) is
// wrapped in a swallowing try/catch - logging failure must never turn into
// an access bypass, but a failure in the check itself must never turn into
// an access GRANT either. (dhOwnerEmail_ still swallows ITS OWN lookup
// failure internally - same "no owner match possible, not a crash" guard it
// always had - so that part of the behavior is unchanged by this refactor.)
//
// Nitpick fix (review of PR #11): this used to re-implement the owner lookup
// and the Drive.Permissions.list call inline, duplicating exactly what
// dhOwnerEmail_/dhFilePermissions_ (Slice B1) already encapsulate. Delegating
// to them keeps this one call site in sync with any future change to either
// helper.
function dhCanRead_(file, actorEmail) {
  var cache = CacheService.getUserCache();
  var key = 'kp-read:' + file.getId();
  var cached = cache.get(key);
  if (cached !== null) return cached === '1';

  var decision = DH_ACCESS.decideRead(dhFilePermissions_(file), actorEmail, dhOwnerEmail_(file));
  cache.put(key, decision.allow ? '1' : '0', 600);
  return decision.allow;
}

function dhIndexRows_(featureFolder) {
  var it = featureFolder.getFilesByName('_index');
  if (!it.hasNext())
    throw new Error('DesignHub: _index missing for feature ' + featureFolder.getName());
  var sheet = SpreadsheetApp.openById(it.next().getId()).getSheetByName('index');
  var values = sheet.getDataRange().getValues();
  return values.slice(1).map(function (row) {
    return DH_SCHEMA.rowToIndex(row);
  });
}

// repo/featureDir -> the feature's own folder, by name from root - the same
// two-level walk dhResolveDoc_ does internally, factored out because
// publishDesignDoc (bridge.js) needs it independently of resolving any
// particular doc path (it needs the FEATURE folder specifically, to
// ensure/read that feature's _index, regardless of how deep path-in-repo's
// own subfolders go under it).
function dhFeatureFolder_(repo, featureDir) {
  return dhChildFolder_(
    dhChildFolder_(DriveApp.getFolderById(DH_CONFIG.rootFolderId), repo),
    featureDir
  );
}

// Idempotent-ensure for a feature's `_index` companion Sheet - mirrors
// dhKnowledgeSheetEnsure_'s create-if-missing idiom. publish.mjs's Step 2
// does the REST-API equivalent when the Node CLI publishes a feature's
// first doc ever; publishDesignDoc needs the identical bootstrap for a
// feature nobody has published to yet, whether via the CLI or this bridge.
function dhIndexSheetEnsure_(featureFolder) {
  var it = featureFolder.getFilesByName('_index');
  var ss;
  if (it.hasNext()) {
    ss = SpreadsheetApp.openById(it.next().getId());
  } else {
    ss = SpreadsheetApp.create('_index');
    var file = DriveApp.getFileById(ss.getId());
    featureFolder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);
  }
  var sheet = ss.getSheetByName('index');
  if (!sheet) {
    sheet = ss.getSheets()[0];
    sheet.setName('index');
    sheet.appendRow(DH_SCHEMA.INDEX_COLS);
  }
  return sheet;
}

// Idempotent-ensure for a doc's companion comments Sheet - same 'tickets' +
// 'meta' tab/header shape publish.mjs's Step 4 creates over REST, same
// naming convention (DH_PATHS.companionName). Returns both the spreadsheet
// and its 'tickets' sheet, since callers need both (the id for the _index
// row, the sheet for dhTicketCountFor_ below).
function dhCompanionSheetEnsure_(folder, fileName) {
  var companionName = DH_PATHS.companionName(fileName);
  var it = folder.getFilesByName(companionName);
  var ss;
  if (it.hasNext()) {
    ss = SpreadsheetApp.openById(it.next().getId());
  } else {
    ss = SpreadsheetApp.create(companionName);
    var file = DriveApp.getFileById(ss.getId());
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);
  }
  var tickets = ss.getSheetByName('tickets');
  if (!tickets) {
    tickets = ss.getSheets()[0];
    tickets.setName('tickets');
    tickets.appendRow(DH_SCHEMA.TICKET_COLS);
  }
  if (!ss.getSheetByName('meta')) {
    ss.insertSheet('meta').appendRow(DH_SCHEMA.META_COLS);
  }
  return { ss: ss, ticketsSheet: tickets };
}

// "Has feedback comments" for the Manage dialog's collision outcomes
// (design doc, "Upload design doc" > Outcomes): counts top-level, non-
// deleted ticket rows - the same visibility filter listComments (bridge.js)
// already applies. Deleted rows stay in the Sheet per D17(c) but the user
// already discarded them, so they must not block a re-upload; a reply has
// no anchor of its own to break, only its parent ticket does.
function dhTicketCountFor_(ticketsSheet) {
  var values = ticketsSheet.getDataRange().getValues().slice(1);
  var PARENT = DH_SCHEMA.TICKET_COLS.indexOf('parentId');
  var STATUS = DH_SCHEMA.TICKET_COLS.indexOf('status');
  return values.filter(function (row) {
    return !row[PARENT] && row[STATUS] !== 'deleted';
  }).length;
}

// path -> the doc's companion tickets spreadsheet (+ file id for audit rows).
//
// actorEmail (P1 security fix, review of PR #11): when provided, gates the
// resolution behind the SAME read-ACL check doGet() already applies to
// VIEWING a doc (dhCanRead_, Slice B0). Before this fix, listComments/
// submitComment/reply/setStatus (bridge.js) all called this function with no
// ACL check at all - any signed-in domain user who knew or guessed a
// restricted docPath could read stored ticket quotes/notes and mutate the
// ticket sheet for a doc they had no Drive access to, defeating B0's read-ACL
// entirely for comment data. Centralized HERE (the single place all four RPCs
// already resolve through) rather than duplicated at each of the 4 call
// sites, so any future caller inherits the same gate automatically.
//
// actorEmail is deliberately OPTIONAL, not required: dhLogReadDenial_ (below)
// is ALSO a caller of this function, and it runs exactly when the actor's
// read access has already been denied by doGet() - gating it here too would
// make the denial-audit-log call throw the very denial it's trying to
// record, silently breaking every denial's audit trail. dhLogReadDenial_
// intentionally omits actorEmail to skip this gate; that is not a new
// bypass, since it only appends one audit row and never returns ticket data
// to the denied actor.
function dhCommentsFor_(path, actorEmail) {
  var r = dhResolveDoc_(path);
  if (actorEmail && !dhCanRead_(r.file, actorEmail)) {
    throw new Error('DesignHub: access denied for ' + path);
  }
  var fileId = r.file.getId();
  var row = dhIndexRows_(r.featureFolder).filter(function (o) {
    return o.driveFileId === fileId;
  })[0];
  if (!row || !row.commentSheetId)
    throw new Error('DesignHub: no index row / commentSheetId for ' + path);
  return { ss: SpreadsheetApp.openById(row.commentSheetId), indexRow: row, fileId: fileId };
}

// Denial audit log (Knowledge Portal design, read-side ACL - Slice B0): same
// append-only meta-tab pattern setStatus (bridge.js) already uses on a doc's
// companion comments Sheet (D17(c)), so a denial is visible in the same
// place other per-doc activity is recorded. Every currently-resolvable doc
// has a companion Sheet - the /publish-design pipeline's Step 4 ensures one
// unconditionally on every publish - so dhCommentsFor_ should normally
// succeed here too. If it (or the appendRow call) throws for any reason
// (companion Sheet deleted after publish, _index row missing/stale, Sheets
// transiently unavailable), this propagates up uncaught - the CALLER
// (doGet(), Task 4) is what wraps this call in a swallowing try/catch, so a
// logging failure degrades to "this one denial wasn't recorded," never to
// "the doc got served anyway."
function dhLogReadDenial_(docPath, actorEmail) {
  var c = dhCommentsFor_(docPath);
  var now = new Date().toISOString();
  c.ss
    .getSheetByName('meta')
    .appendRow(['', '', '', '', '', '', actorEmail, now, 'access denied: ' + docPath]);
}

function dhPortalRows_() {
  var root = DriveApp.getFolderById(DH_CONFIG.rootFolderId);
  var it = root.getFilesByName('_portal-index');
  if (!it.hasNext()) return []; // nothing published yet
  var sheet = SpreadsheetApp.openById(it.next().getId()).getSheets()[0];
  var values = sheet.getDataRange().getValues();
  return values.slice(1).map(function (row) {
    return DH_SCHEMA.rowToIndex(row);
  });
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
// Idempotent-ensure for `_portal-index`'s Sheet + header row - factored out
// of dhReconcile_ (behavior unchanged) so publishDesignDoc's own direct
// upsert (Task 6, D19's "direct-upsert" path) can reuse the exact same
// bootstrap instead of duplicating it.
function dhPortalIndexSheetEnsure_() {
  var root = DriveApp.getFolderById(DH_CONFIG.rootFolderId);
  var it = root.getFilesByName('_portal-index');
  if (it.hasNext()) return SpreadsheetApp.openById(it.next().getId()).getSheets()[0];
  var newSs = SpreadsheetApp.create('_portal-index');
  var newFile = DriveApp.getFileById(newSs.getId());
  root.addFile(newFile);
  DriveApp.getRootFolder().removeFile(newFile);
  var sheet = newSs.getSheets()[0];
  sheet.appendRow(DH_SCHEMA.INDEX_COLS);
  return sheet;
}

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
  shards.sort(function (a, b) {
    return a.path.localeCompare(b.path);
  });
  var rows = DH_ROLLUP.buildRollup(
    shards.map(function (s) {
      return s.rows;
    })
  );
  var sheet = dhPortalIndexSheetEnsure_();
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

// Write-side ACL probe target resolution for createKnowledgeLink (bridge.js),
// same spirit as dhResolveWriteTarget_ above (P2 security fix, review of PR
// #11): "the existing file when it's already there, the nearest existing
// ancestor when it isn't" - applied to this single root-level target instead
// of a full folder chain. `_knowledge-index` is a lone Sheet at the DesignHub
// root, so there is no chain to walk: either the Sheet already exists (use
// it, as a File - DriveApp.getFileById, so dhOwnerEmail_/dhFilePermissions_'s
// "works identically for a File or a Folder" contract holds; SpreadsheetApp's
// own Spreadsheet class exposes no getOwner()), or it doesn't yet (fall back
// to the root folder it would be created under, dhKnowledgeSheetEnsure_'s own
// creation parent).
function dhKnowledgeWriteTarget_() {
  var existing = dhKnowledgeSheet_();
  if (existing) return DriveApp.getFileById(existing.getId());
  return DriveApp.getFolderById(DH_CONFIG.rootFolderId);
}

function dhKnowledgeRows_() {
  var ss = dhKnowledgeSheet_();
  var sheet = ss && ss.getSheetByName('links');
  if (!sheet) return [];
  return sheet
    .getDataRange()
    .getValues()
    .slice(1)
    .map(function (row) {
      return DH_SCHEMA.rowToKnowledge(row);
    });
}

// Idempotent create: 'links' (data) + 'meta' (audit log, same append-only
// pattern setStatus already uses on the comment Sheet's meta tab - D17(c)).
// root.addFile/DriveApp.getRootFolder().removeFile below reparent a newly
// created Spreadsheet into DH_CONFIG.rootFolderId - Apps Script only allows
// Folder.addFile/removeFile under the full 'https://www.googleapis.com/auth/
// drive' scope, not 'drive.readonly' (P1 review fix; see appsscript.json's
// oauthScopes).
//
// In production the Sheet already exists (created by the Node importer,
// home-rnd-productivity-v2), which only ever creates the `links` tab - a bare
// early-return-if-exists here left `meta` never created, and refreshKnowledge
// (bridge.js) crashed with "Cannot read properties of null (reading
// 'appendRow')" the first time it tried to append an audit row. So this
// checks BOTH tabs every call, on both the bootstrap (brand-new spreadsheet)
// and pre-existing-spreadsheet paths, via the same DH_KNOWLEDGE.planTabsEnsure
// decision either way - the full Drive scope is what makes refreshKnowledge
// self-sufficient in a fresh environment too, instead of depending on someone
// running the importer by hand first.
function dhKnowledgeSheetEnsure_() {
  var ss = dhKnowledgeSheet_();
  var isNew = !ss;
  if (isNew) {
    var root = DriveApp.getFolderById(DH_CONFIG.rootFolderId);
    ss = SpreadsheetApp.create('_knowledge-index');
    var file = DriveApp.getFileById(ss.getId());
    root.addFile(file);
    DriveApp.getRootFolder().removeFile(file);
  }
  var names = ss.getSheets().map(function (s) {
    return s.getName();
  });
  var plan = DH_KNOWLEDGE.planTabsEnsure(names);
  if (plan.needsLinks) {
    // Only a spreadsheet WE just created has its default sheet (e.g.
    // "Sheet1") renamed in place - an existing spreadsheet that somehow
    // lacks `links` gets a real new tab instead, so no unrelated tab it
    // already has (e.g. a lone `meta`) is ever renamed out from under it.
    var links = isNew ? ss.getSheets()[0] : ss.insertSheet();
    links.setName('links');
    links.appendRow(DH_SCHEMA.KNOWLEDGE_COLS);
  } else {
    // Header-migration guard (Slice B1's `description` column): a `links`
    // tab that already existed before this deploy has a header row written
    // by older code, shorter than the CURRENT KNOWLEDGE_COLS - fix it up in
    // place rather than leaving a silently-unlabeled trailing data column.
    var linksSheet = ss.getSheetByName('links');
    var headerRow = linksSheet
      .getRange(1, 1, 1, Math.max(linksSheet.getLastColumn(), 1))
      .getValues()[0];
    var headerPlan = DH_KNOWLEDGE.planHeaderEnsure(headerRow, DH_SCHEMA.KNOWLEDGE_COLS);
    if (headerPlan.needsUpdate) {
      linksSheet.getRange(1, 1, 1, headerPlan.header.length).setValues([headerPlan.header]);
    }
  }
  if (plan.needsMeta) {
    ss.insertSheet('meta').appendRow(DH_SCHEMA.META_COLS);
  }
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
      // Design section 4.2 contract: a folder row carries its OWN full path,
      // not the parent's - compute it once (DH_KNOWLEDGE.childPath, the pure
      // seam this is tested through) and use it for both the folder's own
      // descriptor and the queue entry it recurses into. Files stay on
      // entry.path unchanged (their CONTAINING folder's path) via the loop
      // above.
      var subPath = DH_KNOWLEDGE.childPath(entry.path, sub.getName());
      out.push(dhDriveDescriptor_(sub, subPath, DH_FOLDER_MIME_TYPE_));
      queue.push({ folder: sub, path: subPath });
    }
  }
  return out;
}

function dhDriveDescriptor_(item, parentPath, mimeType) {
  var owner = '';
  try {
    var o = item.getOwner();
    if (o) owner = o.getEmail();
  } catch (e) {
    /* Shared Drive items are drive-owned, not user-owned - '' is fine */
  }
  return {
    id: item.getId(),
    name: item.getName(),
    mimeType: mimeType,
    path: parentPath,
    url: item.getUrl(),
    owner: owner,
    modifiedTime: item.getLastUpdated().toISOString(),
    trashed: item.isTrashed(),
    // Sync enhancement (Slice B1): Drive's own description field, straight
    // off DriveApp - both File and Folder expose getDescription() (no
    // Advanced Service call needed, unlike this plan's write-side
    // Permissions.list; this repo's walk already deliberately stays on
    // plain DriveApp per this function's own file-level comment). Never
    // null in practice, but guarded with `|| ''` anyway for parity with
    // owner/url above.
    description: item.getDescription() || '',
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
  ScriptApp.newTrigger('dhReconcile_')
    .timeBased()
    .everyHours(DH_CONFIG.reconcilerEveryHours)
    .create();
}
