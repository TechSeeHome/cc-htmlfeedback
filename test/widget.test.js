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

test('sections: a draft entry renders under a Drafts section, counted as outstanding', () => {
  const { window, document } = loadWidget({
    ccfb: { endpoint: '', sessionId: 'test', mode: 'static' },
  });
  // Poke the store directly — this test is about rendering/bucketing, not creation.
  window.eval(`
    store[1] = { id: 1, quote: 'x', context: '', section: '', note: '', type: 'comment',
      removed: false, draft: true, page: location.href, status: 'todo', result: '', files: [] };
    render();
  `);
  const draftSection = document.querySelector('details[data-st="draft"]');
  assert.ok(draftSection, 'a draft-keyed section exists');
  assert.equal(draftSection.querySelector('summary span').textContent, 'Drafts');
  assert.equal(draftSection.hidden, false);
  const otherSections = ['in-progress', 'todo', 'error', 'done'];
  otherSections.forEach((k) => {
    assert.equal(
      document.querySelector(`details[data-st="${k}"]`).hidden,
      true,
      `${k} stays hidden when empty`
    );
  });
  assert.equal(document.getElementById('fb-count').textContent, '1', 'draft counts as outstanding');
});
