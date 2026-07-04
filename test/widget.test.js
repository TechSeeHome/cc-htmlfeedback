const { test } = require('node:test');
const assert = require('node:assert');
const { loadWidget } = require('./helpers/dom.js');

test('harness: loadWidget boots the real widget (disconnected mode)', () => {
  const { document } = loadWidget();
  assert.ok(document.getElementById('fb-launch'), 'widget markup injected');
  assert.ok(document.getElementById('fb-panel'), 'panel present');
});

test('harness: loadWidget boots the real widget (connected mode)', () => {
  const { document } = loadWidget({ ccfb: { endpoint: '', sessionId: 'test', mode: 'static' } });
  assert.equal(
    document.getElementById('fb-conn').title,
    'Connecting to the Claude session…',
    'connected mode starts the SSE connection attempt'
  );
});
