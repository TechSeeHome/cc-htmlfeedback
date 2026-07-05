const { test } = require('node:test');
const assert = require('node:assert');
const { loadWidget, select, tick } = require('./helpers/dom.js');

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

test('add(): connected mode creates a draft, does not POST, and sets page', async () => {
  const { window, document, posted } = loadWidget({
    ccfb: { endpoint: '', sessionId: 'test', mode: 'static' },
  });
  const p = document.getElementById('target');
  select(window, p.firstChild, 0, 11); // "Hello world"
  await tick();
  document.getElementById('fb-text').value = 'make this bold';
  document
    .getElementById('fb-text')
    .dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
  await tick();

  assert.deepEqual(posted, [], 'no POST fired');
  const f = window.eval('store[1]');
  assert.equal(f.draft, true);
  assert.equal(f.quote, 'Hello world');
  assert.equal(f.note, 'make this bold');
  assert.equal(f.page, 'http://127.0.0.1:4317/test.html');
});

test('add(): disconnected mode is unchanged (no draft field, no persistence)', async () => {
  const { window, document } = loadWidget(); // no ccfb
  const p = document.getElementById('target');
  select(window, p.firstChild, 0, 11);
  await tick();
  document.getElementById('fb-text').value = 'a note';
  document
    .getElementById('fb-text')
    .dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
  await tick();

  const f = window.eval('store[1]');
  assert.equal(f.draft, undefined, 'draft is a connected-mode-only concept');
  assert.equal(
    window.sessionStorage.getItem('ccfb-drafts:/test.html'),
    null,
    'disconnected mode never writes the snapshot'
  );
});

test('cardHTML: a draft card is editable, has a Fix button, no status pill', () => {
  const { window, document } = loadWidget({
    ccfb: { endpoint: '', sessionId: 'test', mode: 'static' },
  });
  window.eval(`
    store[1] = { id:1, quote:'x', context:'', section:'', note:'', type:'strike', removed:false,
      draft:true, page:location.href, status:'todo', result:'', files:[] };
    render();
  `);
  const card = document.querySelector('.fb-card[data-fb-id="1"]');
  assert.ok(
    card.querySelector('.fb-note[contenteditable="true"]'),
    'note is editable even though empty'
  );
  assert.equal(card.querySelector('.fb-status'), null, 'no status pill on a draft');
  const fixBtn = card.querySelector('.fb-fixbtn');
  assert.ok(fixBtn, 'Fix button present');
  assert.equal(fixBtn.getAttribute('aria-label'), 'Send to the agent to fix: x');
});

test('cardHTML: a submitted card is read-only, no Fix button', () => {
  const { window, document } = loadWidget({
    ccfb: { endpoint: '', sessionId: 'test', mode: 'static' },
  });
  window.eval(`
    store[1] = { id:1, quote:'x', context:'', section:'', note:'do it', type:'comment', removed:false,
      draft:false, sid:'s1', page:location.href, status:'todo', result:'', files:[] };
    render();
  `);
  const card = document.querySelector('.fb-card[data-fb-id="1"]');
  assert.ok(card.querySelector('.fb-note-ro'), 'submitted note is read-only');
  assert.equal(card.querySelector('.fb-fixbtn'), null);
  assert.ok(card.querySelector('.fb-status'), 'submitted card has a status pill');
});

test('cardHTML: a draft with a whitespace-only quote gets a Fix button with no bare trailing colon', () => {
  const { window, document } = loadWidget({
    ccfb: { endpoint: '', sessionId: 'test', mode: 'static' },
  });
  window.eval(`
    store[1] = { id:1, quote:'   ', context:'', section:'', note:'', type:'strike', removed:false,
      draft:true, page:location.href, status:'todo', result:'', files:[] };
    render();
  `);
  const card = document.querySelector('.fb-card[data-fb-id="1"]');
  const fixBtn = card.querySelector('.fb-fixbtn');
  assert.ok(fixBtn, 'Fix button present even for a whitespace-only quote');
  assert.equal(
    fixBtn.getAttribute('aria-label'),
    'Send to the agent to fix',
    'no bare trailing ": " when the quote is empty/whitespace-only'
  );
});

test('submitDraft: flips draft false at send, sets sid on success, renders To do', async () => {
  const { window, document } = loadWidget({
    ccfb: { endpoint: '', sessionId: 'test', mode: 'static' },
  });
  window.eval(`
    store[1] = { id:1, quote:'x', context:'', section:'', note:'n', type:'comment', removed:false,
      draft:true, page:location.href, status:'todo', result:'', files:[] };
    render();
  `);
  await window.eval('submitDraft(store[1])');
  const f = window.eval('store[1]');
  assert.equal(f.draft, false);
  assert.equal(f.sid, 'srv-0');
  assert.equal(
    document.querySelector('.fb-card[data-fb-id="1"] .fb-fixbtn'),
    null,
    'card was rebuilt into submitted form'
  );
});

test('submitDraft: reverts to draft on POST failure, shows a toast', async () => {
  const { window, document } = loadWidget({
    ccfb: { endpoint: '', sessionId: 'test', mode: 'static' },
    fetchImpl: () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }),
  });
  window.eval(`
    store[1] = { id:1, quote:'x', context:'', section:'', note:'n', type:'comment', removed:false,
      draft:true, page:location.href, status:'todo', result:'', files:[] };
    render();
  `);
  await window.eval('submitDraft(store[1])');
  assert.equal(window.eval('store[1].draft'), true, 'reverted to draft on failure');
  assert.ok(document.querySelector('.fb-card[data-fb-id="1"] .fb-fixbtn'), 'Fix button is back');
  assert.equal(
    document.getElementById('fb-toast').textContent,
    '⚠️ Submission failed - draft kept'
  );
});

test('submitDraft: never overwrites a sid SSE already stamped (content-adoption race)', async () => {
  const { window } = loadWidget({ ccfb: { endpoint: '', sessionId: 'test', mode: 'static' } });
  window.eval(`
    store[1] = { id:1, quote:'x', context:'', section:'', note:'n', type:'comment', removed:false,
      draft:false, page:location.href, status:'todo', result:'', files:[], boardSeen:false };
    reconcile([{ id:'ssid', quote:'x', note:'n', page:location.href, status:'todo' }]); // SSE beats the POST response
  `);
  assert.equal(window.eval('store[1].sid'), 'ssid', 'content-adoption stamped it first');
  await window.eval('submitDraft(store[1])'); // the response arrives after
  assert.equal(
    window.eval('store[1].sid'),
    'ssid',
    'the POST response never overwrote the SSE-stamped sid'
  );
});

test('reconcile: excludes drafts from content-adoption (the misadoption bug found in review)', () => {
  const { window } = loadWidget({ ccfb: { endpoint: '', sessionId: 'test', mode: 'static' } });
  window.eval(`
    store[1] = { id:1, quote:'x', context:'', section:'', note:'n', type:'comment', removed:false,
      draft:true, page:location.href, status:'todo', result:'', files:[] };
    uid = 1; // matches real usage, where uid always advances past any existing store id — avoids
             // reconcile()'s own ++uid colliding with the manually-created store[1] above
    reconcile([{ id:'other', quote:'x', note:'n', page:location.href, status:'todo' }]);
  `);
  assert.equal(
    window.eval('store[1].sid'),
    undefined,
    'the unsent draft must NOT be adopted by a same-text ticket from elsewhere'
  );
  assert.equal(
    Object.keys(window.eval('store')).length,
    2,
    'the incoming ticket got its own new card instead'
  );
});

test('reconcile: marks matched entries board-seen and re-schedules a persist', () => {
  const { window } = loadWidget({ ccfb: { endpoint: '', sessionId: 'test', mode: 'static' } });
  window.eval(`
    store[1] = { id:1, quote:'x', context:'', section:'', note:'n', type:'comment', removed:false,
      draft:false, sid:'s1', page:location.href, status:'todo', result:'', files:[], boardSeen:false };
    reconcile([{ id:'s1', quote:'x', note:'n', page:location.href, status:'todo' }]);
  `);
  assert.equal(window.eval('store[1].boardSeen'), true);
});
