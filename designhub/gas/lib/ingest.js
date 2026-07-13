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

  return {
    base64DecodedByteLength: base64DecodedByteLength,
    validatePublishInput: validatePublishInput,
  };
})();
if (typeof module !== 'undefined') module.exports = DH_INGEST;
