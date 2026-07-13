const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePublishInput, base64DecodedByteLength } = require('../gas/lib/ingest.js');

function goodInput(over) {
  return Object.assign(
    {
      fileName: 'design.md',
      contentBase64: Buffer.from('# Hello').toString('base64'),
      title: 'Design Doc',
      repo: 'cc-htmlfeedback',
      feature: 'design/foo',
      pathInRepo: 'design.md',
    },
    over
  );
}

// ---- base64DecodedByteLength ----

test('base64DecodedByteLength: empty string is 0 bytes', () => {
  assert.equal(base64DecodedByteLength(''), 0);
});

test('base64DecodedByteLength: matches known decoded lengths including padding', () => {
  assert.equal(base64DecodedByteLength('YQ=='), 1); // 'a'
  assert.equal(base64DecodedByteLength('YWI='), 2); // 'ab'
  assert.equal(base64DecodedByteLength('YWJj'), 3); // 'abc'
});

test('base64DecodedByteLength: never throws on garbage input', () => {
  assert.doesNotThrow(() => base64DecodedByteLength(null));
  assert.doesNotThrow(() => base64DecodedByteLength(undefined));
  assert.equal(base64DecodedByteLength(null), 0);
});

// ---- validatePublishInput: happy path ----

test('validatePublishInput: a well-formed input normalizes cleanly', () => {
  const r = validatePublishInput(goodInput());
  assert.equal(r.ok, true);
  assert.equal(r.normalized.docPath, 'cc-htmlfeedback/design--foo/design.md');
  assert.equal(r.normalized.featureDir, 'design--foo');
  assert.equal(r.normalized.type, 'md');
  assert.equal(r.normalized.jira, 'unassigned');
  assert.equal(r.normalized.confirmUpdate, false);
});

test('validatePublishInput: extension check is case-insensitive', () => {
  const r = validatePublishInput(goodInput({ fileName: 'design.HTML', pathInRepo: 'design.HTML' }));
  assert.equal(r.ok, true);
  assert.equal(r.normalized.type, 'html');
});

test('validatePublishInput: an explicit jira key is preserved as-is', () => {
  const r = validatePublishInput(goodInput({ jira: 'PROJ-123' }));
  assert.equal(r.ok, true);
  assert.equal(r.normalized.jira, 'PROJ-123');
});

test('validatePublishInput: confirmUpdate is only true when literally true (not truthy)', () => {
  assert.equal(
    validatePublishInput(goodInput({ confirmUpdate: 'yes' })).normalized.confirmUpdate,
    false
  );
  assert.equal(
    validatePublishInput(goodInput({ confirmUpdate: true })).normalized.confirmUpdate,
    true
  );
});

// ---- validatePublishInput: required fields ----

test('validatePublishInput: each required field missing is INVALID_INPUT naming that field', () => {
  for (const field of ['fileName', 'contentBase64', 'title', 'repo', 'feature', 'pathInRepo']) {
    const r = validatePublishInput(goodInput({ [field]: '' }));
    assert.equal(r.ok, false, `expected failure for missing ${field}`);
    assert.equal(r.error.code, 'INVALID_INPUT');
    assert.equal(r.error.field, field);
  }
});

test('validatePublishInput: an entirely empty input object fails on the first required field', () => {
  const r = validatePublishInput({});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_INPUT');
});

// ---- validatePublishInput: extension allowlist (UPLOAD_REJECTED) ----

test('validatePublishInput: an unsupported extension is UPLOAD_REJECTED, not INVALID_INPUT', () => {
  const r = validatePublishInput(goodInput({ fileName: 'design.exe', pathInRepo: 'design.exe' }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UPLOAD_REJECTED');
  assert.match(r.error.message, /\.md and \.html/);
});

test('validatePublishInput: a file with no extension at all is UPLOAD_REJECTED', () => {
  const r = validatePublishInput(goodInput({ fileName: 'README', pathInRepo: 'README' }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UPLOAD_REJECTED');
});

// ---- validatePublishInput: size limit (UPLOAD_REJECTED) ----
// Server-side enforcement of the same 10MB figure the design doc's client-
// side file.size check uses - a malicious or buggy client could skip its
// own check, so this must not be client-trust-only.

test('validatePublishInput: content decoding to over 10MB is UPLOAD_REJECTED', () => {
  const big = Buffer.alloc(11 * 1024 * 1024, 'a').toString('base64');
  const r = validatePublishInput(goodInput({ contentBase64: big }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UPLOAD_REJECTED');
  assert.match(r.error.message, /10MB/);
});

test('validatePublishInput: content decoding to exactly 10MB passes (boundary is inclusive)', () => {
  const exact = Buffer.alloc(10 * 1024 * 1024).toString('base64');
  const r = validatePublishInput(goodInput({ contentBase64: exact }));
  assert.equal(r.ok, true);
});

// ---- validatePublishInput: path segment rules, delegated to DH_PATHS ----

test('validatePublishInput: a "." or ".." segment in pathInRepo is INVALID_INPUT (delegates to parseDocPath)', () => {
  const dot = validatePublishInput(goodInput({ pathInRepo: './design.md' }));
  assert.equal(dot.ok, false);
  assert.equal(dot.error.code, 'INVALID_INPUT');
  assert.equal(dot.error.field, 'pathInRepo');

  const dotdot = validatePublishInput(
    goodInput({ pathInRepo: 'a/../design.md', fileName: 'design.md' })
  );
  assert.equal(dotdot.ok, false);
  assert.equal(dotdot.error.field, 'pathInRepo');
});

test('validatePublishInput: an empty path segment (doubled slash) is INVALID_INPUT', () => {
  const r = validatePublishInput(
    goodInput({ pathInRepo: 'sub//design.md', fileName: 'design.md' })
  );
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_INPUT');
  assert.equal(r.error.field, 'pathInRepo');
});

test('validatePublishInput: a nested pathInRepo (subfolder) is valid and preserved', () => {
  const r = validatePublishInput(goodInput({ pathInRepo: 'sub/design.md' }));
  assert.equal(r.ok, true);
  assert.equal(r.normalized.docPath, 'cc-htmlfeedback/design--foo/sub/design.md');
});

// pathInRepo's basename must agree with the uploaded fileName - otherwise
// the Drive file created under pathInRepo's own last segment would never
// match doGet's later ?doc= resolution (which resolves by the DOC PATH's
// last segment, not by any separately-tracked fileName field).
test("validatePublishInput: pathInRepo's basename must match fileName", () => {
  const r = validatePublishInput(goodInput({ pathInRepo: 'sub/other-name.md' }));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_INPUT');
  assert.equal(r.error.field, 'pathInRepo');
});

test('validatePublishInput: featureDir sanitizes the feature the same way DH_PATHS.featureDir does', () => {
  const r = validatePublishInput(goodInput({ feature: 'design/foo:bar' }));
  assert.equal(r.ok, true);
  assert.equal(r.normalized.featureDir, 'design--foo-bar');
});
