const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../gas/lib/paths.js');

test('featureDir encodes path separators (D14)', () => {
  assert.equal(P.featureDir('feature/new-ui'), 'feature--new-ui');
  assert.equal(P.featureDir('design/designhub-platform'), 'design--designhub-platform');
  assert.equal(P.featureDir('plain'), 'plain');
});

test('featureDir strips characters Drive folder names cannot hold', () => {
  assert.equal(P.featureDir('a\\b:c'), 'a--b-c');
});

test('docPath builds repo/featureDir/subpath', () => {
  assert.equal(P.docPath('cc-htmlfeedback', 'design/designhub-platform', 'docs/designhub/design.html'),
    'cc-htmlfeedback/design--designhub-platform/docs/designhub/design.html');
});

test('parseDocPath splits and rejects traversal', () => {
  const p = P.parseDocPath('repo/feat--x/docs/a.html');
  assert.deepEqual(p, { repo: 'repo', featureDir: 'feat--x',
    segments: ['docs', 'a.html'], fileName: 'a.html' });
  assert.throws(() => P.parseDocPath('repo/feat/../../etc'), /invalid/);
  assert.throws(() => P.parseDocPath('repo'), /invalid/);
  assert.throws(() => P.parseDocPath(''), /invalid/);
});

test('parseDocPath rejects empty segments instead of silently collapsing them (D14 fail-loud)', () => {
  assert.throws(() => P.parseDocPath('/repo/feat/x.html'), /invalid/);   // leading slash
  assert.throws(() => P.parseDocPath('repo/feat/x.html/'), /invalid/);   // trailing slash
  assert.throws(() => P.parseDocPath('repo//feat/x.html'), /invalid/);   // doubled slash (e.g. an empty feature)
});

test('docPath and parseDocPath round-trip', () => {
  const built = P.docPath('cc-htmlfeedback', 'design/designhub-platform', 'docs/designhub/design.html');
  const parsed = P.parseDocPath(built);
  assert.deepEqual(parsed, { repo: 'cc-htmlfeedback', featureDir: 'design--designhub-platform',
    segments: ['docs', 'designhub', 'design.html'], fileName: 'design.html' });
});

test('companionName is the FULL file name + .comments (design section 5)', () => {
  assert.equal(P.companionName('design.html'), 'design.html.comments');
  assert.equal(P.companionName('design.md'), 'design.md.comments');
});
