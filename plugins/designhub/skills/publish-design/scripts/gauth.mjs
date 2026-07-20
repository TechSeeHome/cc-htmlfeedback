// OAuth for the publish skill. Publishers publish as THEMSELVES (D13):
// per-developer token cached at ~/.claude/designhub/token.json.
// Client secret: an installed-app OAuth client JSON, resolved via a fallback
// chain (see resolveClientSecretFile): DH_CLIENT_SECRET_FILE env override ->
// ~/.claude/designhub/client_secret.json (canonical) -> the deprecated
// gdoc-md-sync path (warns once). See CREDENTIALS-SETUP.md (bundled with this plugin).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const TOKEN_FILE = process.env.DH_TOKEN_FILE ||
  path.join(os.homedir(), '.claude', 'designhub', 'token.json');
const SCOPE = 'https://www.googleapis.com/auth/drive';

const NEUTRAL_CLIENT_FILE = () =>
  path.join(os.homedir(), '.claude', 'designhub', 'client_secret.json');
const LEGACY_CLIENT_FILE = () =>
  path.join(os.homedir(), '.claude', 'skills', 'gdoc-md-sync', 'client_secret.json');

function noClientSecretError(expectedPath) {
  return new Error(
    `No Google OAuth client secret found.\n` +
      `  Expected it at: ${expectedPath}\n` +
      `  Set DH_CLIENT_SECRET_FILE to override the location.\n` +
      `  How to create/obtain it: CREDENTIALS-SETUP.md (bundled with this plugin)`
  );
}

// Resolve the installed-app OAuth client secret via a backward-compatible
// fallback chain, so a machine that never installed the gdoc-md-sync skill can
// still authenticate. `env`/`exists`/`warn` are injectable so the chain is
// unit-testable without touching the real environment or filesystem. In
// production the legacy-deprecation warning fires at most once per process.
let _legacyWarned = false;
export function resolveClientSecretFile({ env = process.env, exists = fs.existsSync, warn } = {}) {
  const override = env.DH_CLIENT_SECRET_FILE;
  if (override) {
    // A set-but-missing override must fail with the actionable error naming it
    // (G4) - never a raw ENOENT, the very failure this whole change fixes.
    if (exists(override)) return override;
    throw new Error(
      `DH_CLIENT_SECRET_FILE is set to ${override} but no file exists there.\n` +
        `  Point it at your installed-app client_secret.json, or unset it to fall back to\n` +
        `  ${NEUTRAL_CLIENT_FILE()}. See CREDENTIALS-SETUP.md (bundled with this plugin)`
    );
  }
  const neutral = NEUTRAL_CLIENT_FILE();
  if (exists(neutral)) return neutral;
  const legacy = LEGACY_CLIENT_FILE();
  if (exists(legacy)) {
    const msg =
      `[designhub] Using the DEPRECATED client secret at ${legacy}. ` +
      `Move it to ${neutral} - see CREDENTIALS-SETUP.md (bundled with this plugin).`;
    if (warn) warn(msg);
    else if (!_legacyWarned) {
      _legacyWarned = true;
      console.warn(msg);
    }
    return legacy;
  }
  throw noClientSecretError(neutral);
}

function clientCreds() {
  const c = JSON.parse(fs.readFileSync(resolveClientSecretFile(), 'utf8'));
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

// Bug #1 fix: best-effort browser auto-open. `spawn`'s ENOENT (missing `open`
// binary - e.g. non-macOS) surfaces ASYNCHRONOUSLY as an 'error' EVENT on the
// returned ChildProcess, never as a thrown exception - a synchronous
// try/catch around the spawn() call never sees it, and an unhandled 'error'
// event crashes the whole process. Attach a handler that logs and swallows
// it instead; the URL is always printed above for the user to click by hand,
// so a failed auto-open just falls back to that already-visible path.
// Exported for direct testing (same rationale as waitForCode above, and the
// `cmd` param lets a test force a deterministic ENOENT); not part of
// gauth.mjs's consumed surface (publish.mjs only imports accessToken/api).
export function openUrl(url, cmd = 'open') {
  const child = spawn(cmd, [url], { stdio: 'ignore' });
  child.on('error', (err) => {
    console.error(`(could not auto-open a browser: ${err.message} - use the URL above)`);
  });
  return child;
}

async function consent() {
  const { id, secret } = clientCreds();
  // dev-machine assumptions: fixed local port + macOS `open`; on other OSes
  // (or if `open` is missing) openUrl() logs and falls back to the printed
  // URL above instead of crashing.
  const port = 8765;
  const redirect = `http://localhost:${port}/`;
  const url = 'https://accounts.google.com/o/oauth2/auth?' + new URLSearchParams({
    response_type: 'code', client_id: id, redirect_uri: redirect,
    scope: SCOPE, access_type: 'offline', prompt: 'consent select_account' });
  console.log('\nAuthorize DesignHub publishing - open this URL and approve:\n\n' + url + '\n');
  openUrl(url);
  const code = await waitForCode(port, redirect);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, code,
      grant_type: 'authorization_code', redirect_uri: redirect }),
  });
  if (!r.ok) throw new Error('code exchange failed: ' + await r.text());
  const tok = await r.json();
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: tok.refresh_token }, null, 2), { mode: 0o600 });
  return tok.access_token;
}

export async function accessToken() {
  if (fs.existsSync(TOKEN_FILE)) {
    // Best-effort tighten permissions on tokens written by prior releases
    // under a permissive umask: writeFileSync's `mode` only applies at
    // creation, so an existing file's mode never self-heals otherwise.
    try { fs.chmodSync(TOKEN_FILE, 0o600); } catch {}
    return refresh(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).refresh_token);
  }
  // machine-local fallback: reuse the gdoc-md-sync token if present
  const legacy = path.join(os.homedir(), '.claude', 'skills', 'gdoc-md-sync', 'token.json');
  if (fs.existsSync(legacy)) {
    try { fs.chmodSync(legacy, 0o600); } catch {}
    return refresh(JSON.parse(fs.readFileSync(legacy, 'utf8')).refresh_token);
  }
  return consent();
}

async function fetchOnce(token, url, opts) {
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

export async function api(token, url, opts = {}) {
  const json = await fetchOnce(token, url, opts);
  // Bug #4 fix: Drive/Sheets list endpoints (files.list, etc.) only return
  // one page - by default up to 100 files - plus a nextPageToken when more
  // exist. Every caller treats api()'s return value as the complete result
  // (e.g. publish.mjs's q()/child() read .files straight off it), so a
  // Shared Drive folder with many children could silently look incomplete
  // and ensure() would create duplicate folders/sheets/docs that already
  // existed on a later page. Follow nextPageToken here, transparently, for
  // every caller. Deliberately generic (concat whichever array-valued
  // field(s) the response carries, e.g. Drive's `files`) rather than
  // hardcoding a field name, since api() is a shared low-level fetch helper
  // used for several different Google API response shapes - most of which
  // (Sheets values.get/put/append, Drive about, single-file get) never
  // return a nextPageToken at all, so this loop is a no-op for them.
  let page = json;
  while (page.nextPageToken) {
    const sep = url.includes('?') ? '&' : '?';
    page = await fetchOnce(token, `${url}${sep}pageToken=${encodeURIComponent(page.nextPageToken)}`, opts);
    for (const key of Object.keys(page)) {
      if (Array.isArray(page[key]) && Array.isArray(json[key])) json[key] = json[key].concat(page[key]);
    }
  }
  delete json.nextPageToken;
  return json;
}
