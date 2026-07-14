// Regression coverage for the P1 finding from PR #11's review (CodeRabbit +
// chatgpt-codex-connector): listComments/submitComment/reply/setStatus
// (bridge.js) all resolved a docPath via dhCommentsFor_ with NO Drive-ACL
// check at all - any signed-in domain user who knew or guessed a restricted
// docPath could read stored ticket quotes/notes and mutate the ticket sheet
// for a doc they had no Drive access to, defeating the B0 read-ACL feature
// entirely for comment data.
//
// The actual gate (dhCanRead_, reusing the exhaustively-tested
// DH_ACCESS.decideRead) lives in drive.js's dhCommentsFor_ - a thin GAS
// adapter that needs DriveApp/CacheService and cannot run under node --test
// (same "pure decision + thin adapter" split documented throughout gas/lib/;
// see knowledge.test.js's comment on dhWalkTeamDrive_ for the established
// precedent). What CAN be pinned without a live Drive connection is the
// STRUCTURAL contract: every one of the 4 comment RPCs must pass the
// session's actual identity as dhCommentsFor_'s second argument, and
// dhCommentsFor_ itself must gate on it. A pure source scan (same technique
// callable-surface.test.js already uses for the public-surface contract)
// catches a future regression where someone re-adds a bare
// `dhCommentsFor_(docPath)` call (no ACL argument) without needing to spin up
// GAS globals.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bridgeSrc = fs.readFileSync(path.join(__dirname, '..', 'gas', 'bridge.js'), 'utf8');
const driveSrc = fs.readFileSync(path.join(__dirname, '..', 'gas', 'drive.js'), 'utf8');

function functionBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, 'function ' + name + ' not found in source');
  // Find this function's matching closing brace by brace-depth counting from
  // its first '{' - good enough for these small, well-formed source files
  // (same assumption callable-surface.test.js's regex-based scan already
  // relies on: no live parsing, just enough structure to assert on).
  const openBrace = src.indexOf('{', start);
  let depth = 0;
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('could not find end of function ' + name);
}

test('dhCommentsFor_ (drive.js) gates its resolution on actorEmail via dhCanRead_', () => {
  const body = functionBody(driveSrc, 'dhCommentsFor_');
  assert.match(
    body,
    /if\s*\(\s*actorEmail\s*!==\s*undefined\s*&&\s*\(\s*!actorEmail\s*\|\|\s*!dhCanRead_\(/,
    'dhCommentsFor_ must deny the resolution when actorEmail is omitted-or-blank-or-unreadable'
  );
});

// P1 finding from PR #12's review (chatgpt-codex-connector): the guard above
// used to be a bare `actorEmail && !dhCanRead_(...)` truthy check, which
// treats an explicitly-passed blank actorEmail ('' - a value
// Session.getActiveUser().getEmail() can legitimately return in
// domain-restricted deployments) identically to the omitted-argument case
// dhLogReadDenial_ relies on, letting an unidentified caller bypass
// dhCanRead_ entirely. Only a truly OMITTED argument
// (actorEmail === undefined) may skip the gate; this pins that the guard
// distinguishes the two rather than collapsing them back into one truthy
// check.
test('dhCommentsFor_ denies a blank/falsy actorEmail rather than bypassing the gate (P1 fix, review of PR #12)', () => {
  const body = functionBody(driveSrc, 'dhCommentsFor_');
  assert.doesNotMatch(
    body,
    /if\s*\(\s*actorEmail\s*&&\s*!dhCanRead_\(/,
    "dhCommentsFor_ must not use a bare `actorEmail && ...` truthy check - an explicitly-passed falsy actorEmail (e.g. '') must be denied, not bypassed alongside the omitted-argument case"
  );
  assert.match(
    body,
    /actorEmail\s*!==\s*undefined/,
    "dhCommentsFor_'s guard must explicitly test `actorEmail !== undefined` so only a truly omitted argument (dhLogReadDenial_'s call) skips the ACL gate"
  );
});

for (const fn of ['listComments', 'submitComment', 'reply', 'setStatus']) {
  test(
    "bridge.js's " +
      fn +
      " passes a real actor identity as dhCommentsFor_'s 2nd argument (P1 ACL fix)",
    () => {
      const body = functionBody(bridgeSrc, fn);
      // Must call dhCommentsFor_ with a 2nd argument that is (or derives
      // from) Session.getActiveUser().getEmail() - never a bare
      // dhCommentsFor_(docPath) call, which would silently re-open the
      // bypass this fix closes.
      assert.match(
        body,
        /dhCommentsFor_\(\s*docPath\s*,\s*\S/,
        fn +
          ' must call dhCommentsFor_(docPath, <actor identity>), not dhCommentsFor_(docPath) alone'
      );
      assert.match(
        body,
        /Session\.getActiveUser\(\)\.getEmail\(\)/,
        fn +
          ' must derive the actor identity from the session, never trust a client-supplied value (D17)'
      );
    }
  );
}
