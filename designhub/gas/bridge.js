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
  // ACL-gated (P1 fix, review of PR #11): dhCommentsFor_ now denies this
  // resolution for a docPath the ACTING user has no Drive read access to,
  // same as doGet()'s own read-side gate (dhCanRead_, Slice B0) - closing the
  // bypass where any signed-in domain user could read stored ticket data for
  // a doc they cannot open.
  var c = dhCommentsFor_(docPath, Session.getActiveUser().getEmail());
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
  // ACL-gated (P1 fix, review of PR #11) - see listComments' comment above.
  var actorEmail = Session.getActiveUser().getEmail();
  var c = dhCommentsFor_(docPath, actorEmail);
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
    authorEmail: actorEmail, // client-supplied identity ignored (D17)
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
  // ACL-gated (P1 fix, review of PR #11) - see listComments' comment above.
  var actorEmail = Session.getActiveUser().getEmail();
  var c = dhCommentsFor_(docPath, actorEmail);
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
    authorEmail: actorEmail,
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
  // ACL-gated (P1 fix, review of PR #11) - see listComments' comment above.
  var email = Session.getActiveUser().getEmail();
  var c = dhCommentsFor_(docPath, email);
  var sheet = c.ss.getSheetByName('tickets');
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

    // Single unified folder-resolution pass (see this task's design note on
    // dhFeatureFolder_'s "throws before dhEnsureFolderChain_ ever runs" bug):
    // the feature folder (always exactly repo/featureDir, needed for the
    // feature's own _index) and the write folder (where the new file itself
    // lands, possibly deeper if folderSegs is non-empty) must come from the
    // SAME chain-creation walk, never two independent ones - a second
    // independent walk that (re-)creates repo/featureDir would silently fork
    // a duplicate Drive tree, since folder.createFolder() has no unique-name
    // enforcement.
    var featureFolder, writeFolder;
    if (target.existingFile || target.missingFolderNames.length === 0) {
      // The full repo/featureDir/...folderSegs chain already exists -
      // dhFeatureFolder_'s walk is read-only here, so a second lookup is
      // safe (nothing gets created, nothing can duplicate).
      featureFolder = dhFeatureFolder_(norm.repo, norm.featureDir);
      writeFolder = target.parentFolder; // unused when target.existingFile
    } else {
      var totalNames = 2 + folderSegs.length;
      var featureIdx = DH_INGEST.featureFolderIndexInMissing(
        target.missingFolderNames.length,
        totalNames
      );
      var folder = target.parentFolder;
      for (var fi = 0; fi < target.missingFolderNames.length; fi++) {
        folder = folder.createFolder(target.missingFolderNames[fi]);
        if (fi === featureIdx) featureFolder = folder;
      }
      if (featureIdx === -1) featureFolder = dhFeatureFolder_(norm.repo, norm.featureDir);
      writeFolder = folder;
    }
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
      // isExistingFile is always `true` here (this is the `target.existingFile`
      // branch) - passed explicitly rather than inferred from `matched`'s
      // length, so a stale/missing _index row (matched === []) still goes
      // through the needs_confirm/DOC_HAS_COMMENTS gates instead of silently
      // falling through to planPublish's create path (P2 fix, review of PR #11).
      plan = DH_INGEST.planPublish(ctx, true, matched, count);
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
      plan = DH_INGEST.planPublish(ctx2, false, [], 0);
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

// createKnowledgeLink(input): input is {title, url, type, path, description,
// tags} from the Manage dialog's "Add external link" form. owner is NOT a
// field - always server-stamped from Session.
function createKnowledgeLink(input) {
  var actor = Session.getActiveUser().getEmail();
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

  // Write-side ACL probe (P2 fix, CodeRabbit/Codex review of PR #11): before
  // this fix, the only gate on this write path was `actor` being non-empty -
  // any identifiable domain user could write manual links to the deployer-
  // owned `_knowledge-index` regardless of their actual Drive write
  // permission on it. Same pre-lock-probe + post-lock-recheck pattern
  // publishDesignDoc uses above (commit 413d3c4's post-lock ACL recheck
  // fix): resolve the target - the existing `_knowledge-index` Sheet, or the
  // DesignHub root folder it would be created under - and check the ACTING
  // user's real Drive permission on it BEFORE taking the lock or writing
  // anything. A denial fails fast and cheap; nothing is created.
  var target = dhKnowledgeWriteTarget_();
  var decision = DH_ACCESS.decideWrite(dhFilePermissions_(target), actor, dhOwnerEmail_(target));
  if (!decision.allow) {
    return {
      ok: false,
      error: {
        code: 'FORBIDDEN_TARGET',
        message:
          'You do not have write access to "' +
          target.getName() +
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
    // Re-resolve fresh now that the lock is held - closes the same TOCTOU
    // window publishDesignDoc's post-lock recheck closes (commit 413d3c4):
    // a concurrent write between the pre-lock probe and lock acquisition
    // (e.g. someone creating `_knowledge-index` for the first time) could
    // otherwise change what's actually being written to without the ACL
    // decision ever being re-verified against it.
    target = dhKnowledgeWriteTarget_();
    var freshDecision = DH_ACCESS.decideWrite(
      dhFilePermissions_(target),
      actor,
      dhOwnerEmail_(target)
    );
    if (!freshDecision.allow) {
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN_TARGET',
          message:
            'You do not have write access to "' +
            target.getName() +
            '" in Drive - ask an editor of that folder to grant you access, then try again.',
        },
      };
    }
    var ss = dhKnowledgeSheetEnsure_();
    var sheet = ss.getSheetByName('links');
    var existing = sheet
      .getDataRange()
      .getValues()
      .slice(1)
      .map(function (row) {
        return DH_SCHEMA.rowToKnowledge(row);
      });
    // Design doc's "Bridge changes": "rejects duplicate URLs among
    // source=manual rows" - drive-sync rows are filtered out here, before
    // planCreateLink ever sees them, matching that exact scope.
    var manualRows = existing.filter(function (r) {
      return r.source === 'manual';
    });
    var now = new Date().toISOString();
    var ctx = { id: Utilities.getUuid(), actorEmail: actor, nowIso: now };
    var result = DH_INGEST.planCreateLink(input || {}, manualRows, ctx);
    if (!result.ok) return { ok: false, error: result.error };

    sheet.appendRow(DH_SCHEMA.knowledgeToRow(result.row));

    // Audit append (D17(c)): same 6-blanks-then-publisher/publishedAt/note
    // shape refreshKnowledge's own meta append already uses on this exact
    // Sheet - there is no repo/pathInRepo/branch/commitSha/pr/jira context
    // for a manual link, so those six columns stay blank, same as
    // refreshKnowledge's own audit row.
    ss.getSheetByName('meta').appendRow([
      '',
      '',
      '',
      '',
      '',
      '',
      actor,
      now,
      'createKnowledgeLink: ' + result.row.title,
    ]);

    return { ok: true, entry: result.row };
  } finally {
    lock.releaseLock();
  }
}

// --- Portal per-row delete (spec 2026-07-21) -------------------------------
// Two hard-delete write paths, same adapter shape as publishDesignDoc/
// createKnowledgeLink: identity -> validate -> pre-lock ACL probe -> lock ->
// re-resolve + re-check (TOCTOU) -> write -> audit. Error codes reuse the
// existing closed list (INVALID_INPUT/FORBIDDEN_TARGET/RETRYABLE_UNAVAILABLE).

// deleteDesignDoc(docPath): trash the published Drive file + its companion
// comments Sheet, remove the feature _index row (authoritative - the D19
// reconciler rebuilds _portal-index from feature shards, so this is what
// makes the deletion stick) and the _portal-index row (latency optimization,
// reconciler heals a miss). Audit lands on the feature _index's meta tab
// (dhIndexMetaEnsure_) since the companion Sheet is itself trashed.
function deleteDesignDoc(docPath) {
  var actor = Session.getActiveUser().getEmail();
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
  var validated = DH_INGEST.validateDeleteDocPath(docPath);
  if (!validated.ok) return { ok: false, error: validated.error };

  var resolved;
  try {
    resolved = dhResolveDoc_(validated.docPath);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        field: 'docPath',
        message: 'Doc not found - it may already be deleted. Refresh the portal.',
      },
    };
  }
  var decision = DH_ACCESS.decideWrite(
    dhFilePermissions_(resolved.file),
    actor,
    dhOwnerEmail_(resolved.file)
  );
  if (!decision.allow) {
    return {
      ok: false,
      error: {
        code: 'FORBIDDEN_TARGET',
        message:
          'You do not have write access to "' +
          resolved.file.getName() +
          '" in Drive - ask an editor of that file to grant you access.',
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
    // Re-resolve + re-check under the lock (same TOCTOU close as
    // publishDesignDoc): the file could have been deleted or re-ACLed
    // between the pre-lock probe and lock acquisition.
    try {
      resolved = dhResolveDoc_(validated.docPath);
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          field: 'docPath',
          message: 'Doc not found - it may already be deleted. Refresh the portal.',
        },
      };
    }
    var freshDecision = DH_ACCESS.decideWrite(
      dhFilePermissions_(resolved.file),
      actor,
      dhOwnerEmail_(resolved.file)
    );
    if (!freshDecision.allow) {
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN_TARGET',
          message:
            'You do not have write access to "' +
            resolved.file.getName() +
            '" in Drive - ask an editor of that file to grant you access.',
        },
      };
    }

    var fileId = resolved.file.getId();
    var indexSheet = dhIndexSheetEnsure_(resolved.featureFolder);
    var indexRows = indexSheet
      .getDataRange()
      .getValues()
      .slice(1)
      .map(function (r) {
        return DH_SCHEMA.rowToIndex(r);
      });
    var matched = DH_INGEST.findIndexRowByDriveFileId(indexRows, fileId);

    // Write ordering is chosen so EVERY partial failure leaves a state a
    // simple retry of deleteDesignDoc heals (Codex reviews of PR #16):
    // companion Sheet -> index rows -> audit -> the doc file LAST. The doc
    // file is what dhResolveDoc_ resolves by, so as long as it is still
    // live, a retry re-enters this function; trashing it first would make a
    // failure in any later step unretryable ("Doc not found") while leaving
    // stale index rows behind for the reconciler to resurrect. Each step is
    // idempotent on retry: setTrashed on an already-trashed file is a no-op,
    // a deleted row just fails to match (matched === null is legitimate),
    // and a duplicate audit append is harmless (append-only log).
    //
    // A real setTrashed failure on the COMPANION (transient Drive error,
    // permissions) propagates and fails the call cleanly - it must NOT be
    // swallowed as "already gone", or the comments/audit data would silently
    // outlive the doc while we report ok. Only the LOOKUP is tolerant: a
    // missing companion (getFileById throws) is a legitimate stale-index
    // state and proceeds.
    var companionFile = null;
    if (matched && matched.row.commentSheetId) {
      try {
        companionFile = DriveApp.getFileById(matched.row.commentSheetId);
      } catch (e) {
        /* companion already gone - the doc is what the user asked to delete */
      }
    }
    if (companionFile) companionFile.setTrashed(true);
    if (matched) indexSheet.deleteRow(matched.rowNumber);

    var portalSheet = dhPortalIndexSheetEnsure_();
    var portalRows = portalSheet
      .getDataRange()
      .getValues()
      .slice(1)
      .map(function (r) {
        return DH_SCHEMA.rowToIndex(r);
      });
    var portalMatched = DH_INGEST.findIndexRowByDriveFileId(portalRows, fileId);
    if (portalMatched) portalSheet.deleteRow(portalMatched.rowNumber);

    // repo/pathInRepo/branch filled from the resolved doc path (CodeRabbit
    // review of PR #16) so delete rows filter/query alongside publish rows
    // in the same meta sheet; commitSha/pr/jira stay blank - there is no git
    // context behind a portal delete.
    dhIndexMetaEnsure_(indexSheet).appendRow([
      resolved.parsed.repo,
      resolved.parsed.segments.join('/'),
      resolved.parsed.featureDir,
      '',
      '',
      '',
      actor,
      new Date().toISOString(),
      'deleteDesignDoc: ' + validated.docPath + ' (driveFileId=' + fileId + ')',
    ]);

    // The doc file goes LAST (see the ordering comment above).
    resolved.file.setTrashed(true);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// deleteKnowledgeLink(id): remove a source=manual row from `_knowledge-index`
// (spec decision 2 - drive-sync rows are never deletable here; the sync owns
// them). ACL target is the `_knowledge-index` Sheet itself, exactly like
// createKnowledgeLink's write probe.
function deleteKnowledgeLink(id) {
  var actor = Session.getActiveUser().getEmail();
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
  var target = dhKnowledgeWriteTarget_();
  var decision = DH_ACCESS.decideWrite(dhFilePermissions_(target), actor, dhOwnerEmail_(target));
  if (!decision.allow) {
    return {
      ok: false,
      error: {
        code: 'FORBIDDEN_TARGET',
        message:
          'You do not have write access to "' +
          target.getName() +
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
    // Same post-lock ACL re-check as createKnowledgeLink (TOCTOU close).
    target = dhKnowledgeWriteTarget_();
    var freshDecision = DH_ACCESS.decideWrite(
      dhFilePermissions_(target),
      actor,
      dhOwnerEmail_(target)
    );
    if (!freshDecision.allow) {
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN_TARGET',
          message:
            'You do not have write access to "' +
            target.getName() +
            '" in Drive - ask an editor of that folder to grant you access, then try again.',
        },
      };
    }
    var ss = dhKnowledgeSheetEnsure_();
    var sheet = ss.getSheetByName('links');
    var rows = sheet
      .getDataRange()
      .getValues()
      .slice(1)
      .map(function (row) {
        return DH_SCHEMA.rowToKnowledge(row);
      });
    var plan = DH_INGEST.planDeleteLink(id, rows);
    if (!plan.ok) return { ok: false, error: plan.error };

    sheet.deleteRow(plan.rowNumber);
    ss.getSheetByName('meta').appendRow([
      '',
      '',
      '',
      '',
      '',
      '',
      actor,
      new Date().toISOString(),
      'deleteKnowledgeLink: ' + plan.row.title + ' (' + plan.row.url + ')',
    ]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}
