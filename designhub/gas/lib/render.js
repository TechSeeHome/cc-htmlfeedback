// Pure HTML builders for the serving layer. Everything here is verified POC
// behavior: base+anchor handling (poc1), the MD shell (poc3), widget injection
// (same pattern as upstream lib/inject.js, adapted for GAS transport).
var DH_RENDER = (function () {
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Scheme allowlist for hrefs built from stored data (treeHtml's r.url comes
  // from the _portal-index Sheet, editable directly by anyone with Contributor
  // Shared Drive access (D18) - not just via the publish flow that normally
  // writes it). esc() alone stops attribute breakout but not a javascript:/data:
  // URI, which needs no HTML-special characters to run on click. Only http(s)
  // and scheme-less refs (e.g. "#") pass; anything else is replaced with "#".
  function safeHref(u) {
    u = String(u == null ? '' : u);
    // Match how browsers parse a URL's scheme: they strip leading/trailing C0
    // control chars + space and remove ALL tab/CR/LF from anywhere in the
    // string before ever looking at the scheme - so "  java\tscript:alert(1)"
    // still runs as javascript: unless checked against the same normalization.
    var normalized = u.replace(/[\t\r\n]/g, '').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
    return /^https?:\/\//i.test(normalized) || !/^[a-z][a-z0-9+.-]*:/i.test(normalized) ? u : '#';
  }
  // <base target="_top"> is required or in-doc navigation silently fails in the
  // HtmlService iframe - but bare #anchors must NOT inherit it (they would
  // navigate the top window into the raw googleusercontent sandbox URL, losing
  // the page). Both verified in poc1.
  function injectBase(html) {
    var base = '<base target="_top">';
    html = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, function (m) { return m + base; })
      : (function() {
          var doctypeMatch = html.match(/^(\s*)<!doctype[^>]*>/i);
          return doctypeMatch ? html.slice(0, doctypeMatch[0].length) + '\n' + base + html.slice(doctypeMatch[0].length) : base + html;
        })();
    return html.replace(/<a\s([^>]*href=["']#)/gi, '<a target="_self" $1');
  }
  function widgetTags(docPath, execUrl) {
    var cfg = { endpoint: '', sessionId: 'designhub', mode: 'proxy',
      ns: 'dh:' + docPath, docPath: docPath };
    // docPath traces back to the raw ?doc= query value - parseDocPath (D14) only
    // rejects empty/./.. segments, not HTML-special characters, so a doc whose
    // real repo/folder/file names straddle a "/" (e.g. adjacent path components
    // "foo<" and "script>x.html") can carry a literal </script> substring
    // through untouched. JSON.stringify does not escape "<" or "/", so without
    // defusing it here the same class of bug mdShell already guards against for
    // MD_SOURCE would let that docPath break out of this inline script.
    var cfgJson = JSON.stringify(cfg).replace(/<\/script/gi, '<\\/script');
    // mode:'proxy' makes the upstream widget's scheduleApply() a no-op (no DOM
    // morphing - re-fetching the exec URL from inside the sandbox is meaningless).
    return '<scr' + 'ipt>window.__CCFB=' + cfgJson + ';</scr' + 'ipt>' +
      '<scr' + 'ipt src="' + esc(execUrl) + '?asset=widget"></scr' + 'ipt>' +
      // identity chip: shows the Google identity the bridge will stamp (D13/D17)
      '<scr' + 'ipt>(function(){var n=0,t=setInterval(function(){' +
      'var h=document.querySelector("#fb-panel .fb-head");' +
      'if((!h||!window.google)&&++n<40)return;clearInterval(t);if(!h||!window.google)return;' +
      'google.script.run.withSuccessHandler(function(r){var d=document.createElement("div");' +
      'd.id="dh-identity";d.style.cssText="font:11px monospace;color:#5b6072;padding:2px 0";' +
      'd.textContent="signed in as "+(r.server||"unknown");h.appendChild(d);}).getIdentity();' +
      '},500);})();</scr' + 'ipt>';
  }
  function serveHtml(html, docPath, execUrl) {
    html = injectBase(html);
    var tags = widgetTags(docPath, execUrl);
    if (/<\/body>/i.test(html)) {
      var lastIdx = -1;
      for (var i = html.length - 1; i >= 0; i--) {
        if (html.slice(i, i + 7).toLowerCase() === '</body>') {
          lastIdx = i;
          break;
        }
      }
      return lastIdx >= 0 ? html.slice(0, lastIdx) + tags + html.slice(lastIdx) : html + tags;
    }
    return html + tags;
  }
  // MD shell (poc3): marked inline (39 KB, proven safe), mermaid via asset URL
  // (3.5 MB - inlining it gets truncated by HtmlService). Progressive: text
  // renders in ~50 ms, diagrams pop in when the mermaid asset lands.
  function mdShell(md, markedJs, mermaidSrc, title) {
    var mdJson = JSON.stringify(md).replace(/<\/script/gi, '<\\/script');
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_top">' +
      '<title>' + esc(title) + '</title>' +
      '<style>body{max-width:920px;margin:2rem auto;padding:0 1rem 4rem;' +
      'font:16px/1.6 -apple-system,Segoe UI,sans-serif;color:#1a1a1a}' +
      'table{border-collapse:collapse;font-size:14px}td,th{border:1px solid #ccc;' +
      'padding:4px 8px;vertical-align:top;text-align:left}' +
      'pre{background:#f6f6f6;padding:10px;overflow:auto}code{background:#f2f2f2;padding:1px 4px}' +
      'pre.mermaid{background:none;text-align:center}</style></head><body>' +
      '<div id="md-root">rendering markdown…</div>' +
      '<scr' + 'ipt>' + markedJs + '</scr' + 'ipt>' +
      '<scr' + 'ipt>var MD_SOURCE=' + mdJson + ';\n' +
      'var root=document.getElementById("md-root");\n' +
      'root.innerHTML=marked.parse(MD_SOURCE);\n' +
      // poc1 MANDATORY rewrite, MD flavor: marked renders <a href="#..."> at
      // runtime, after injectBase-style source rewrites could ever see them -
      // without target="_self" a TOC click navigates the TOP window into the
      // raw googleusercontent sandbox URL (page + widget lost). marked emits no
      // heading ids in v1 (poc3), so these clicks are safe no-ops until
      // marked-gfm-heading-id lands (backlog).
      'document.querySelectorAll("a").forEach(function(a){var h=a.getAttribute("href");if(h&&h.charAt(0)==="#")a.target="_self";});\n' +
      'document.querySelectorAll("pre code.language-mermaid").forEach(function(c){\n' +
      '  var d=document.createElement("pre");d.className="mermaid";d.textContent=c.textContent;\n' +
      '  c.parentElement.replaceWith(d);});\n' +
      'if(document.querySelector("pre.mermaid")){\n' +
      '  var m=document.createElement("script");m.src=' + JSON.stringify(mermaidSrc) + ';\n' +
      '  m.onload=function(){mermaid.initialize({startOnLoad:false,securityLevel:"strict"});mermaid.run();};\n' +
      '  document.body.appendChild(m);\n' +
      '}\n' +
      '</scr' + 'ipt></body></html>';
  }
  // Branded fallback for a ?doc= that doesn't resolve (deleted/renamed/typo'd
  // path) - without this, doGet's uncaught Error produces GAS's generic,
  // unbranded error screen instead of a page consistent with the rest of the
  // app. docPath is untrusted (the raw query value) so it goes through esc().
  function notFoundHtml(docPath) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_top">' +
      '<title>DesignHub - not found</title><style>body{max-width:640px;margin:4rem auto;' +
      'font:16px/1.6 -apple-system,Segoe UI,sans-serif;color:#1a1a1a;padding:0 1rem}' +
      'code{background:#f2f2f2;padding:1px 4px}</style></head><body>' +
      '<h1>Doc not found</h1><p>No published doc matches <code>' + esc(docPath) + '</code>. ' +
      'It may have been renamed, moved, or never published.</p>' +
      '<p><a href="?">Back to DesignHub</a></p></body></html>';
  }
  function treeHtml(rows) {
    var active = rows.filter(function (r) { return r.status === 'active'; });
    var body;
    if (!active.length) {
      body = '<p>No docs published yet. Publish one with <code>/publish-design</code>.</p>';
    } else {
      var byRepo = Object.create(null);
      active.forEach(function (r) {
        byRepo[r.repo] = byRepo[r.repo] || Object.create(null);
        (byRepo[r.repo][r.feature] = byRepo[r.repo][r.feature] || []).push(r);
      });
      body = Object.keys(byRepo).sort().map(function (repo) {
        return '<h2>' + esc(repo) + '</h2>' + Object.keys(byRepo[repo]).sort().map(function (feat) {
          return '<h3>' + esc(feat) + '</h3><ul>' + byRepo[repo][feat].map(function (r) {
            return '<li><a href="' + esc(safeHref(r.url)) + '">' + esc(r.title) + '</a>' +
              (r.updatedAt ? ' <small>' + esc(String(r.updatedAt).slice(0, 10)) + '</small>' : '') + '</li>';
          }).join('') + '</ul>';
        }).join('');
      }).join('');
    }
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_top">' +
      '<title>DesignHub</title><style>body{max-width:760px;margin:3rem auto;' +
      'font:16px/1.6 -apple-system,Segoe UI,sans-serif;color:#1a1a1a}' +
      'h2{border-bottom:1px solid #ddd;padding-bottom:4px}small{color:#888}</style>' +
      '</head><body><h1>DesignHub</h1>' + body + '</body></html>';
  }
  return { esc: esc, safeHref: safeHref, injectBase: injectBase, widgetTags: widgetTags,
    serveHtml: serveHtml, mdShell: mdShell, treeHtml: treeHtml, notFoundHtml: notFoundHtml };
})();
if (typeof module !== 'undefined') module.exports = DH_RENDER;
