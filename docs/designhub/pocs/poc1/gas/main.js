// DesignHub POC-1: serve a Drive-hosted design HTML through HtmlService with a
// minimal comment widget wired to google.script.run (design.md §9 spike).
//
// Deliberately minimal - proves the four §9 assumptions, not the product:
// rendering fidelity, viewer identity, bridge round-trip, practical limits.

// POC-2 artifacts (Home - R&D/DesignHub-POC/...)
var DEFAULT_DOC = '1acs8dWa-irv4c86CFTw2Cyj916qOAti4'; // design.html
var COMMENTS_SHEET = '1dT1HD7K8bLt0AofnG9n_PkU50MkdT1Jk8aYcK3x9F0c'; // design.html.comments

// POC-3 additions: MD docs render CLIENT-SIDE (D10) with bundled marked +
// mermaid, inlined from Drive so the served page stays fully self-contained
// (no CDN, no external fetches from inside the sandbox).
var MARKED_JS = '1vzm8lmAHB2txtYvB7eh7eqs7C4YgR1Yw';
var MERMAID_JS = '16GQ2nJpwFOsIkB6p8bRxjfRXCClOHIRG';

// POC-3 finding: inlining the 3.5 MB mermaid bundle into a <script> tag gets
// TRUNCATED by HtmlService's write pipeline (~190 KB lost; 39 KB marked is
// fine). Big bundles are therefore served as JS by the same web app via
// ContentService - still no third-party CDN.
function serveAsset_(name) {
  var id = { marked: MARKED_JS, mermaid: MERMAID_JS }[name];
  if (!id) throw new Error('unknown asset: ' + name);
  return ContentService.createTextOutput(DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8'))
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function doGet(e) {
  if (e && e.parameter && e.parameter.asset) return serveAsset_(e.parameter.asset);
  var docId = (e && e.parameter && e.parameter.doc) || DEFAULT_DOC;
  var t0 = Date.now();
  var file = DriveApp.getFileById(docId);
  if (/\.md$/i.test(file.getName())) return serveMd_(file, t0);
  var html = file.getBlob().getDataAsString('UTF-8');
  var readMs = Date.now() - t0;
  html = injectBase_(html);
  var widget = WIDGET_.replace('__READ_MS__', String(readMs)).replace('__SIZE__', String(html.length));
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, widget + '</body>') : html + widget;
  return HtmlService.createHtmlOutput(html)
    .setTitle('DesignHub POC1')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function serveMd_(file, t0) {
  var md = file.getBlob().getDataAsString('UTF-8');
  var markedJs = DriveApp.getFileById(MARKED_JS).getBlob().getDataAsString('UTF-8');
  var mermaidSrc = ScriptApp.getService().getUrl() + '?asset=mermaid';
  var readMs = Date.now() - t0;
  // belt-and-braces: no inlined payload may terminate the script tag early
  var mdJson = JSON.stringify(md).replace(/<\/script/gi, '<\\/script');
  var widget = WIDGET_.replace('__READ_MS__', String(readMs)).replace('__SIZE__', String(md.length));
  var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_top">' +
    '<title>' + file.getName() + '</title>' +
    '<style>body{max-width:920px;margin:2rem auto;padding:0 1rem 4rem;font:16px/1.6 -apple-system,Segoe UI,sans-serif;color:#1a1a1a}' +
    'table{border-collapse:collapse;font-size:14px}td,th{border:1px solid #ccc;padding:4px 8px;vertical-align:top;text-align:left}' +
    'pre{background:#f6f6f6;padding:10px;overflow:auto}code{background:#f2f2f2;padding:1px 4px}' +
    'pre.mermaid{background:none;text-align:center}</style></head><body>' +
    '<div id="md-root">rendering markdown…</div>' +
    '<scr' + 'ipt>' + markedJs + '</scr' + 'ipt>' +
    '<scr' + 'ipt>var MD_SOURCE=' + mdJson + ';\n' +
    'var __t0=Date.now();\n' +
    'var root=document.getElementById("md-root");\n' +
    'root.innerHTML=marked.parse(MD_SOURCE);\n' +
    'window.__mdMs=Date.now()-__t0;\n' +
    'document.querySelectorAll("pre code.language-mermaid").forEach(function(c){\n' +
    '  var d=document.createElement("pre");d.className="mermaid";d.textContent=c.textContent;\n' +
    '  c.parentElement.replaceWith(d);});\n' +
    'var __m=document.createElement("script");__m.src=' + JSON.stringify(mermaidSrc) + ';\n' +
    '__m.onload=function(){\n' +
    '  mermaid.initialize({startOnLoad:false,securityLevel:"strict"});\n' +
    '  mermaid.run().then(function(){window.__renderMs=Date.now()-__t0;}).catch(function(e){window.__renderErr=String(e);});\n' +
    '};\n' +
    '__m.onerror=function(){window.__renderErr="mermaid asset failed to load";};\n' +
    'document.body.appendChild(__m);\n' +
    '</scr' + 'ipt>' + widget + '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle('DesignHub POC3 (md)')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// HtmlService serves in a sandboxed iframe: without an explicit target,
// in-doc links silently fail to navigate (design.md §3.2). But bare #anchor
// links must NOT inherit target="_top" - that navigates the top window into
// the raw googleusercontent sandbox URL (verified in this POC). Rewrite them
// to target="_self" so fragment navigation stays inside the content frame.
function injectBase_(html) {
  var base = '<base target="_top">';
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, function (m) { return m + base; }) : base + html;
  return html.replace(/<a\s([^>]*href="#)/gi, '<a target="_self" $1');
}

function getIdentity(clientClaim) {
  return { server: Session.getActiveUser().getEmail(), clientClaim: clientClaim || null };
}

// The bridge. D17 containment: authorEmail is stamped server-side from the
// session; whatever identity the client claims is stored NOWHERE - it is
// returned in the ack only so the test can prove it was ignored.
function submitComment(ticket) {
  ticket = ticket || {};
  var email = Session.getActiveUser().getEmail();
  var now = new Date().toISOString();
  var row = [Utilities.getUuid(), '', ticket.type || 'comment', 'open',
    ticket.quote || '', ticket.context || '', ticket.section || '',
    ticket.note || '', email, '', 'web', '', '', '', now, now];
  SpreadsheetApp.openById(COMMENTS_SHEET).getSheetByName('tickets').appendRow(row);
  return { ok: true, storedAuthorEmail: email, ignoredClientClaim: ticket.authorEmail || null, rowId: row[0] };
}

// Minimal widget: status bar + select-to-comment + identity display.
// window.__ccfbSubmit is exposed so a "doc script" can call the bridge
// directly - that is exactly the D17 forged-identity scenario under test.
var WIDGET_ = '<div id="ccfb-poc" style="position:fixed;bottom:0;left:0;right:0;background:#111;color:#eee;' +
  'font:13px/1.4 monospace;padding:6px 10px;z-index:99999;display:flex;gap:14px;align-items:center">' +
  '<b>POC1</b><span id="ccfb-id">identity: ?</span><span id="ccfb-meta">read __READ_MS__ms, __SIZE__ bytes</span>' +
  '<span id="ccfb-sel">select text to comment</span>' +
  '<button id="ccfb-btn" disabled>Comment</button><span id="ccfb-status"></span></div>' +
  '<scr' + 'ipt>(function(){\n' +
  'var $=function(id){return document.getElementById(id)};\n' +
  'google.script.run.withSuccessHandler(function(r){$("ccfb-id").textContent="identity: "+(r.server||"EMPTY!")})' +
  '.withFailureHandler(function(e){$("ccfb-id").textContent="identity ERROR: "+e.message}).getIdentity(null);\n' +
  'var sel=null,bar=$("ccfb-poc");\n' +
  'document.addEventListener("selectionchange",function(){\n' +
  '  var s=window.getSelection();\n' +
  '  if(s&&s.toString().trim().length>2&&!bar.contains(s.anchorNode)){\n' +
  '    sel=s.toString().trim().slice(0,300);\n' +
  '    $("ccfb-sel").textContent=JSON.stringify(sel.slice(0,40)+"...");\n' +
  '    $("ccfb-btn").disabled=false;\n' +
  '  }\n' +
  '});\n' +
  '$("ccfb-btn").addEventListener("click",function(){\n' +
  '  window.__ccfbSubmit({type:"comment",quote:sel,note:"poc1 widget comment",authorEmail:"client-claims@forged.example"});\n' +
  '});\n' +
  'window.__ccfbSubmit=function(t){\n' +
  '  $("ccfb-status").textContent="sending...";\n' +
  '  google.script.run.withSuccessHandler(function(r){\n' +
  '    $("ccfb-status").textContent="stored as "+r.storedAuthorEmail+" (claim "+r.ignoredClientClaim+" ignored) id="+r.rowId;\n' +
  '  }).withFailureHandler(function(e){$("ccfb-status").textContent="ERROR "+e.message}).submitComment(t);\n' +
  '};\n' +
  '})();</scr' + 'ipt>';
