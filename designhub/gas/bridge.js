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
  if (filter && filter.repo)
    rows = rows.filter(function (r) {
      return r.repo === filter.repo;
    });
  return { rows: rows };
}

// --- Knowledge Portal (K9/Option B) extension ----------------------------
// apps/knowledge-portal (home-rnd-productivity-v2) design section 5: the
// portal is a published DesignHub doc that calls the bridge live instead of
// baking in JSON, so these two ride the same containment as everything above
// - catalog-shaped reads plus one identity-stamped write path (D17). Neither
// touches comment-Sheet rows or `_portal-index` (D19's disposable rollup
// stays untouched, per the Knowledge Portal design's inherited-rules section).

// REST-shaped like listCatalog (design section 3, "each bridge function is
// deliberately shaped like a REST endpoint"). Missing `_knowledge-index`
// Sheet -> {rows: []}, never an error - the portal falls back gracefully
// (Knowledge Portal design K9) instead of failing to load before the first
// sync has ever run.
function listKnowledge() {
  return { rows: dhKnowledgeRows_() };
}

// Server-side re-sync (Knowledge Portal design section 4.3): walks the team
// Shared Drive, upserts source=drive-sync rows, flips missing/trashed ones to
// stale (K7), and NEVER touches source=manual rows (K4) - all decided by the
// pure DH_KNOWLEDGE.planSync (lib/knowledge.js), so this function stays a
// thin read -> plan -> batched-write adapter, same shape as dhReconcile_.
// D17: the triggering identity is stamped server-side, never client-supplied,
// and recorded in the `_knowledge-index` Sheet's own 'meta' tab using the same
// append-only audit pattern setStatus already uses (repo/pathInRepo/branch/
// commitSha/pr/jira columns blank, publisher + publishedAt + a note).
function refreshKnowledge() {
  var email = Session.getActiveUser().getEmail();
  var now = new Date().toISOString();
  // Lock-protected (CodeRabbit review): the read of 'links', the plan, the
  // clear, the rewrite, and the meta append below are separate calls - without
  // a lock, two overlapping runs (the hourly trigger firing while someone
  // clicks a manual refresh, say) could interleave them and stomp on each
  // other's rewrite. Same pattern as setStatus() above.
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = dhKnowledgeSheetEnsure_();
    var sheet = ss.getSheetByName('links');
    var existing = sheet
      .getDataRange()
      .getValues()
      .slice(1)
      .map(function (row) {
        return DH_SCHEMA.rowToKnowledge(row);
      });
    var driveFiles = dhWalkTeamDrive_();
    var plan = DH_KNOWLEDGE.planSync(existing, driveFiles, { now: now });

    // Batched write-then-trim (one read, up to two writes - same read/write
    // batching spirit as dhReconcile_, just reordered) rather than per-row
    // writes: ~100 files today, well within quota either way, but this stays
    // flat as the drive grows. Write-then-trim, NOT clear-then-write (P2
    // review, chatgpt-codex-connector thread PRRT_kwDOTLZBvs6QJ9lW): the
    // `links` tab can hold source=manual rows, which are curated source of
    // truth and never reproducible from a Drive walk (K4) - clearing first
    // left a crash window where a dead execution emptied the tab and a retry
    // lost those rows for good. Writing the new rows first means a mid-write
    // crash leaves the old data intact (worst case: a stale leftover tail,
    // trimmed by the next successful run); range math lives in
    // DH_KNOWLEDGE.planRewriteRanges so it stays pure and node --test-able.
    var oldRowCount = Math.max(sheet.getLastRow() - 1, 0);
    var values = plan.rows.map(function (r) {
      return DH_SCHEMA.knowledgeToRow(r);
    });
    var ranges = DH_KNOWLEDGE.planRewriteRanges(oldRowCount, values.length);
    if (ranges.write)
      sheet
        .getRange(ranges.write.row, 1, ranges.write.numRows, DH_SCHEMA.KNOWLEDGE_COLS.length)
        .setValues(values);
    if (ranges.trim)
      sheet
        .getRange(ranges.trim.row, 1, ranges.trim.numRows, DH_SCHEMA.KNOWLEDGE_COLS.length)
        .clearContent();

    // Null-safe lookup: dhKnowledgeSheetEnsure_ above guarantees `meta`
    // exists on THIS `ss` (it is the fix for the production crash this
    // function used to throw - "Cannot read properties of null (reading
    // 'appendRow')" - when an importer-created spreadsheet had `links` but no
    // `meta` yet), so fetch it off that same ensured reference rather than
    // re-deriving the spreadsheet some other way.
    var metaSheet = ss.getSheetByName('meta');
    metaSheet.appendRow([
      '',
      '',
      '',
      '',
      '',
      '',
      email,
      now,
      'refreshKnowledge: created=' +
        plan.stats.created +
        ' updated=' +
        plan.stats.updated +
        ' unchanged=' +
        plan.stats.unchanged +
        ' staled=' +
        plan.stats.staled,
    ]);

    return {
      total: plan.rows.length,
      created: plan.stats.created,
      updated: plan.stats.updated,
      unchanged: plan.stats.unchanged,
      staled: plan.stats.staled,
      triggeredBy: email,
      at: now,
    };
  } finally {
    lock.releaseLock();
  }
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
  var tickets = values
    .map(function (row) {
      return DH_SCHEMA.rowToTicket(row);
    })
    .filter(function (t) {
      return !t.parentId && t.status !== 'deleted';
    })
    .map(function (t) {
      return {
        id: t.id,
        quote: t.quote,
        context: t.context,
        section: t.section,
        note: t.note,
        type: t.type,
        page: docPath,
        // rawStatus: the lifecycle value before widgetStatus's lossy board-state
        // mapping (WIDGET_STATUS folds both 'declined' and 'anchor-lost' into
        // 'error') - callers that need to tell them apart use this instead.
        status: DH_SCHEMA.widgetStatus(t.status),
        rawStatus: t.status,
        result: t.result,
        files: DH_SCHEMA.filesToArray(t.files),
      };
    });
  return { tickets: tickets };
}

function submitComment(docPath, ticket) {
  ticket = ticket || {};
  var c = dhCommentsFor_(docPath);
  var now = new Date().toISOString();
  var t = {
    id: Utilities.getUuid(),
    parentId: '',
    type: ticket.type === 'strike' ? 'strike' : 'comment',
    status: 'open',
    quote: DH_SCHEMA.sanitizeField(ticket.quote),
    context: DH_SCHEMA.sanitizeField(ticket.context),
    section: DH_SCHEMA.sanitizeField(ticket.section),
    note: DH_SCHEMA.sanitizeField(ticket.note),
    authorEmail: Session.getActiveUser().getEmail(), // client-supplied identity ignored (D17)
    authorName: '',
    source: 'web',
    docVersion: String(c.indexRow.updatedAt || ''),
    result: '',
    files: '',
    createdAt: now,
    updatedAt: now,
  };
  c.ss.getSheetByName('tickets').appendRow(DH_SCHEMA.ticketToRow(t));
  return { id: t.id };
}

function reply(docPath, parentId, note) {
  var c = dhCommentsFor_(docPath);
  var now = new Date().toISOString();
  var t = {
    id: Utilities.getUuid(),
    parentId: DH_SCHEMA.sanitizeField(String(parentId || '')),
    type: 'reply',
    status: 'open',
    quote: '',
    context: '',
    section: '',
    note: DH_SCHEMA.sanitizeField(note),
    authorEmail: Session.getActiveUser().getEmail(),
    authorName: '',
    source: 'web',
    docVersion: '',
    result: '',
    files: '',
    createdAt: now,
    updatedAt: now,
  };
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
        c.ss
          .getSheetByName('meta')
          .appendRow([
            '',
            '',
            '',
            '',
            '',
            '',
            email,
            now,
            'setStatus ' + id + ': ' + oldStatus + ' -> ' + status,
          ]);
        return { id: id, status: status };
      }
    }
    throw new Error('ticket not found: ' + id);
  } finally {
    lock.releaseLock();
  }
}

// --- Knowledge Portal ingestion (Slice B1) --------------------------------
// Two new write paths (Knowledge Portal ingestion design, "Bridge changes
// (fork repo - Slice B1)"). Each is a thin adapter - identity -> read ->
// pure decision -> locked write -> audit append - exactly like every bridge
// function above; all decision logic lives in DH_INGEST/DH_ACCESS
// (gas/lib/), never here (D5/D17(a)).

// publishDesignDoc(input): input is {fileName, contentBase64, title, repo,
// feature, pathInRepo, jira?, confirmUpdate?} from the Manage dialog's
// "Upload design doc" form.
function publishDesignDoc(input) {
  var actor = Session.getActiveUser().getEmail();
  // D17: client-supplied identity is never trusted for WHO is acting - but
  // an empty actor means Session itself couldn't identify anyone at all.
  // Reused as INVALID_INPUT rather than growing the design doc's closed
  // error-code list (INVALID_INPUT/UPLOAD_REJECTED/DUPLICATE_ENTRY/
  // NEEDS_CONFIRM_UPDATE/DOC_HAS_COMMENTS/FORBIDDEN_TARGET/
  // RETRYABLE_UNAVAILABLE) with an 8th code for what should be an
  // unreachable edge case on this DOMAIN-access web app.
  if (!actor) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        field: 'actor',
        message: 'Could not determine your signed-in identity - reload the page and try again.',
      },
    };
  }

  var validated = DH_INGEST.validatePublishInput(input || {});
  if (!validated.ok) return { ok: false, error: validated.error };
  var norm = validated.normalized;
  var segs = norm.pathInRepo.split('/');
  var folderSegs = segs.slice(0, -1);

  // Write-side ACL probe (design doc, "Users and permissions"): resolve the
  // target - the existing file when this will be an update, else the
  // nearest EXISTING ancestor folder walking up toward the configured
  // DesignHub root - and check the ACTING user's real Drive permission on
  // it BEFORE taking the lock or writing anything. A denial fails fast and
  // cheap; nothing is created.
  var target = dhResolveWriteTarget_(norm.repo, norm.featureDir, folderSegs, norm.fileName);
  var decision = DH_ACCESS.decideWrite(
    dhFilePermissions_(target.aclTarget),
    actor,
    dhOwnerEmail_(target.aclTarget)
  );
  if (!decision.allow) {
    return {
      ok: false,
      error: {
        code: 'FORBIDDEN_TARGET',
        message:
          'You do not have write access to "' +
          target.aclTarget.getName() +
          '" in Drive - ask an editor of that folder to grant you access, then try again.',
      },
    };
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (lockErr) {
    return {
      ok: false,
      error: {
        code: 'RETRYABLE_UNAVAILABLE',
        message: 'The system is busy - please try again in a moment.',
      },
    };
  }
  try {
    // Re-resolve fresh now that the lock is held. The ACL probe above ran
    // BEFORE the lock (deliberately, to fail fast on a denial without ever
    // contending for the script-wide lock), so re-resolving here closes the
    // small window between that read and this write under the same single
    // lock every other mutating bridge call already uses to pair its
    // decision with its write (refreshKnowledge, setStatus).
    target = dhResolveWriteTarget_(norm.repo, norm.featureDir, folderSegs, norm.fileName);
    var freshDecision = DH_ACCESS.decideWrite(
      dhFilePermissions_(target.aclTarget),
      actor,
      dhOwnerEmail_(target.aclTarget)
    );
    if (!freshDecision.allow) {
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN_TARGET',
          message:
            'You do not have write access to "' +
            target.aclTarget.getName() +
            '" in Drive - ask an editor of that folder to grant you access, then try again.',
        },
      };
    }
    var now = new Date().toISOString();
    var contentString = Utilities.newBlob(
      Utilities.base64Decode(norm.contentBase64)
    ).getDataAsString('UTF-8');
    var mimeType = norm.type === 'md' ? 'text/markdown' : 'text/html';
    var url = dhExecUrl_() + '?doc=' + norm.docPath.split('/').map(encodeURIComponent).join('/');
    var featureFolder = dhFeatureFolder_(norm.repo, norm.featureDir);
    var indexSheet = dhIndexSheetEnsure_(featureFolder);
    var indexRowsArr = indexSheet.getDataRange().getValues().slice(1);
    var plan;

    if (target.existingFile) {
      var matched = indexRowsArr
        .map(function (r) {
          return DH_SCHEMA.rowToIndex(r);
        })
        .filter(function (r) {
          return r.driveFileId === target.aclTarget.getId();
        });
      var companion = dhCompanionSheetEnsure_(target.parentFolder, norm.fileName);
      var count = dhTicketCountFor_(companion.ticketsSheet);
      var ctx = Object.assign({}, norm, {
        id: Utilities.getUuid(),
        owner: actor,
        driveFileId: target.aclTarget.getId(),
        commentSheetId: companion.ss.getId(),
        url: url,
        now: now,
      });
      plan = DH_INGEST.planPublish(ctx, matched, count);
      if (plan.action === 'needs_confirm') {
        return {
          ok: false,
          error: {
            code: 'NEEDS_CONFIRM_UPDATE',
            message: 'A document already exists at this address. Update it in place?',
          },
        };
      }
      if (plan.action === 'rejected') return { ok: false, error: plan.error };
      // Update-in-place (never delete+recreate) - preserves the file's id,
      // url, and revision history.
      target.aclTarget.setContent(contentString);
    } else {
      var writeFolder = dhEnsureFolderChain_(target.parentFolder, target.missingFolderNames);
      var newFile = writeFolder.createFile(norm.fileName, contentString, mimeType);
      var companion2 = dhCompanionSheetEnsure_(writeFolder, norm.fileName);
      var ctx2 = Object.assign({}, norm, {
        id: Utilities.getUuid(),
        owner: actor,
        driveFileId: newFile.getId(),
        commentSheetId: companion2.ss.getId(),
        url: url,
        now: now,
      });
      plan = DH_INGEST.planPublish(ctx2, [], 0);
    }

    // Upsert into the feature's own _index (D19 direct-upsert, same shape as
    // publish.mjs's Step 6) - DH_ROLLUP.upsertRow is the GAS-side sibling of
    // publish-lib.mjs's upsertRowIndex, reused directly since this side of
    // the fork can import gas/lib/ (unlike the self-contained skill).
    var rowArr = DH_SCHEMA.indexToRow(plan.row);
    var upserted = DH_ROLLUP.upsertRow(indexRowsArr, rowArr);
    indexSheet
      .getRange(2, 1, upserted.rows.length, DH_SCHEMA.INDEX_COLS.length)
      .setValues(upserted.rows);

    // Same row, same upsert-by-driveFileId decision, into the root-level
    // _portal-index (D19, same shape as publish.mjs's Step 7 - the
    // reconciler heals any miss, so this direct upsert is a latency
    // optimization, not the only path to correctness).
    var portalSheet = dhPortalIndexSheetEnsure_();
    var portalRows = portalSheet.getDataRange().getValues().slice(1);
    var portalUpserted = DH_ROLLUP.upsertRow(portalRows, rowArr);
    portalSheet
      .getRange(2, 1, portalUpserted.rows.length, DH_SCHEMA.INDEX_COLS.length)
      .setValues(portalUpserted.rows);

    // Audit append (D17(c)): same companion-Sheet meta-tab shape publish.mjs's
    // own Step 4 append uses, so a bridge-published doc's history reads
    // identically to a CLI-published one. commitSha/pr stay blank - there is
    // no git commit or PR behind a browser upload.
    SpreadsheetApp.openById(plan.row.commentSheetId)
      .getSheetByName('meta')
      .appendRow([
        norm.repo,
        norm.pathInRepo,
        norm.feature,
        '',
        '',
        norm.jira,
        actor,
        now,
        'publishDesignDoc: ' + (target.existingFile ? 'update' : 'create'),
      ]);

    return { ok: true, url: url };
  } finally {
    lock.releaseLock();
  }
}
