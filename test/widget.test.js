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

test('persistence: persistDrafts saves drafts and not-yet-board-seen entries, excludes removed', () => {
  const { window } = loadWidget({ ccfb: { endpoint: '', sessionId: 'test', mode: 'static' } });
  window.eval(`
    store[1] = { id:1, quote:'a', context:'', section:'', note:'', type:'comment', removed:false, draft:true, page:location.href };
    store[2] = { id:2, quote:'b', context:'', section:'', note:'', type:'comment', removed:false, draft:false, sid:'s2', boardSeen:true, page:location.href };
    store[3] = { id:3, quote:'c', context:'', section:'', note:'', type:'comment', removed:true,  draft:true, page:location.href };
    persistDrafts();
  `);
  const saved = JSON.parse(window.sessionStorage.getItem('ccfb-drafts:/test.html'));
  const ids = saved.map((s) => s.id);
  assert.deepEqual(
    ids,
    [1],
    'only the unremoved, not-board-seen draft persists (id 2 is board-seen, id 3 is removed)'
  );
});

test('persistence: restoreDrafts brings entries back and advances uid past the highest restored id', () => {
  const { window } = loadWidget({ ccfb: { endpoint: '', sessionId: 'test', mode: 'static' } });
  window.sessionStorage.setItem(
    'ccfb-drafts:/test.html',
    JSON.stringify([
      {
        id: 7,
        quote: 'restored',
        context: '',
        section: '',
        note: 'n',
        type: 'comment',
        draft: true,
        page: 'http://127.0.0.1:4317/test.html',
      },
    ])
  );
  window.eval('restoreDrafts();');
  const f = window.eval('store[7]');
  assert.equal(f.quote, 'restored');
  assert.equal(f.draft, true);
  const nextId = window.eval('++uid');
  assert.equal(nextId, 8, 'uid was advanced past the restored id 7');
});

test('persistence: a restored draft:false entry with no sid reverts to a draft', () => {
  const { window } = loadWidget({ ccfb: { endpoint: '', sessionId: 'test', mode: 'static' } });
  window.sessionStorage.setItem(
    'ccfb-drafts:/test.html',
    JSON.stringify([
      {
        id: 3,
        quote: 'in flight',
        context: '',
        section: '',
        note: '',
        type: 'comment',
        draft: false,
        sid: undefined,
        page: 'http://127.0.0.1:4317/test.html',
      },
    ])
  );
  window.eval('restoreDrafts();');
  assert.equal(
    window.eval('store[3].draft'),
    true,
    'no sid means the POST outcome is unknown; a visible Fix button beats a stranded card'
  );
});
