#!/usr/bin/env node
/* Build the DesignHub widget variant from UNTOUCHED upstream feedback-widget.html.
 *   node designhub/build-designhub.js          - write designhub/gas/widget.js
 *   node designhub/build-designhub.js --check  - verify output matches source; exit 1 on drift
 * Transport swap: fetch /__ccfb/* + SSE -> google.script.run bridge (design D16, section 6).
 * FAIL-LOUD CONTRACT: every anchor string below must occur exactly once in the
 * upstream source; if upstream refactors, this build BREAKS instead of shipping
 * a silently wrong widget. Fix by updating the anchors after reviewing the change.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'gas', 'widget.js');

function fail(msg) { console.error('build-designhub.js: ' + msg); process.exit(1); }

function replaceOnce(body, anchor, replacement, label) {
  const i = body.indexOf(anchor);
  if (i === -1) throw new Error('anchor not found (' + label + '): upstream feedback-widget.html changed - review and update build-designhub.js');
  if (body.indexOf(anchor, i + 1) !== -1) throw new Error('anchor not unique (' + label + '): the exact text "' + anchor + '" occurs more than once - upstream duplicated or restructured this code; narrow the anchor and update build-designhub.js');
  return body.slice(0, i) + replacement + body.slice(i + anchor.length);
}

// Parse-only validity check (node --check on a temp file) rather than new
// Function()/eval, which would construct a live, invocable function from
// generated text - unnecessary here and an avoidable code-smell even though
// nothing untrusted flows through this build-time-only script. Shared by both
// transform()'s backstop (catches a truncated/malformed body) and main()'s
// check on the final wrapped file (catches a wrapping-layer bug - belt and
// braces, since ES2019's JSON-is-a-JS-subset guarantee already makes the
// second check provably redundant for well-formed input).
function assertValidJs(content, label) {
  const f = path.join(os.tmpdir(), 'ccfb-designhub-' + label + '-' + process.pid + '-' + Date.now() + '.js');
  try {
    fs.writeFileSync(f, content);
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    const detail = (e.stderr ? e.stderr.toString() : e.message).trim();
    throw new Error('generated ' + label + ' is not valid JavaScript:\n' + detail);
  } finally {
    try { fs.unlinkSync(f); } catch { /* best-effort cleanup */ }
  }
}

function transform(src) {
  // -- extraction: same structural contract as upstream build.js --
  // Structural invariants the positional extraction below silently relies on: grab() takes
  // the FIRST <style>/<script> block non-greedily, so a second one added upstream would be
  // silently dropped rather than erroring. Assert the count up front instead (mirrors build.js).
  const countOf = re => (src.match(re) || []).length;
  if (countOf(/<style>/g) !== 1) throw new Error('expected exactly one <style> block in feedback-widget.html, found ' + countOf(/<style>/g) + ' - upstream added/removed a block; review the new structure before updating the extraction regexes');
  if (countOf(/<script>/g) !== 1) throw new Error('expected exactly one <script> block in feedback-widget.html, found ' + countOf(/<script>/g) + ' - upstream added/removed a block; review the new structure before updating the extraction regexes');
  const grab = (re, label) => {
    const m = src.match(re);
    if (!m) throw new Error('could not find ' + label + ' in feedback-widget.html (expected ' + re + '): upstream structure changed - review and update build-designhub.js');
    return m[1];
  };
  const css = grab(/<style>([\s\S]*?)<\/style>/, '<style> block').trim();
  let markup = grab(/<\/style>([\s\S]*?)<script>/, 'markup between </style> and <script>').trim().replace(/^<!--[\s\S]*?-->\s*/, '');
  const scriptFull = grab(/<script>([\s\S]*?)<\/script>/, '<script> block').trim();
  const iife = scriptFull.match(/^\(function\(\)\{([\s\S]*)\}\)\(\);?$/);
  if (!iife) throw new Error('source <script> must be a single bare IIFE: (function(){ ... })() - wrapper not found, upstream changed');
  let body = iife[1];
  if (css.length < 100 || markup.length < 100 || body.length < 100) {
    throw new Error('extraction produced suspiciously small output (css ' + css.length + ', markup ' + markup.length + ', body ' + body.length + ') - check the source structure');
  }

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

  // -- R6: DesignHub v1 has no agent consumption loop yet (design.md phase 2) -
  //    "Fix" promises an immediate live edit the local tool actually performs;
  //    here a submission only becomes a TODO row in the Sheet. Relabel the
  //    fast-path terminology so it matches what actually happens. Local tool
  //    keeps "Fix" verbatim - it really does trigger one. --
  body = replaceOnce(body,
    '      ? \'<button class="fb-fixbtn" type="button" title="Send to the agent to fix" aria-label="Send to the agent to fix\' + (quoteSnippet ? \': \' + esc(quoteSnippet) : \'\') + \'">⚡ Fix</button>\'',
    '      ? \'<button class="fb-fixbtn" type="button" title="Submit to the board" aria-label="Submit to the board\' + (quoteSnippet ? \': \' + esc(quoteSnippet) : \'\') + \'">⚡ Submit</button>\'',
    'fix button label');
  body = replaceOnce(body,
    "      fixAllBtn.textContent = '⚡ Fix all (' + draftCount + ')';\n      fixAllBtn.setAttribute('aria-label', 'Fix all ' + draftCount + ' draft' + (draftCount === 1 ? '' : 's'));",
    "      fixAllBtn.textContent = '⚡ Submit all (' + draftCount + ')';\n      fixAllBtn.setAttribute('aria-label', 'Submit all ' + draftCount + ' draft' + (draftCount === 1 ? '' : 's'));",
    'fix-all button label');
  body = replaceOnce(body,
    "        if(!ok){ showToast('Fix all stopped - ' + sent + ' sent, ' + visibleItems().filter(x => x.draft).length + ' kept as drafts', true); return; }",
    "        if(!ok){ showToast('Submit all stopped - ' + sent + ' sent, ' + visibleItems().filter(x => x.draft).length + ' kept as drafts', true); return; }",
    'fix-all-stopped toast');
  body = replaceOnce(body,
    "    showToast('Saved as draft - nothing is sent until you click Fix', false, 4000);",
    "    showToast('Saved as draft - nothing is sent until you click Submit', false, 4000);",
    'draft-saved toast');
  body = replaceOnce(body,
    "      if (fixNow) { submitDraft(f); showToast('Sent to the agent'); }",
    "      if (fixNow) { submitDraft(f); showToast('Submitted'); }",
    'fix-now toast');
  body = replaceOnce(body,
    "    connEl.title = working ? ('Agent is working on ' + n + ' comment' + (n === 1 ? '' : 's') + ' on this page')\n      : connState === 'live' ? 'Connected - agent is idle'\n      : connState === 'connecting' ? 'Connecting to the agent session…'\n      : 'Run /cc-htmlfeedback to enable live fixes';",
    "    connEl.title = working ? ('In progress: ' + n + ' comment' + (n === 1 ? '' : 's') + ' on this page')\n      : connState === 'live' ? 'Connected'\n      : connState === 'connecting' ? 'Connecting…'\n      : 'Not connected';",
    'connection status tooltip');
  // Static initial tooltip (markup, not body) - paintConn() overwrites this within
  // milliseconds of load, but fixing the source avoids a local-tool-flavored flash.
  markup = replaceOnce(markup,
    '<span id="fb-conn" class="fb-conn" title="Run /cc-htmlfeedback to enable live fixes" aria-hidden="true"></span>',
    '<span id="fb-conn" class="fb-conn" title="Not connected" aria-hidden="true"></span>',
    'initial connection tooltip (markup)');

  // -- R7: the ✕ (discard) button is upstream's per-tab-only "hide" (setRemoved
  //    never reaches the server - see feedback-widget.html's own "apply = remove,
  //    revert = restore" comment on discard()). In DesignHub the Sheet is a real
  //    shared record, so a ✕ on an already-submitted ticket (f.sid set) also
  //    calls the bridge to mark it 'deleted' - filtered out of listComments for
  //    everyone (bridge.js), audited via setStatus's existing meta-tab log
  //    (D17(c)). A still-local draft (no sid yet) has nothing to delete
  //    server-side, so it's left as a plain local discard, same as upstream.
  //    Known gap: Ctrl/Cmd+Z undo only restores the local view, not the
  //    server-side status - reversing a DesignHub delete needs a fresh comment.
  body = replaceOnce(body,
    '  function discard(id){ setRemoved(id, true); record(() => setRemoved(id, true), () => setRemoved(id, false)); } // apply = remove, revert = restore',
    "  function discard(id){ setRemoved(id, true); record(() => setRemoved(id, true), () => setRemoved(id, false));" +
      " var f = store[id]; if(f && f.sid) dhRun('setStatus', dhPage(), f.sid, 'deleted').catch(() => {});" +
      " } // apply = remove, revert = restore (DesignHub: also deletes server-side once submitted)",
    'discard handler');

  // -- prepend the bridge helpers (function declarations hoist above first use) --
  body = "\n  function dhPage(){ return (window.__CCFB && window.__CCFB.docPath) || location.href; }\n" +
    "  function dhRun(fn){ var args = [].slice.call(arguments, 1); return new Promise(function(res, rej){ var r = google.script.run.withSuccessHandler(res).withFailureHandler(rej); r[fn].apply(r, args); }); }\n" + body;

  // Upstream comment lines legitimately mention /__ccfb/ (the draft-persistence
  // block documents the old GET endpoint) - guard on code lines only.
  const codeOnly = body.split('\n').filter(function (l) { return !l.trim().startsWith('//'); }).join('\n');
  if (/\/__ccfb\//.test(codeOnly)) throw new Error('a /__ccfb/ endpoint survived the transform');

  const esc = s => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  const out = `/*! widget.js - the cc-htmlfeedback widget with google.script.run transport.
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

  // Final backstop: the regex-based extraction/replacement above can - in principle - produce
  // a truncated or malformed body (e.g. a non-greedy anchor regex stopping at an unrelated brace
  // introduced by an upstream reformat) without any single check above catching it. Parsing the
  // FULL generated output catches that class of bug regardless of which step caused it.
  try {
    assertValidJs(out, 'widget.js (raw transform output)');
  } catch (e) {
    throw new Error(e.message + '\nThe transform likely produced a truncated/malformed body - re-check the R1-R5 anchors and the subscribeSSE regex against the current upstream structure');
  }

  return out;
}

// Wrapped as a plain script-scope JS string (a .js project file), NOT served via
// HtmlService.createHtmlOutputFromFile: verified empirically against the real
// deployed app (Task 13 E2E) that Chrome's Opaque Response Blocking (ORB) blocks
// an HtmlService-sourced ContentService response when fetched as a <script>
// subresource from inside the sandboxed content iframe - both as a static
// server-embedded <script src> tag AND as a dynamically-created one. A plain
// ContentService.createTextOutput(scriptScopeStringVar) response does not
// trigger it (matches the already-proven marked/mermaid asset routes, which
// read their content from DriveApp, never touching HtmlService).
function wrap(out) {
  return '// GENERATED by designhub/build-designhub.js from upstream feedback-widget.html - NEVER EDIT.\n' +
    '// Served by the DesignHub web app as ?asset=widget via plain ContentService,\n' +
    '// not HtmlService - see the comment above wrap() in build-designhub.js for why.\n' +
    'var DH_WIDGET_JS = ' + JSON.stringify(out) + ';\n' +
    "if (typeof module !== 'undefined') module.exports = DH_WIDGET_JS;\n";
}

function main() {
  const src = fs.readFileSync(path.join(root, 'feedback-widget.html'), 'utf8');
  let out;
  try { out = transform(src); } catch (e) { fail(e.message); }
  const wrapped = wrap(out);
  // Belt and braces: transform() already validated `out` in isolation, but this
  // checks the file exactly as GAS will load it (the var declaration + the
  // module.exports tail too) - provably redundant given ES2019's JSON-is-a-JS-
  // subset guarantee, but cheap enough to close the loop completely.
  try {
    assertValidJs(wrapped, 'widget.js (wrapped output)');
  } catch (e) {
    fail(e.message);
  }
  if (process.argv.includes('--check')) {
    const disk = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (disk !== wrapped) fail('designhub/gas/widget.js is stale - run: node designhub/build-designhub.js');
    console.log('build-designhub: up to date');
    return;
  }
  fs.writeFileSync(OUT, wrapped);
  console.log('wrote ' + OUT + ' (' + wrapped.length + ' bytes)');
}

if (require.main === module) main();
module.exports = { transform, wrap };
