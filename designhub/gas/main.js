// doGet router: tree (no params) | ?doc=<path> (serve html/md + widget) |
// ?asset=widget|marked|mermaid (ContentService JS - poc3: big bundles must
// NOT be inlined, HtmlService truncates giant inline scripts).

function dhExecUrl_() { return ScriptApp.getService().getUrl(); }

function dhAsset_(name) {
  if (name === 'widget') {
    return ContentService.createTextOutput(HtmlService.createHtmlOutputFromFile('widget').getContent())
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  var id = DH_CONFIG.assets[name];
  if (!id) throw new Error('unknown asset: ' + name);
  return ContentService.createTextOutput(DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8'))
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.asset) return dhAsset_(p.asset);
  if (!p.doc) {
    return HtmlService.createHtmlOutput(DH_RENDER.treeHtml(dhPortalRows_()))
      .setTitle('DesignHub').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  // A stale bookmark, typo, or deleted/renamed doc would otherwise surface as
  // GAS's generic, unbranded uncaught-exception page - render DesignHub's own
  // not-found page instead. The thrown message only echoes the caller's own
  // ?doc= input, so there's nothing sensitive to leak into it.
  var r;
  try {
    r = dhResolveDoc_(p.doc);
  } catch (err) {
    return HtmlService.createHtmlOutput(DH_RENDER.notFoundHtml(p.doc))
      .setTitle('DesignHub - not found').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  var out;
  if (/\.md$/i.test(r.parsed.fileName)) {
    var md = r.file.getBlob().getDataAsString('UTF-8');
    var markedJs = DriveApp.getFileById(DH_CONFIG.assets.marked).getBlob().getDataAsString('UTF-8');
    var shell = DH_RENDER.mdShell(md, markedJs, dhExecUrl_() + '?asset=mermaid', r.parsed.fileName);
    // Splice the widget in at the shell's KNOWN tail. A replace of the FIRST
    // '</body></html>' would hit a literal one inside the MD_SOURCE JSON string
    // if the markdown ever quotes closing tags - and widgetTags contains real
    // </script> sequences, which would truncate that script block.
    var tail = '</body></html>';
    out = shell.slice(0, shell.length - tail.length) +
      DH_RENDER.widgetTags(p.doc, dhExecUrl_()) + tail;
  } else {
    out = DH_RENDER.serveHtml(r.file.getBlob().getDataAsString('UTF-8'), p.doc, dhExecUrl_());
  }
  return HtmlService.createHtmlOutput(out)
    .setTitle('DesignHub - ' + r.parsed.fileName)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
