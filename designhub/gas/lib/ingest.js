// Knowledge Portal ingestion design (Slice B1) - pure decision logic for the
// Manage dialog's two write paths. Same split as gas/lib/access.js/
// knowledge.js: everything DECIDABLE from plain data lives here (D5), so the
// fork's node --test suite covers every success/error path without a GAS
// runtime; bridge.js (Task 6/7) stays a thin identity -> read -> decide ->
// locked write -> audit adapter around these functions.
var DH_INGEST = (function () {
  // Resolved lazily, like gas/lib/knowledge.js's sanitize_ - clasp pushes
  // files alphabetically, so ingest.js loads before paths.js in the live GAS
  // project; require() only exists under node.
  function paths_() {
    return typeof DH_PATHS !== 'undefined' ? DH_PATHS : require('./paths.js');
  }

  // Design doc's "Validation policy": <=10MB, enforced server-side too (not
  // just the dialog's own client-side file.size check - a malicious or buggy
  // client could skip that). base64 inflates decoded bytes by ~4/3; this is
  // pure arithmetic (no Buffer, no Utilities) so it runs identically under
  // node and GAS.
  var MAX_BYTES = 10 * 1024 * 1024;
  var ALLOWED_EXT = ['md', 'html'];

  function base64DecodedByteLength(b64) {
    var s = String(b64 || '').replace(/\s/g, '');
    var len = s.length;
    if (len === 0) return 0;
    var padding = 0;
    if (s.charAt(len - 1) === '=') padding++;
    if (s.charAt(len - 2) === '=') padding++;
    return Math.floor((len * 3) / 4) - padding;
  }

  function extOf_(fileName) {
    var m = /\.([a-zA-Z0-9]+)$/.exec(String(fileName || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function invalid_(field, message) {
    return { ok: false, error: { code: 'INVALID_INPUT', field: field, message: message } };
  }
  function rejected_(field, message) {
    return { ok: false, error: { code: 'UPLOAD_REJECTED', field: field, message: message } };
  }

  var REQUIRED_FIELDS = ['fileName', 'contentBase64', 'title', 'repo', 'feature', 'pathInRepo'];

  // input: the Manage dialog's "Upload design doc" payload
  // ({fileName, contentBase64, title, repo, feature, pathInRepo, jira?, confirmUpdate?}).
  // Returns {ok:true, normalized:{...}} with every derived field bridge.js
  // needs (featureDir, docPath, type, a defaulted jira, a normalized boolean
  // confirmUpdate), or {ok:false, error:{code, field, message}}.
  function validatePublishInput(input) {
    input = input || {};
    for (var i = 0; i < REQUIRED_FIELDS.length; i++) {
      var f = REQUIRED_FIELDS[i];
      if (!input[f] || !String(input[f]).trim()) return invalid_(f, f + ' is required');
    }
    var ext = extOf_(input.fileName);
    if (ALLOWED_EXT.indexOf(ext) === -1) {
      return rejected_('file', 'Only .md and .html files are supported (got .' + (ext || '?') + ')');
    }
    var bytes = base64DecodedByteLength(input.contentBase64);
    if (bytes > MAX_BYTES) {
      return rejected_('file', 'File is too large (' + bytes + ' bytes) - the limit is 10MB');
    }

    var P = paths_();
    // Reuse DH_PATHS.docPath/parseDocPath for the segment rules (no empty,
    // '.'/'..' segments) rather than reimplementing them - parseDocPath needs
    // a FULL doc path (repo/featureDir/...subpath, >= 3 segments), so build
    // the composite via docPath() first; validating pathInRepo alone would
    // wrongly reject a valid single-segment pathInRepo (e.g. "design.html")
    // against parseDocPath's >= 3 minimum.
    var docPath = P.docPath(input.repo, input.feature, input.pathInRepo);
    try {
      P.parseDocPath(docPath);
    } catch (e) {
      return invalid_('pathInRepo', e.message);
    }

    // pathInRepo's basename must agree with the uploaded fileName: the
    // created Drive file is named after pathInRepo's own last segment (the
    // doc's public address), so a mismatch would silently create a file
    // doGet's own ?doc= resolution could never find again.
    var lastSeg = String(input.pathInRepo).trim().split('/').pop();
    if (lastSeg !== String(input.fileName).trim()) {
      return invalid_(
        'pathInRepo',
        "path-in-repo must end with the uploaded file's name (" + input.fileName + ')'
      );
    }

    var jira = input.jira && String(input.jira).trim() ? String(input.jira).trim() : 'unassigned';
    return {
      ok: true,
      normalized: {
        fileName: String(input.fileName).trim(),
        contentBase64: input.contentBase64,
        title: String(input.title).trim(),
        repo: String(input.repo).trim(),
        feature: String(input.feature).trim(),
        featureDir: P.featureDir(input.feature),
        pathInRepo: String(input.pathInRepo).trim(),
        docPath: docPath,
        jira: jira,
        type: ext === 'md' ? 'md' : 'html',
        confirmUpdate: input.confirmUpdate === true,
      },
    };
  }

  // planPublish: input is validatePublishInput's normalized shape, enriched
  // by the caller (bridge.js) with driveFileId/commentSheetId/url/owner/now
  // (and, for a brand-new doc, id) once those are known from real Drive/
  // Sheets I/O - see this task's own top-of-task design note for exactly
  // when the caller has each of these available. existingIndexRows is
  // either [] (no file at this address) or the single matched _index row
  // object (DH_SCHEMA.INDEX_COLS-keyed) for the file that already exists
  // there - the caller resolves this via a real Drive/Sheets lookup, since a
  // pure function cannot do that lookup itself (D5).
  function planPublish(input, existingIndexRows, companionCommentCount) {
    existingIndexRows = existingIndexRows || [];
    companionCommentCount = companionCommentCount || 0;

    if (existingIndexRows.length === 0) {
      // No collision: unconditional create, matching publish-lib.mjs's
      // newIndexRow field set/order exactly (tags always '' on create - the
      // CLI never sets it either) so a GAS-published row and a Node-CLI-
      // published row are byte-identical once both pass through
      // DH_SCHEMA.indexToRow.
      return {
        action: 'create',
        row: {
          id: input.id,
          type: input.type,
          title: input.title,
          repo: input.repo,
          feature: input.feature,
          jira: input.jira,
          tags: '',
          owner: input.owner,
          driveFileId: input.driveFileId,
          commentSheetId: input.commentSheetId,
          url: input.url,
          status: 'active',
          publishedAt: input.now,
          updatedAt: input.now,
        },
      };
    }

    var existing = existingIndexRows[0];

    // The one-deliberate-carve-out (design doc, "Upload design doc" >
    // Outcomes): a doc with existing feedback comments never updates here,
    // regardless of confirmUpdate - the comment re-anchor pass stays
    // exclusive to /publish-design. Checked BEFORE the confirm gate so a
    // confirmed update on a commented doc still rejects, rather than
    // silently overwriting anchors.
    if (companionCommentCount > 0) {
      return {
        action: 'rejected',
        error: {
          code: 'DOC_HAS_COMMENTS',
          message:
            'This document already has feedback comments - updating it here would break ' +
            'their anchors. Update it with /publish-design, which re-anchors comments.',
        },
      };
    }

    if (!input.confirmUpdate) {
      return { action: 'needs_confirm' };
    }

    // Update-in-place: patches exactly the fields publish-lib.mjs's
    // patchIndexRow patches (title/url/jira/commentSheetId/updatedAt) -
    // everything else (id, driveFileId, tags, owner, status, publishedAt)
    // is PRESERVED from the existing row, never regenerated.
    var row = Object.assign({}, existing, {
      title: input.title,
      url: input.url,
      jira: input.jira,
      commentSheetId: input.commentSheetId,
      updatedAt: input.now,
    });
    return { action: 'update', row: row };
  }

  // Formula-injection defense (same threat class knowledge.js's driveFileToRow
  // already guards against via DH_SCHEMA.sanitizeField): a manual link's
  // title/path/tags/description are free text a user can set to anything,
  // including a leading =/+/-/@ that Sheets would parse as a live formula
  // once appended via bridge.js's createKnowledgeLink -> sheet.appendRow.
  // Resolved lazily like knowledge.js's sanitize_() - clasp pushes files
  // alphabetically, so this file (i) loads before lib/schema.js (s) and
  // DH_SCHEMA would be undefined at load time in the live GAS project.
  function sanitize_(v) {
    return (typeof DH_SCHEMA !== 'undefined') ? DH_SCHEMA.sanitizeField(v)
      : require('./schema.js').sanitizeField(v);
  }

  // Design doc's "Add external link" pinned type list. NOTE: the spec's own
  // dialog copy lists "sheet"/"slides" (informal shorthand) - the real values
  // used everywhere else in this codebase are gsheet/gslides (see this
  // task's top-of-task design note); folder is deliberately excluded (no
  // Drive-native surface concept applies to a manual link).
  var LINK_TYPES = ['link', 'gdoc', 'gsheet', 'gslides', 'pdf', 'video', 'file'];
  // Deliberately NOT the global `URL` class - not reliably available in the
  // Apps Script V8 runtime (a browser/Node platform addition, not core
  // ECMAScript), so this stays a portable regex check, dual-runtime-safe.
  var URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
  var LINK_REQUIRED = ['title', 'url', 'type', 'path'];

  // input: the Manage dialog's "Add external link" payload (title, url,
  // type, path, description, tags - owner is deliberately NOT a field, it is
  // server-stamped from ctx.actorEmail). existingManualRows: the CALLER's
  // source=manual rows only (this function does not filter by source
  // itself - the caller is expected to have already narrowed it, matching
  // the design doc's "reject duplicate URLs among source=manual rows").
  // ctx: {id, actorEmail, nowIso} - all server-derived, never client input.
  function planCreateLink(input, existingManualRows, ctx) {
    input = input || {};
    existingManualRows = existingManualRows || [];
    ctx = ctx || {};

    for (var i = 0; i < LINK_REQUIRED.length; i++) {
      var f = LINK_REQUIRED[i];
      if (!input[f] || !String(input[f]).trim()) {
        return { ok: false, error: { code: 'INVALID_INPUT', field: f, message: f + ' is required' } };
      }
    }
    if (!URL_RE.test(String(input.url).trim())) {
      return { ok: false, error: { code: 'INVALID_INPUT', field: 'url', message: 'Enter a valid http(s) URL' } };
    }
    if (LINK_TYPES.indexOf(input.type) === -1) {
      return {
        ok: false,
        error: { code: 'INVALID_INPUT', field: 'type', message: 'Unsupported link type: ' + input.type },
      };
    }

    var urlLower = String(input.url).trim().toLowerCase();
    var dupe = existingManualRows.filter(function (r) {
      return String(r.url || '').trim().toLowerCase() === urlLower;
    })[0];
    if (dupe) {
      return { ok: false, error: { code: 'DUPLICATE_ENTRY', message: 'Already added as "' + dupe.title + '"' } };
    }

    return {
      ok: true,
      row: {
        id: ctx.id,
        type: input.type,
        title: sanitize_(String(input.title).trim()),
        path: sanitize_(String(input.path).trim()),
        url: String(input.url).trim(),
        driveFileId: '',
        owner: ctx.actorEmail,
        tags: input.tags ? sanitize_(String(input.tags).trim()) : '',
        source: 'manual',
        status: 'active',
        modifiedTime: '',
        syncedAt: '',
        createdAt: ctx.nowIso,
        updatedAt: ctx.nowIso,
        description: input.description ? sanitize_(String(input.description).trim()) : '',
      },
    };
  }

  // dhResolveWriteTarget_'s missingFolderNames is a suffix of the full
  // [repo, featureDir, ...folderSegments] name chain (in creation order),
  // starting wherever Drive's walk first found something missing. The
  // feature folder is always exactly the 2nd entry in that full chain
  // (index 1 - after repo, before any folderSegments). This function tells
  // the caller whether the feature folder still needs to be created as
  // part of THIS SAME chain-creation pass, and if so, at which index
  // within missingFolderNames - so the caller can capture that exact
  // folder object as it's created, rather than re-deriving it with an
  // independent walk that could create a duplicate (see bridge.js's
  // publishDesignDoc for why a duplicate walk is unsafe here).
  // totalNames = 2 (repo, featureDir) + folderSegments.length.
  // Returns -1 if the feature folder already exists (dhResolveWriteTarget_'s
  // walk got past index 1 before finding anything missing) - the caller
  // should look it up directly in that case. Otherwise returns the 0-based
  // index into missingFolderNames whose created folder IS the feature folder.
  function featureFolderIndexInMissing(missingFolderNamesLength, totalNames) {
    var startDepth = totalNames - missingFolderNamesLength;
    if (startDepth >= 2) return -1;
    return 1 - startDepth;
  }

  return {
    base64DecodedByteLength: base64DecodedByteLength,
    validatePublishInput: validatePublishInput,
    planPublish: planPublish,
    planCreateLink: planCreateLink,
    featureFolderIndexInMissing: featureFolderIndexInMissing,
  };
})();
if (typeof module !== 'undefined') module.exports = DH_INGEST;
