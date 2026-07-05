#!/usr/bin/env node
/* Build the DesignHub widget variant from UNTOUCHED upstream feedback-widget.html.
 *   node designhub/build-designhub.js          - write designhub/gas/widget.html
 *   node designhub/build-designhub.js --check  - verify output matches source; exit 1 on drift
 * Transport swap: fetch /__ccfb/* + SSE -> google.script.run bridge (design D16, section 6).
 * FAIL-LOUD CONTRACT: every anchor string below must occur exactly once in the
 * upstream source; if upstream refactors, this build BREAKS instead of shipping
 * a silently wrong widget. Fix by updating the anchors after reviewing the change.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'gas', 'widget.html');

function fail(msg) { console.error('build-designhub.js: ' + msg); process.exit(1); }

function replaceOnce(body, anchor, replacement, label) {
  const i = body.indexOf(anchor);
  if (i === -1) throw new Error('anchor not found (' + label + '): upstream feedback-widget.html changed - review and update build-designhub.js');
  if (body.indexOf(anchor, i + 1) !== -1) throw new Error('anchor not unique (' + label + ')');
  return body.slice(0, i) + replacement + body.slice(i + anchor.length);
}

function transform(src) {
  // -- extraction: same structural contract as upstream build.js --
  const grab = (re, label) => {
    const m = src.match(re);
    if (!m) throw new Error('could not find ' + label);
    return m[1];
  };
  const css = grab(/<style>([\s\S]*?)<\/style>/, '<style> block').trim();
  const markup = grab(/<\/style>([\s\S]*?)<script>/, 'markup').trim().replace(/^<!--[\s\S]*?-->\s*/, '');
  const scriptFull = grab(/<script>([\s\S]*?)<\/script>/, '<script> block').trim();
  const iife = scriptFull.match(/^\(function\(\)\{([\s\S]*)\}\)\(\);?$/);
  if (!iife) throw new Error('source <script> must be a single bare IIFE');
  let body = iife[1];

  // -- R1: submit goes through the bridge; shim keeps the fetch-Response shape
  //    submitDraft() relies on: r.ok, r.json() -> {id} --
  body = replaceOnce(body,
    "function ccfbPost(t){ return fetch(ccfbBase() + '/__ccfb/tickets', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(t) }); }",
    "function ccfbPost(t){ return dhRun('submitComment', window.__CCFB.docPath, t).then(function(row){ return { ok: true, status: 200, json: function(){ return Promise.resolve(row); } }; }); }",
    'ccfbPost');

  // -- R2: board pull via bridge; success doubles as the liveness signal --
  body = replaceOnce(body,
    "function loadTickets(){ fetch(ccfbBase() + '/__ccfb/tickets?' + pageParam()).then(r => r.json()).then(d => reconcile(d.tickets || [])).catch(() => {}); }",
    "function loadTickets(){ dhRun('listComments', window.__CCFB.docPath).then(function(d){ reconcile(d.tickets || []); setConn('live'); }).catch(function(){ setConn('offline'); }); }",
    'loadTickets');

  // -- R3: SSE -> 30 s polling (v1 drops live push per design section 6) --
  const sse = body.match(/  function subscribeSSE\(\)\{[\s\S]*?\n  \}/);
  if (!sse) throw new Error('anchor not found (subscribeSSE block)');
  if (!/EventSource/.test(sse[0])) throw new Error('subscribeSSE block does not contain EventSource - refusing to replace');
  body = replaceOnce(body, sse[0],
    "  function subscribeSSE(){ setConn('connecting'); setInterval(loadTickets, 30000); }",
    'subscribeSSE');

  // -- R4: Clean stays local-only (the Sheet is the durable record) --
  body = replaceOnce(body,
    "    if(CCFB) fetch(ccfbBase() + '/__ccfb/clean', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ page: location.href }) }).catch(() => {});",
    "    /* DesignHub: Clean clears the local view only - comments stay in the Sheet. */",
    'clean handler');

  // -- R5: page keying by doc path. After R4, exactly 9 location.href remain
  //    (FILE x2, restore-time reanchor, the CODE COMMENT above add()'s new-entry
  //    line, new-entry page, reconcile re-anchor guard, morph fetch [dead in
  //    proxy mode], morph re-anchor, pageParam [now unused]). The global replace
  //    also rewrites the comment occurrence - harmless. --
  const count = (body.match(/location\.href/g) || []).length;
  if (count !== 9) throw new Error('expected exactly 9 location.href sites after clean removal, found ' + count + ' - upstream changed, re-audit page keying');
  body = body.replace(/location\.href/g, 'dhPage()');

  // -- prepend the bridge helpers (function declarations hoist above first use) --
  body = "\n  function dhPage(){ return (window.__CCFB && window.__CCFB.docPath) || location.href; }\n" +
    "  function dhRun(fn){ var args = [].slice.call(arguments, 1); return new Promise(function(res, rej){ var r = google.script.run.withSuccessHandler(res).withFailureHandler(rej); r[fn].apply(r, args); }); }\n" + body;

  // Upstream comment lines legitimately mention /__ccfb/ (the draft-persistence
  // block documents the old GET endpoint) - guard on code lines only.
  const codeOnly = body.split('\n').filter(function (l) { return !l.trim().startsWith('//'); }).join('\n');
  if (/\/__ccfb\//.test(codeOnly)) throw new Error('a /__ccfb/ endpoint survived the transform');

  const esc = s => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return `/*! widget-designhub.js - the cc-htmlfeedback widget with google.script.run transport.
 * GENERATED from upstream feedback-widget.html by designhub/build-designhub.js - NEVER EDIT.
 * Served by the DesignHub web app as ?asset=widget (never inlined - HtmlService
 * truncates giant inline scripts, see docs/designhub/pocs/poc3). */
(function(){
  if (window.__fbWidgetLoaded || document.getElementById('fb-launch')) return;
  window.__fbWidgetLoaded = true;
  var FB_CSS = \`${esc(css)}\`;
  var FB_MARKUP = \`${esc(markup)}\`;
  function fbInit(){
    if (document.getElementById('fb-launch')) return;
    var st = document.createElement('style'); st.textContent = FB_CSS; document.head.appendChild(st);
    var tpl = document.createElement('template'); tpl.innerHTML = FB_MARKUP; document.body.appendChild(tpl.content);
${body}
  }
  if (document.body) fbInit();
  else document.addEventListener('DOMContentLoaded', fbInit);
})();
`;
}

function main() {
  const src = fs.readFileSync(path.join(root, 'feedback-widget.html'), 'utf8');
  let out;
  try { out = transform(src); } catch (e) { fail(e.message); }
  if (process.argv.includes('--check')) {
    const disk = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (disk !== out) fail('designhub/gas/widget.html is stale - run: node designhub/build-designhub.js');
    console.log('build-designhub: up to date');
    return;
  }
  fs.writeFileSync(OUT, out);
  console.log('wrote ' + OUT + ' (' + out.length + ' bytes)');
}

if (require.main === module) main();
module.exports = { transform };
