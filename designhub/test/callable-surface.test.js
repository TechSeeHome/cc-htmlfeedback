// Final-review finding: a top-level GAS function without a trailing underscore
// is reachable from a published doc's own script via google.script.run.
// D17(a) binds that callable surface to doGet (the web app entry point) plus
// exactly the documented bridge functions - nothing else. Per-file review
// checked each bridge function individually but structurally couldn't catch a
// stray public function added elsewhere (drive.js's dhReconcile_/
// dhInstallReconcilerTrigger_ were originally missing their underscores).
// This is a pure static source scan - no GAS APIs, no live calls.
// listKnowledge/refreshKnowledge (Knowledge Portal design K9/Option B) are a
// deliberate, documented extension of this same surface - not scope creep.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GAS_DIR = path.join(__dirname, '..', 'gas');
const ENTRY_FILES = ['main.js', 'bridge.js', 'drive.js'];
const ALLOWED_PUBLIC = new Set([
  'doGet',
  'getIdentity',
  'listCatalog',
  'listComments',
  'submitComment',
  'reply',
  'setStatus',
  // Knowledge Portal (K9/Option B) bridge extension - see bridge.js.
  'listKnowledge',
  'refreshKnowledge',
]);

test('exactly the documented functions are google.script.run-reachable (no trailing underscore)', () => {
  const publicFns = [];
  for (const file of ENTRY_FILES) {
    const src = fs.readFileSync(path.join(GAS_DIR, file), 'utf8');
    for (const m of src.matchAll(/^function\s+(\w+)\s*\(/gm)) {
      if (!m[1].endsWith('_')) publicFns.push(file + ':' + m[1]);
    }
  }
  const names = publicFns.map((f) => f.split(':')[1]).sort();
  assert.deepEqual(
    names,
    [...ALLOWED_PUBLIC].sort(),
    'unexpected public (non-underscore) top-level function(s) found: ' +
      publicFns.join(', ') +
      ' - either suffix with _ or add to ALLOWED_PUBLIC with a documented reason'
  );
});
