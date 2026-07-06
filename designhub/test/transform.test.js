const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { transform, wrap } = require('../build-designhub.js');

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

test('transform fails loudly when a second anchor string is missing (loadTickets renamed)', () => {
  assert.throws(() => transform(src.replace('function loadTickets', 'function loadTicketsX')),
    /loadTickets/);
});

test('transform fails loudly when subscribeSSE cannot be located (renamed/restructured upstream)', () => {
  assert.throws(() => transform(src.replace('function subscribeSSE(){', 'function subscribeSSEX(){')),
    /subscribeSSE/);
});

test('transform fails loudly on a second <style> block (would otherwise be silently dropped)', () => {
  const injected = src.replace('</script>', '</script>\n<style>.extra{color:red}</style>');
  assert.throws(() => transform(injected), /exactly one <style> block/);
});

test('transform fails loudly on a second <script> block (would otherwise be silently dropped, even one carrying a new /__ccfb/ endpoint)', () => {
  const injected = src.replace('</script>', '</script>\n<script>fetch("/__ccfb/newthing");</script>');
  assert.throws(() => transform(injected), /exactly one <script> block/);
});

test('transform fails loudly when the output would be malformed JS (syntax backstop catches what no single anchor check does)', () => {
  // Plausible upstream reformat: a nested object literal inside subscribeSSE whose closing brace
  // lands at the same indentation the non-greedy subscribeSSE regex stops at. The match still
  // contains "EventSource" (so that guard passes) but truncates before the function's real end,
  // leaving the original tail (the reload listener, the catch, the real closing brace) dangling as
  // orphaned statements - invalid JS that no earlier check in transform() catches on its own.
  const injected = src.replace(
    "es.addEventListener('tickets', e => { try { reconcile(JSON.parse(e.data).tickets || []); } catch{} });",
    "es.addEventListener('tickets', e => { try { reconcile(JSON.parse(e.data).tickets || []); } catch{} });\n      var X = {\n    a: 1\n  };"
  );
  assert.throws(() => transform(injected), /not valid JavaScript/);
});

test('wrap() round-trips through require() to the exact transform() output (real widget content)', () => {
  const out = transform(src);
  const wrapped = wrap(out);
  const f = path.join(os.tmpdir(), 'wrap-roundtrip-' + process.pid + '-' + Date.now() + '.js');
  fs.writeFileSync(f, wrapped);
  try {
    delete require.cache[require.resolve(f)];
    const roundTripped = require(f);
    assert.equal(roundTripped, out);
  } finally {
    fs.unlinkSync(f);
  }
});

test('wrap() safely escapes JS/JSON-tricky content: quotes, backslashes, backticks, ${}, U+2028/U+2029, emoji', () => {
  const tricky = 'a"b\'c\\d`e${f}g h i</script>j 🎉 k';
  const wrapped = wrap(tricky);
  const f = path.join(os.tmpdir(), 'wrap-tricky-' + process.pid + '-' + Date.now() + '.js');
  fs.writeFileSync(f, wrapped);
  try {
    delete require.cache[require.resolve(f)];
    const roundTripped = require(f);
    assert.equal(roundTripped, tricky);
  } finally {
    fs.unlinkSync(f);
  }
});
