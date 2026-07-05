// cc-htmlfeedback companion server (connected mode).
// Serves the app (static --root for now; --proxy added in Phase 4), injects the widget,
// exposes REST (POST/GET /__ccfb/tickets) + SSE (/__ccfb/events), and watches files:
//   feedback_tasks.json change  -> push a `tickets` event to the browser (page-scoped)
//   source file change -> push a `reload` event to the browser
// The session never speaks HTTP; it reads/writes the queue files directly.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { injectWidget } = require('./lib/inject.js');
const { QUEUE_DIR, pageKey, inboxPath, tasksPath, readTasks, upsertIndex, appendTicket, newTicket } = require('./lib/queue.js');

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png',
  '.ico':'image/x-icon', '.woff2':'font/woff2', '.map':'application/json' };

function startServer({ root, queueDir, port = 0, sessionId = crypto.randomUUID(), widgetPath, proxy, onShutdown } = {}) {
  fs.mkdirSync(queueDir, { recursive: true });
  root = path.resolve(root);
  // Stable per-project namespace for the widget's persisted drafts (same sha1/12 idiom as
  // lib/queue.js pageKey): keyed on the queue dir so it survives server restarts of the same
  // project, unlike sessionId, while still separating projects that share a port+path.
  const ns = crypto.createHash('sha1').update(path.resolve(queueDir)).digest('hex').slice(0, 12);
  // In the bundled plugin the widget sits co-located next to server.js; in the dev repo it's
  // under extension/. Prefer the co-located copy, fall back to the extension build.
  if (!widgetPath) {
    const local = path.join(__dirname, 'feedback-widget.js');
    widgetPath = fs.existsSync(local) ? local : path.join(__dirname, 'extension', 'feedback-widget.js');
  }

  const sseClients = new Set();                      // each: { res, key }
  function broadcastTo(key, event, data){
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) if (c.key === key) { try { c.res.write(payload); } catch {} }
  }
  function broadcastAll(event, data){
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) { try { c.res.write(payload); } catch {} }
  }
  function sendJSON(res, code, obj){ res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(obj)); }

  // --proxy: forward to an existing dev server, injecting the widget into HTML responses
  // (so the upstream's own HMR keeps working). /__ccfb/* is always handled locally.
  function proxyRequest(req, res){
    const lib = proxy.startsWith('https:') ? require('node:https') : require('node:http');
    const target = new URL(req.url, proxy);
    const headers = Object.assign({}, req.headers, { host: target.host, 'accept-encoding': 'identity' });
    const up = lib.request(target, { method: req.method, headers }, upRes => {
      upRes.on('error', () => { try { res.destroy(); } catch {} });   // upstream dropped mid-response
      const ct = upRes.headers['content-type'] || '';
      if (ct.includes('text/html')) {
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          const html = injectWidget(Buffer.concat(chunks).toString('utf8'), sessionId, 'proxy', ns);
          const h = Object.assign({}, upRes.headers);
          delete h['content-length']; delete h['content-encoding']; delete h['transfer-encoding'];
          res.writeHead(upRes.statusCode, h);
          res.end(html);
        });
      } else {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        res.on('error', () => { try { upRes.destroy(); } catch {} });  // client dropped mid-pipe
      }
    });
    up.on('error', e => { try { res.writeHead(502); res.end('cc-htmlfeedback proxy error: ' + e.message); } catch {} });
    req.pipe(up);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    if (p === '/__ccfb/widget.js') {
      try { res.writeHead(200, {'content-type':'text/javascript'}); return res.end(fs.readFileSync(widgetPath)); }
      catch { res.writeHead(404); return res.end('widget not built — run `node build.js`'); }
    }
    if (p === '/__ccfb/tickets' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let fields; try { fields = JSON.parse(body); } catch { return sendJSON(res, 400, { error:'bad json' }); }
        const ticket = newTicket(fields);
        const key = pageKey(fields.page || '');
        upsertIndex(queueDir, key, fields.page || '');
        appendTicket(queueDir, key, ticket);   // shared write path (mkdir + append) — see lib/queue.js
        sendJSON(res, 200, ticket);
      });
      return;
    }
    if (p === '/__ccfb/tickets' && req.method === 'GET') {
      const key = pageKey(url.searchParams.get('page') || '');
      return sendJSON(res, 200, readTasks(queueDir, key));
    }
    if (p === '/__ccfb/clean' && req.method === 'POST') {
      let body = ''; req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let f; try { f = JSON.parse(body); } catch { return sendJSON(res, 400, { error:'bad json' }); }
        const key = pageKey(f.page || '');
        try {
          fs.mkdirSync(path.dirname(tasksPath(queueDir, key)), { recursive: true });
          fs.writeFileSync(inboxPath(queueDir, key), '');
          fs.writeFileSync(tasksPath(queueDir, key), JSON.stringify({ version:1, page: f.page || '', file:'', tickets:[] }));
        } catch (e) { return sendJSON(res, 500, { error: 'clean failed: ' + e.message }); }   // don't report false success
        broadcastTo(key, 'tickets', readTasks(queueDir, key));
        sendJSON(res, 200, { ok: true });
      });
      return;
    }
    // Liveness/identity probe: lets a fresh session (or the launcher on EADDRINUSE) tell whether
    // the port holds OUR server, who it is, and where it was launched from — without a tracked PID.
    if (p === '/__ccfb/health') {
      return sendJSON(res, 200, {
        server: 'cc-htmlfeedback', sessionId, pid: process.pid,
        port: (server.address() || {}).port,
        mode: proxy ? 'proxy' : 'static', target: proxy || root,
        tooling: __dirname,
      });
    }
    // PID-independent kill: stop a server you didn't spawn (e.g. an orphan) after confirming via
    // /__ccfb/health that it's ours. Loopback-bound, same trust scope as the other /__ccfb routes.
    if (p === '/__ccfb/shutdown' && req.method === 'POST') {
      sendJSON(res, 200, { ok: true, sessionId, pid: process.pid });
      setTimeout(() => { try { handle.close(); } catch {} if (onShutdown) onShutdown(); }, 50);
      return;
    }
    if (p === '/__ccfb/events') {
      const key = pageKey(url.searchParams.get('page') || '');
      res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});
      res.write('retry: 2000\n\n');
      const client = { res, key }; sseClients.add(client);
      // Sync current board state to the just-connected (or reconnected) widget, so it
      // never sits on a stale "todo" if it missed a change event.
      try { client.res.write(`event: tickets\ndata: ${JSON.stringify(readTasks(queueDir, key))}\n\n`); } catch {}
      req.on('close', () => sseClients.delete(client));
      return;
    }

    if (proxy) return proxyRequest(req, res);

    // static file serving with HTML injection
    let rel = decodeURIComponent(p);
    let filePath = path.join(root, rel);
    if (p.endsWith('/')) filePath = path.join(filePath, 'index.html');
    if (path.relative(root, filePath).startsWith('..')) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(filePath, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(filePath);
      if (ext === '.html') {
        res.writeHead(200, {'content-type':'text/html; charset=utf-8'});
        return res.end(injectWidget(buf.toString('utf8'), sessionId, 'static', ns));
      }
      res.writeHead(200, {'content-type': MIME[ext] || 'application/octet-stream'});
      res.end(buf);
    });
  });

  let reloadTimer = null;
  const watchers = [];
  function watchState(){
    // Poll the per-page boards instead of fs.watch: macOS recursive fs.watch does NOT
    // reliably fire for files inside subdirectories created AFTER the watch attaches, and
    // the pages/<key>/ dirs are created lazily on the first comment. Polling these small
    // JSON files every second is cheap and fully watch-independent.
    const pagesDir = path.join(queueDir, 'pages');
    const lastSeen = new Map();
    // prime=true on the startup pass records pre-existing boards WITHOUT broadcasting (so a
    // reconnecting client isn't spammed with stale state). On every later tick, any board that
    // is new OR changed is a real update worth pushing — including a page whose board is first
    // created after a client already connected (else that client would miss its first update).
    const tick = (prime) => {
      let keys; try { keys = fs.readdirSync(pagesDir); } catch { return; }
      for (const key of keys) {
        let cur;
        try { cur = fs.readFileSync(path.join(pagesDir, key, 'feedback_tasks.json'), 'utf8'); } catch { continue; }
        if (lastSeen.get(key) === cur) continue;
        lastSeen.set(key, cur);
        if (!prime) { try { broadcastTo(key, 'tickets', JSON.parse(cur)); } catch {} }
      }
    };
    tick(true);                               // prime existing state without broadcasting
    const id = setInterval(() => tick(false), 1000);
    watchers.push({ close: () => clearInterval(id) });
  }
  function watchSource(){
    const queueDirName = path.relative(root, queueDir);   // ignore our own queue writes, wherever the queue lives
    try { watchers.push(fs.watch(root, { recursive: true }, (_e, f) => {
      if (f && f.split(/[/\\]/).includes(queueDirName)) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => broadcastAll('reload', { at: Date.now() }), 150);
    })); } catch {}
  }

  const handle = {
    get port(){ const a = server.address(); return a && a.port; },
    sessionId, broadcast: broadcastAll,
    close(){
      clearTimeout(reloadTimer);
      for (const w of watchers) { try { w.close(); } catch {} }
      for (const c of sseClients) { try { c.res.end(); } catch {} }
      server.close();
    },
  };
  // Resolve only once actually listening, so `.port` is valid and watchers are attached.
  // Reject on a listen error (e.g. EADDRINUSE) so the caller can react instead of crashing.
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      watchState(); watchSource(); resolve(handle);
    });
  });
}

if (require.main === module) {
  const { values } = require('node:util').parseArgs({ options: {
    root: { type:'string', default:'.' },
    port: { type:'string', default:'4317' },
    proxy: { type:'string' },
  }});
  const root = path.resolve(values.root);          // still watched for reload, even in proxy mode
  const queueDir = path.join(root, QUEUE_DIR);
  const port = Number(values.port);
  // Probe whatever is already on the port to decide if it's our (possibly orphaned) server.
  function probeHealth(){
    return new Promise(resolve => {
      const r = http.get({ host:'127.0.0.1', port, path:'/__ccfb/health', timeout:1000 }, res => {
        let b=''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
      });
      r.on('error', () => resolve(null));
      r.on('timeout', () => { r.destroy(); resolve(null); });
    });
  }
  startServer({ root, queueDir, port, proxy: values.proxy, onShutdown: () => process.exit(0) })
    .then(h => {
      const how = values.proxy ? `proxy → ${values.proxy}` : `root: ${root}`;
      console.log(`cc-htmlfeedback server on http://127.0.0.1:${h.port} (${how})`);
    })
    .catch(async err => {
      if (err && err.code === 'EADDRINUSE') {
        const h = await probeHealth();
        if (h && h.server === 'cc-htmlfeedback') {
          console.error(`cc-htmlfeedback is already running on :${port} (pid ${h.pid}, session ${h.sessionId}, ${h.mode} ${h.target}).`);
          console.error(`Reuse it, or restart with:  kill ${h.pid}   (or: curl -X POST http://127.0.0.1:${port}/__ccfb/shutdown )`);
        } else {
          console.error(`Port ${port} is in use by another process (not cc-htmlfeedback).`);
          console.error(`Free it:  lsof -ti:${port} | xargs kill   — or pass --port <n>.`);
        }
        process.exit(1);
      }
      console.error('cc-htmlfeedback server failed to start:', (err && err.message) || err);
      process.exit(1);
    });
}

module.exports = { startServer };
