// OAuth for the publish skill. Publishers publish as THEMSELVES (D13):
// per-developer token cached at ~/.claude/designhub/token.json.
// Client secret: an installed-app OAuth client JSON; default reuses the
// gdoc-md-sync client on this machine, override with DH_CLIENT_SECRET_FILE.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const TOKEN_FILE = process.env.DH_TOKEN_FILE ||
  path.join(os.homedir(), '.claude', 'designhub', 'token.json');
const CLIENT_FILE = process.env.DH_CLIENT_SECRET_FILE ||
  path.join(os.homedir(), '.claude', 'skills', 'gdoc-md-sync', 'client_secret.json');
const SCOPE = 'https://www.googleapis.com/auth/drive';

function clientCreds() {
  const c = JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8'));
  const k = c.installed || c.web;
  return { id: k.client_id, secret: k.client_secret };
}

async function refresh(refreshToken) {
  const { id, secret } = clientCreds();
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret,
      refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  if (!r.ok) throw new Error('token refresh failed: ' + await r.text());
  return (await r.json()).access_token;
}

// Local OAuth callback listener. Bound to 127.0.0.1 ONLY: plain `.listen(port)`
// defaults to ALL interfaces (0.0.0.0/::), needlessly exposing an
// unauthenticated endpoint - reachable from the whole LAN while it's up - that
// acts on the first `code`/`error` param any requester sends it. Also settles
// (and closes) on an `error` param, not just `code`: an OAuth denial redirects
// with `error=access_denied` and no `code`, and the previous version neither
// resolved nor rejected on that path, hanging the CLI forever with the port
// still open. Exported for direct testing; not part of gauth.mjs's consumed
// surface (publish.mjs only imports accessToken/api).
export function waitForCode(port, redirect, onListen) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const q = new URL(req.url, redirect).searchParams;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Done - return to the terminal.</h2>');
      if (q.get('code')) { srv.close(); resolve(q.get('code')); }
      else if (q.get('error')) { srv.close(); reject(new Error('OAuth consent denied: ' + q.get('error'))); }
    });
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => onListen?.(srv));
  });
}

async function consent() {
  const { id, secret } = clientCreds();
  // dev-machine assumptions: fixed local port + macOS `open`; on other OSes
  // the printed URL is the path (the spawn failure is swallowed on purpose)
  const port = 8765;
  const redirect = `http://localhost:${port}/`;
  const url = 'https://accounts.google.com/o/oauth2/auth?' + new URLSearchParams({
    response_type: 'code', client_id: id, redirect_uri: redirect,
    scope: SCOPE, access_type: 'offline', prompt: 'consent select_account' });
  console.log('\nAuthorize DesignHub publishing - open this URL and approve:\n\n' + url + '\n');
  try { spawn('open', [url], { stdio: 'ignore' }); } catch { /* print-only fallback */ }
  const code = await waitForCode(port, redirect);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, code,
      grant_type: 'authorization_code', redirect_uri: redirect }),
  });
  if (!r.ok) throw new Error('code exchange failed: ' + await r.text());
  const tok = await r.json();
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: tok.refresh_token }, null, 2));
  return tok.access_token;
}

export async function accessToken() {
  if (fs.existsSync(TOKEN_FILE)) {
    return refresh(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).refresh_token);
  }
  // machine-local fallback: reuse the gdoc-md-sync token if present
  const legacy = path.join(os.homedir(), '.claude', 'skills', 'gdoc-md-sync', 'token.json');
  if (fs.existsSync(legacy)) {
    return refresh(JSON.parse(fs.readFileSync(legacy, 'utf8')).refresh_token);
  }
  return consent();
}

export async function api(token, url, opts = {}) {
  const r = await fetch(url, { ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (!r.ok) {
    // status is attached so callers can tell "missing tab" (400) from real
    // failures (403/5xx) instead of swallowing everything
    const e = new Error(`${opts.method || 'GET'} ${url} -> ${r.status}: ${await r.text()}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}
