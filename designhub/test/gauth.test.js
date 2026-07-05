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
    http.get(`http://127.0.0.1:${port}/${qs}`, (res) => {
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });
}

const freePort = () => 20000 + Math.floor(Math.random() * 20000);

test('waitForCode resolves with the code and binds 127.0.0.1 only (not 0.0.0.0/::)', async () => {
  const { waitForCode } = await mod();
  const port = freePort();
  let addr;
  const p = waitForCode(port, `http://localhost:${port}/`, (srv) => { addr = srv.address(); });
  await getPath(port, '?code=abc123');
  assert.equal(await p, 'abc123');
  assert.equal(addr.address, '127.0.0.1');
});

test('waitForCode rejects (and closes the server) on an OAuth denial redirect instead of hanging', async () => {
  const { waitForCode } = await mod();
  const port = freePort();
  const p = waitForCode(port, `http://localhost:${port}/`);
  const assertion = assert.rejects(p, /access_denied/);   // attach before the
  await getPath(port, '?error=access_denied');             // rejection fires,
  await assertion;                                          // or Node flags it unhandled
  // Prove the server actually closed (not just settled the promise): a new
  // server can bind the identical host:port right away.
  const srv2 = http.createServer(() => {});
  await new Promise((resolve, reject) => {
    srv2.on('error', reject);
    srv2.listen(port, '127.0.0.1', resolve);
  });
  srv2.close();
});
