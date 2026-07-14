const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decideRead, decideWrite } = require('../gas/lib/access.js');

test('decideRead: owner email match allows via "owner", even with no permissions', () => {
  const result = decideRead([], 'owner@example.com', 'owner@example.com');
  assert.deepEqual(result, { allow: true, via: 'owner' });
});

test('decideRead: owner match is case-insensitive', () => {
  const result = decideRead([], 'Owner@Example.com', 'owner@example.com');
  assert.deepEqual(result, { allow: true, via: 'owner' });
});

test('decideRead: direct user permission allows via "direct"', () => {
  const permissions = [{ type: 'user', emailAddress: 'alice@example.com', role: 'reader' }];
  const result = decideRead(permissions, 'alice@example.com', 'someone-else@example.com');
  assert.deepEqual(result, { allow: true, via: 'direct' });
});

test('decideRead: direct user match is case-insensitive on both sides', () => {
  const grantUpper = [{ type: 'user', emailAddress: 'Alice@Example.com', role: 'reader' }];
  assert.deepEqual(decideRead(grantUpper, 'alice@example.com', ''), { allow: true, via: 'direct' });

  const grantLower = [{ type: 'user', emailAddress: 'alice@example.com', role: 'reader' }];
  assert.deepEqual(decideRead(grantLower, 'ALICE@EXAMPLE.COM', ''), { allow: true, via: 'direct' });
});

test('decideRead: a domain-type permission allows via "domain"', () => {
  const permissions = [{ type: 'domain', domain: 'example.com', role: 'reader' }];
  const result = decideRead(permissions, 'anyone@example.com', '');
  assert.deepEqual(result, { allow: true, via: 'domain' });
});

test('decideRead: a domain-type permission scoped to a DIFFERENT domain than the actor does not grant access', () => {
  const permissions = [{ type: 'domain', domain: 'othercompany.com', role: 'reader' }];
  const result = decideRead(permissions, 'someone@example.com', '');
  assert.deepEqual(result, { allow: false, via: 'none' });
});

test('decideRead: a domain-type permission still matches when the actor email is uppercase', () => {
  const permissions = [{ type: 'domain', domain: 'example.com', role: 'reader' }];
  const result = decideRead(permissions, 'Someone@EXAMPLE.com', '');
  assert.deepEqual(result, { allow: true, via: 'domain' });
});

// This app is domain-restricted already (appsscript.json webapp.access:
// DOMAIN), so an "anyone with the link" grant on a specific file still only
// ever reaches authenticated domain users in practice - treating it as
// equivalent to a domain grant (rather than denying it) avoids a confusing
// split where Drive itself would serve the file to the whole domain while
// this app's own read check blocked it.
test('decideRead: an "anyone" permission allows, reported via "domain"', () => {
  const permissions = [{ type: 'anyone', role: 'reader' }];
  const result = decideRead(permissions, 'someone@example.com', '');
  assert.deepEqual(result, { allow: true, via: 'domain' });
});

// Deliberate, documented limitation (design doc, "Group-grant false
// denials"): resolving group membership needs the Admin Directory API,
// which this app does not have - a group-only grant must never contribute
// to allow, even though the real requester might be a member of that group.
test('decideRead: a group-only permission denies (group membership is not resolvable)', () => {
  const permissions = [{ type: 'group', emailAddress: 'team@example.com', role: 'reader' }];
  const result = decideRead(permissions, 'member-of-team@example.com', '');
  assert.deepEqual(result, { allow: false, via: 'none' });
});

test('decideRead: an empty permissions array and no owner denies', () => {
  assert.deepEqual(decideRead([], 'anyone@example.com', ''), { allow: false, via: 'none' });
  assert.deepEqual(decideRead([], 'anyone@example.com', null), { allow: false, via: 'none' });
  assert.deepEqual(decideRead([], 'anyone@example.com', undefined), { allow: false, via: 'none' });
});

// A group entry alongside a real match must never shadow or short-circuit
// the real match - the group entry simply never contributes, one way or
// another.
test('decideRead: a group entry alongside a real direct match still allows via the real match', () => {
  const permissions = [
    { type: 'group', emailAddress: 'team@example.com', role: 'reader' },
    { type: 'user', emailAddress: 'alice@example.com', role: 'writer' },
  ];
  const result = decideRead(permissions, 'alice@example.com', '');
  assert.deepEqual(result, { allow: true, via: 'direct' });
});

test('decideRead: a group entry alongside a domain match still allows via "domain"', () => {
  const permissions = [
    { type: 'group', emailAddress: 'team@example.com', role: 'reader' },
    { type: 'domain', domain: 'example.com', role: 'reader' },
  ];
  const result = decideRead(permissions, 'bob@example.com', '');
  assert.deepEqual(result, { allow: true, via: 'domain' });
});

test('decideRead: malformed entries (missing type/emailAddress, null, undefined) are skipped, never throw', () => {
  const permissions = [
    {},
    { type: 'user' }, // missing emailAddress
    { emailAddress: 'alice@example.com' }, // missing type
    null,
    undefined,
  ];
  assert.doesNotThrow(() => decideRead(permissions, 'alice@example.com', ''));
  const result = decideRead(permissions, 'alice@example.com', '');
  assert.deepEqual(result, { allow: false, via: 'none' });
});

test('decideRead: a non-array permissions value is treated as empty, never throws', () => {
  assert.doesNotThrow(() => decideRead(null, 'alice@example.com', ''));
  assert.doesNotThrow(() => decideRead(undefined, 'alice@example.com', ''));
  assert.deepEqual(decideRead(null, 'alice@example.com', ''), { allow: false, via: 'none' });
});

test('decideRead: an empty/missing actorEmail denies outright, never throws', () => {
  const permissions = [{ type: 'domain', domain: 'example.com', role: 'reader' }];
  assert.deepEqual(decideRead(permissions, '', ''), { allow: false, via: 'none' });
  assert.deepEqual(decideRead(permissions, null, ''), { allow: false, via: 'none' });
  assert.deepEqual(decideRead(permissions, undefined, ''), { allow: false, via: 'none' });
});

test('decideRead: a user-type permission for a different email does not match', () => {
  const permissions = [{ type: 'user', emailAddress: 'alice@example.com', role: 'reader' }];
  assert.deepEqual(decideRead(permissions, 'mallory@example.com', ''), {
    allow: false,
    via: 'none',
  });
});

// --- decideWrite (Slice B1, write-side ACL probe) -------------------------
// Same permission-list-walking shape as decideRead, but a permission's ROLE
// now matters: reader/commenter grants must never allow a write, even
// though decideRead would happily allow READ via the very same entries.

test('decideWrite: owner email match allows via "owner", even with no permissions', () => {
  assert.deepEqual(decideWrite([], 'owner@example.com', 'owner@example.com'), {
    allow: true,
    via: 'owner',
  });
});

test('decideWrite: owner match is case-insensitive', () => {
  assert.deepEqual(decideWrite([], 'Owner@Example.com', 'owner@example.com'), {
    allow: true,
    via: 'owner',
  });
});

test('decideWrite: a direct user grant with a write-capable role (writer) allows via "direct"', () => {
  const permissions = [{ type: 'user', emailAddress: 'alice@example.com', role: 'writer' }];
  assert.deepEqual(decideWrite(permissions, 'alice@example.com', ''), {
    allow: true,
    via: 'direct',
  });
});

test('decideWrite: organizer and fileOrganizer roles also allow via "direct"', () => {
  const organizer = [{ type: 'user', emailAddress: 'alice@example.com', role: 'organizer' }];
  assert.deepEqual(decideWrite(organizer, 'alice@example.com', ''), { allow: true, via: 'direct' });
  const fileOrganizer = [
    { type: 'user', emailAddress: 'alice@example.com', role: 'fileOrganizer' },
  ];
  assert.deepEqual(decideWrite(fileOrganizer, 'alice@example.com', ''), {
    allow: true,
    via: 'direct',
  });
});

// The read/write divergence this function exists for: decideRead allows
// ANY role (any grant implies at least read); decideWrite must not.
test('decideWrite: a reader-only or commenter-only direct grant denies (unlike decideRead)', () => {
  const reader = [{ type: 'user', emailAddress: 'alice@example.com', role: 'reader' }];
  assert.deepEqual(decideWrite(reader, 'alice@example.com', ''), { allow: false, via: 'none' });
  assert.deepEqual(decideRead(reader, 'alice@example.com', ''), { allow: true, via: 'direct' });

  const commenter = [{ type: 'user', emailAddress: 'alice@example.com', role: 'commenter' }];
  assert.deepEqual(decideWrite(commenter, 'alice@example.com', ''), { allow: false, via: 'none' });
});

test('decideWrite: a domain-type grant with a write-capable role allows via "domain"', () => {
  const permissions = [{ type: 'domain', domain: 'example.com', role: 'writer' }];
  assert.deepEqual(decideWrite(permissions, 'anyone@example.com', ''), {
    allow: true,
    via: 'domain',
  });
});

test('decideWrite: a domain-type grant with a read-only role denies', () => {
  const permissions = [{ type: 'domain', domain: 'example.com', role: 'commenter' }];
  assert.deepEqual(decideWrite(permissions, 'anyone@example.com', ''), {
    allow: false,
    via: 'none',
  });
});

test('decideWrite: an "anyone" grant with a write-capable role allows via "domain" (symmetry with decideRead\'s anyone handling)', () => {
  const permissions = [{ type: 'anyone', role: 'writer' }];
  assert.deepEqual(decideWrite(permissions, 'someone@example.com', ''), {
    allow: true,
    via: 'domain',
  });
});

// Deliberate, documented limitation (design doc, "Group-grant false
// denials" - same rationale as decideRead's identical exclusion): resolving
// group membership needs the Admin Directory API, which this app does not
// have. A group-only grant must never contribute to allow, regardless of
// its role.
test('decideWrite: a group-only grant denies even with a write-capable role (group membership is not resolvable)', () => {
  const permissions = [{ type: 'group', emailAddress: 'team@example.com', role: 'writer' }];
  assert.deepEqual(decideWrite(permissions, 'member-of-team@example.com', ''), {
    allow: false,
    via: 'none',
  });
});

test('decideWrite: an empty permissions array and no owner denies', () => {
  assert.deepEqual(decideWrite([], 'anyone@example.com', ''), { allow: false, via: 'none' });
  assert.deepEqual(decideWrite([], 'anyone@example.com', null), { allow: false, via: 'none' });
  assert.deepEqual(decideWrite([], 'anyone@example.com', undefined), { allow: false, via: 'none' });
});

test('decideWrite: a group entry alongside a real write-capable direct match still allows via "direct"', () => {
  const permissions = [
    { type: 'group', emailAddress: 'team@example.com', role: 'writer' },
    { type: 'user', emailAddress: 'alice@example.com', role: 'writer' },
  ];
  assert.deepEqual(decideWrite(permissions, 'alice@example.com', ''), {
    allow: true,
    via: 'direct',
  });
});

test('decideWrite: malformed entries (missing type/role/emailAddress, null, undefined) are skipped, never throw', () => {
  const permissions = [
    {},
    { type: 'user' },
    { emailAddress: 'alice@example.com' },
    null,
    undefined,
  ];
  assert.doesNotThrow(() => decideWrite(permissions, 'alice@example.com', ''));
  assert.deepEqual(decideWrite(permissions, 'alice@example.com', ''), {
    allow: false,
    via: 'none',
  });
});

test('decideWrite: a non-array permissions value is treated as empty, never throws', () => {
  assert.doesNotThrow(() => decideWrite(null, 'alice@example.com', ''));
  assert.deepEqual(decideWrite(undefined, 'alice@example.com', ''), { allow: false, via: 'none' });
});

test('decideWrite: an empty/missing actorEmail denies outright, never throws', () => {
  const permissions = [{ type: 'domain', domain: 'example.com', role: 'writer' }];
  assert.deepEqual(decideWrite(permissions, '', ''), { allow: false, via: 'none' });
  assert.deepEqual(decideWrite(permissions, null, ''), { allow: false, via: 'none' });
});

test('decideWrite: a write-capable grant for a different email does not match', () => {
  const permissions = [{ type: 'user', emailAddress: 'alice@example.com', role: 'writer' }];
  assert.deepEqual(decideWrite(permissions, 'mallory@example.com', ''), {
    allow: false,
    via: 'none',
  });
});

// Same security fix as decideRead's (Task 1's own follow-up commit,
// designhub 87e5e13): a domain-type permission's domain field must be
// checked against the actor's OWN email domain, not treated as an
// unconditional grant just because this app is domain-restricted.
test('decideWrite: a domain-type grant with a write-capable role but a DIFFERENT domain than the actor does not allow', () => {
  const permissions = [{ type: 'domain', domain: 'othercompany.com', role: 'writer' }];
  assert.deepEqual(decideWrite(permissions, 'someone@example.com', ''), {
    allow: false,
    via: 'none',
  });
});
