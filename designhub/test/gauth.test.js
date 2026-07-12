const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mod = () => import('../../plugins/designhub/skills/publish-design/scripts/gauth.mjs');

// waitForCode is gauth.mjs's local OAuth callback listener (Task 10 review):
// it must bind loopback-only (not every interface) and must settle - and
// close - on BOTH the success (`code`) and denial (`error`) redirects Google
// can send, so a user clicking "Deny" can't hang the CLI with the port left
// open forever.
function getPath(port, qs) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/${qs}`, (res) => {
        res.resume();
        res.on('end', resolve);
      })
      .on('error', reject);
  });
}

const freePort = () => 20000 + Math.floor(Math.random() * 20000);

test('waitForCode resolves with the code and binds 127.0.0.1 only (not 0.0.0.0/::)', async () => {
  const { waitForCode } = await mod();
  const port = freePort();
  let addr;
  const p = waitForCode(port, `http://localhost:${port}/`, (srv) => {
    addr = srv.address();
  });
  await getPath(port, '?code=abc123');
  assert.equal(await p, 'abc123');
  assert.equal(addr.address, '127.0.0.1');
});

test('waitForCode rejects (and closes the server) on an OAuth denial redirect instead of hanging', async () => {
  const { waitForCode } = await mod();
  const port = freePort();
  const p = waitForCode(port, `http://localhost:${port}/`);
  const assertion = assert.rejects(p, /access_denied/); // attach before the
  await getPath(port, '?error=access_denied'); // rejection fires,
  await assertion; // or Node flags it unhandled
  // Prove the server actually closed (not just settled the promise): a new
  // server can bind the identical host:port right away.
  const srv2 = http.createServer(() => {});
  await new Promise((resolve, reject) => {
    srv2.on('error', reject);
    srv2.listen(port, '127.0.0.1', resolve);
  });
  srv2.close();
});

// Bug #1 regression test: `spawn`'s ENOENT for a missing binary fires
// asynchronously as an 'error' EVENT on the child, never as a thrown
// exception - a synchronous try/catch around the spawn() call (the old
// code) can never see it, so an unhandled 'error' event would crash the
// whole process. openUrl's second (test-only) `cmd` param lets us force a
// deterministic ENOENT without depending on `open` actually being missing
// on the machine running the test.
test('openUrl attaches an error handler so a missing binary cannot crash the process (async ENOENT, not a thrown exception)', async () => {
  const { openUrl } = await mod();
  const child = openUrl('http://example.com/', '__cc_htmlfeedback_definitely_missing_binary__');
  const err = await new Promise((resolve) => child.on('error', resolve));
  assert.equal(err.code, 'ENOENT');
  // Reaching here at all proves the 'error' event was handled, not left to
  // crash the test process as an uncaught exception.
});

// Bug #4 regression test: api() previously returned only the FIRST page of
// a paginated Drive/Sheets list response, ignoring nextPageToken entirely -
// a Shared Drive folder with many children could silently look incomplete
// to callers like publish.mjs's q()/child(), which would then (wrongly)
// conclude an item doesn't exist yet and create a duplicate. Spin up a tiny
// local HTTP server that paginates a `files` array exactly like Drive's
// files.list does, and confirm api() follows nextPageToken and concatenates
// every page before returning.
test('api() follows nextPageToken and concatenates paginated results across pages', async () => {
  const { api } = await mod();
  const port = freePort();
  const pages = {
    '': { files: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' },
    p2: { files: [{ id: 'c' }], nextPageToken: 'p3' },
    p3: { files: [{ id: 'd' }] }, // last page: no nextPageToken
  };
  const srv = http.createServer((req, res) => {
    const token = new URL(req.url, `http://localhost:${port}`).searchParams.get('pageToken') || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(pages[token]));
  });
  await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve));
  try {
    const result = await api('fake-token', `http://127.0.0.1:${port}/files?q=x`);
    assert.deepEqual(
      result.files.map((f) => f.id),
      ['a', 'b', 'c', 'd']
    );
    assert.equal(
      result.nextPageToken,
      undefined,
      'the final merged result must not leak a stale pageToken'
    );
  } finally {
    srv.close();
  }
});

// A non-paginated response (no nextPageToken at all - e.g. Sheets
// values.get, Drive about) must pass through unchanged; api() should not
// assume every response is a list.
test('api() passes through a response with no nextPageToken unchanged', async () => {
  const { api } = await mod();
  const port = freePort();
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ values: [['a', 'b']] }));
  });
  await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve));
  try {
    const result = await api('fake-token', `http://127.0.0.1:${port}/values`);
    assert.deepEqual(result, { values: [['a', 'b']] });
  } finally {
    srv.close();
  }
});
