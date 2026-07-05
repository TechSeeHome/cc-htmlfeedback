// ns: stable per-project namespace (hash of the queue dir - see server.js). Unlike sessionId,
// it survives server restarts, so the widget keys persisted drafts by it.
function injectWidget(html, sessionId, mode = 'static', ns = ''){
  if (html.includes('src="/__ccfb/widget.js"')) return html; // idempotent — match the injected tag, not mere text mentions
  const tags =
    `<script>window.__CCFB={endpoint:"",sessionId:${JSON.stringify(sessionId)},mode:${JSON.stringify(mode)},ns:${JSON.stringify(ns)}};</script>` +
    `<script src="/__ccfb/widget.js"></script>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tags + '</body>') : html + tags;  // case-insensitive </BODY>
}
module.exports = { injectWidget };
