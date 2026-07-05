const { test } = require('node:test');
const assert = require('node:assert');
const { injectWidget } = require('../lib/inject.js');

test('inserts both script tags before </body>', () => {
  const out = injectWidget('<html><body><h1>hi</h1></body></html>', 'SID');
  assert.ok(out.includes('window.__CCFB'));
  assert.ok(out.includes('/__ccfb/widget.js'));
  assert.ok(out.indexOf('__ccfb/widget.js') < out.indexOf('</body>'));
  assert.ok(out.includes('"SID"'));
});

test('appends at end when no </body>', () => {
  const out = injectWidget('<h1>hi</h1>', 'SID');
  assert.ok(out.includes('/__ccfb/widget.js'));
});

test('does not double-inject', () => {
  const once = injectWidget('<body></body>', 'SID');
  const twice = injectWidget(once, 'SID');
  assert.equal(twice.match(/__ccfb\/widget\.js/g).length, 1);
});

test('injects the serving mode into __CCFB (defaults to static)', () => {
  assert.ok(injectWidget('<body></body>', 'SID').includes('mode:"static"'));
  assert.ok(injectWidget('<body></body>', 'SID', 'proxy').includes('mode:"proxy"'));
});

test('injects the project namespace into __CCFB (empty string when omitted)', () => {
  assert.ok(injectWidget('<body></body>', 'SID', 'static', 'abc123').includes('ns:"abc123"'));
  assert.ok(injectWidget('<body></body>', 'SID').includes('ns:""'));
});
