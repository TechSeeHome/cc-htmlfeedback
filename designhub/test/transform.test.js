const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transform } = require('../build-designhub.js');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'feedback-widget.html'), 'utf8');

test('transform produces a self-injecting widget with GAS transport', () => {
  const out = transform(src);
  assert.match(out, /google\.script\.run/);
  assert.match(out, /dhRun\('submitComment'/);
  assert.match(out, /dhRun\('listComments'/);
  // Upstream comment lines legitimately MENTION /__ccfb/ - assert on code lines only.
  const code = out.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /\/__ccfb\//);        // no live server endpoints remain
  assert.doesNotMatch(out, /EventSource/);        // SSE fully removed (v1)
  // Page keying goes through dhPage(); its own fallback is the ONE allowed use.
  assert.equal((code.match(/location\.href/g) || []).length, 1,
    'only the dhPage() fallback may reference location.href');
  assert.match(out, /function dhPage\(\)/);
  assert.match(out, /setInterval\(loadTickets, 30000\)/);
  assert.match(out, /__fbWidgetLoaded/);          // self-injection guard kept
  assert.ok(out.length > 30000, 'suspiciously small output: ' + out.length);
});

test('transform fails loudly when an anchor string is missing (upstream drift)', () => {
  assert.throws(() => transform(src.replace('function ccfbPost', 'function ccfbPostX')),
    /ccfbPost/);
});
