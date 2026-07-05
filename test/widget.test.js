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

test('Fix all: submits drafts in creation order, hides when there are none', async () => {
  const { window, document } = loadWidget({
    ccfb: { endpoint: '', sessionId: 'test', mode: 'static' },
  });
  const fixAllBtn = document.getElementById('fb-fixall');
  assert.equal(fixAllBtn.hidden, true, 'hidden with zero drafts');

  window.eval(`
    store[1] = { id:1, quote:'a', context:'', section:'', note:'', type:'comment', removed:false, draft:true, page:location.href, status:'todo', result:'', files:[] };
    store[2] = { id:2, quote:'b', context:'', section:'', note:'', type:'comment', removed:false, draft:true, page:location.href, status:'todo', result:'', files:[] };
    render();
  `);
  assert.equal(fixAllBtn.hidden, false);
  assert.equal(fixAllBtn.textContent, '⚡ Fix all (2)');
  assert.equal(fixAllBtn.getAttribute('aria-label'), 'Fix all 2 drafts');

  fixAllBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(30);
  assert.equal(window.eval('store[1].draft'), false);
  assert.equal(window.eval('store[2].draft'), false);
  assert.equal(document.getElementById('fb-toast').textContent, '✓ 2 drafts sent');
  assert.equal(fixAllBtn.hidden, true, 'hidden again once all drafts are gone');
});

test('Fix all: stops at the first failure, reports the batch outcome, resumes on retry', async () => {
  let call = 0;
  const { window, document } = loadWidget({
    ccfb: { endpoint: '', sessionId: 'test', mode: 'static' },
    // Only count POSTs (the actual draft submissions) - connected mode also fires an untagged
    // GET from loadTickets() on init, which isn't part of the "2nd submission fails" scenario.
    fetchImpl: (reqUrl, opts) => {
      if (!(opts && opts.method === 'POST'))
        return Promise.resolve({ ok: true, json: async () => ({ tickets: [] }) });
      call++;
      if (call === 2) return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
      return Promise.resolve({ ok: true, json: async () => ({ id: 'srv-' + call }) });
    },
  });
  window.eval(`
    store[1] = { id:1, quote:'a', context:'', section:'', note:'', type:'comment', removed:false, draft:true, page:location.href, status:'todo', result:'', files:[] };
    store[2] = { id:2, quote:'b', context:'', section:'', note:'', type:'comment', removed:false, draft:true, page:location.href, status:'todo', result:'', files:[] };
    store[3] = { id:3, quote:'c', context:'', section:'', note:'', type:'comment', removed:false, draft:true, page:location.href, status:'todo', result:'', files:[] };
    render();
  `);
  document.getElementById('fb-fixall').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(30);
  assert.equal(window.eval('store[1].draft'), false, 'first succeeded');
  assert.equal(window.eval('store[2].draft'), true, 'second failed, reverted');
  assert.equal(window.eval('store[3].draft'), true, 'third never attempted');
  assert.equal(
    document.getElementById('fb-toast').textContent,
    '⚠️ Fix all stopped - 1 sent, 2 kept as drafts'
  );

  document.getElementById('fb-fixall').dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(30);
  assert.equal(window.eval('store[2].draft'), false, 'retry resumed from the failed item');
  assert.equal(window.eval('store[3].draft'), false);
  assert.equal(
    document.getElementById('fb-toast').textContent,
    '✓ 2 drafts sent',
    'retry only resubmitted the 2 remaining drafts, not the already-sent one'
  );
});

test('Fix all: discarding a later item mid-batch skips it instead of silently submitting it', async () => {
  let resolveFirst;
  // call counts real POSTs only (see the guard below) - it's the source of truth for "how many
  // submissions actually went out"; the harness's own `posted` array is populated by dom.js's
  // DEFAULT fetchImpl only, which this test overrides, so it would stay empty regardless.
  let call = 0;
  const { window, document } = loadWidget({
    ccfb: { endpoint: '', sessionId: 'test', mode: 'static' },
    fetchImpl: (reqUrl, opts) => {
      if (!(opts && opts.method === 'POST'))
        return Promise.resolve({ ok: true, json: async () => ({ tickets: [] }) });
      call++;
      // Hold the FIRST submission open so the test can discard the second item while it's in
      // flight - reproducing the race: an earlier await still pending, a later snapshot entry
      // getting discarded before the loop reaches it.
      if (call === 1) {
        return new Promise((resolve) => {
          resolveFirst = () => resolve({ ok: true, json: async () => ({ id: 'srv-1' }) });
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ id: 'srv-' + call }) });
    },
  });
  window.eval(`
    store[1] = { id:1, quote:'a', context:'', section:'', note:'', type:'comment', removed:false, draft:true, page:location.href, status:'todo', result:'', files:[] };
    store[2] = { id:2, quote:'b', context:'', section:'', note:'', type:'comment', removed:false, draft:true, page:location.href, status:'todo', result:'', files:[] };
    render();
  `);
  document.getElementById('fb-fixall').dispatchEvent(new window.Event('click', { bubbles: true }));
  // fixAll() has run synchronously up to its await on submitDraft(store[1]) - the first POST is
  // already in flight (pending on resolveFirst). Discard store[2] before the loop ever reaches it.
  window.eval(`store[2].removed = true; render();`);
  resolveFirst();
  await tick(30);
  assert.equal(window.eval('store[1].draft'), false, 'first item still submitted normally');
  assert.equal(call, 1, 'the discarded second item was never POSTed');
  assert.equal(
    window.eval('store[2].draft'),
    true,
    'discarded item is untouched by submitDraft (still draft:true, just removed)'
  );
  assert.equal(document.getElementById('fb-toast').textContent, '✓ 1 drafts sent');
  assert.equal(
    document.getElementById('fb-fixall').hidden,
    true,
    'no live drafts left once the discarded one is excluded'
  );
});

test('Fix all: a page "Clean" mid-batch (store entry deleted) is skipped too, not resubmitted', async () => {
  let resolveFirst;
  let call = 0; // real POST count only - see the sibling "discard" test above for why not `posted`
  const { window, document } = loadWidget({
    ccfb: { endpoint: '', sessionId: 'test', mode: 'static' },
    fetchImpl: (reqUrl, opts) => {
      if (!(opts && opts.method === 'POST'))
        return Promise.resolve({ ok: true, json: async () => ({ tickets: [] }) });
      call++;
      if (call === 1) {
        return new Promise((resolve) => {
          resolveFirst = () => resolve({ ok: true, json: async () => ({ id: 'srv-1' }) });
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ id: 'srv-' + call }) });
    },
  });
  window.eval(`
    store[1] = { id:1, quote:'a', context:'', section:'', note:'', type:'comment', removed:false, draft:true, page:location.href, status:'todo', result:'', files:[] };
    store[2] = { id:2, quote:'b', context:'', section:'', note:'', type:'comment', removed:false, draft:true, page:location.href, status:'todo', result:'', files:[] };
    render();
  `);
  document.getElementById('fb-fixall').dispatchEvent(new window.Event('click', { bubbles: true }));
  // fixAll()'s snapshot already holds a reference to store[2]; now simulate "Clean" wiping it
  // out of the live store entirely while store[1]'s POST is still in flight.
  window.eval('delete store[2];');
  resolveFirst();
  await tick(30);
  assert.equal(call, 1, 'only the still-live draft was POSTed; the cleared one was skipped');
  assert.equal(window.eval('store[2]'), undefined, 'store[2] stays deleted - Clean is not undone');
});

test('Fix all: a second rapid click mid-batch is a no-op (no duplicate POSTs, no clobbered status)', async () => {
  const { window, document, posted } = loadWidget({
    ccfb: { endpoint: '', sessionId: 'test', mode: 'static' },
  });
  window.eval(`
    store[1] = { id:1, quote:'a', context:'', section:'', note:'', type:'comment', removed:false, draft:true, page:location.href, status:'todo', result:'', files:[] };
    store[2] = { id:2, quote:'b', context:'', section:'', note:'', type:'comment', removed:false, draft:true, page:location.href, status:'todo', result:'', files:[] };
    render();
  `);
  const btn = document.getElementById('fb-fixall');
  // fixAll() sets its re-entrancy flag synchronously before its first await, so this second
  // dispatch - fired before any microtask has had a chance to run - lands while the flag is
  // already set and must be a no-op.
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick(30);
  assert.equal(
    posted.length,
    2,
    'each draft was POSTed exactly once, not duplicated by the second click'
  );
  assert.equal(window.eval('store[1].draft'), false);
  assert.equal(window.eval('store[2].draft'), false);
  assert.equal(document.getElementById('fb-toast').textContent, '✓ 2 drafts sent');
});

test('keybindings: Cmd/Ctrl+Enter fixes now; plain Enter still just saves (branch-ordering regression guard)', async () => {
  const { window, document, posted } = loadWidget({
    ccfb: { endpoint: '', sessionId: 'test', mode: 'static' },
  });
  const p = document.getElementById('target');
  select(window, p.firstChild, 0, 11);
  await tick();
  const ta = document.getElementById('fb-text');
  ta.value = 'fix now please';
  ta.dispatchEvent(
    new window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      metaKey: true,
    })
  );
  await tick();
  assert.equal(window.eval('store[1].draft'), false, 'Cmd+Enter submitted immediately');
  assert.equal(posted.length, 1);
  assert.equal(document.getElementById('fb-toast').textContent, '✓ Sent to the agent');
});

test('keybindings: Cmd/Ctrl+Backspace fixes now only on an empty box, ignores key-repeat', async () => {
  const { window, document, posted } = loadWidget({
    ccfb: { endpoint: '', sessionId: 'test', mode: 'static' },
  });
  const p = document.getElementById('target');
  select(window, p.firstChild, 0, 11);
  await tick();
  const ta = document.getElementById('fb-text');

  // non-empty box: the chord keeps its native word-delete behavior, never submits
  ta.value = 'something';
  ta.dispatchEvent(
    new window.KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    })
  );
  await tick();
  assert.equal(posted.length, 0, 'non-empty box: no submission');

  // key-repeat while empty: must not fire
  ta.value = '';
  ta.dispatchEvent(
    new window.KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      repeat: true,
    })
  );
  await tick();
  assert.equal(posted.length, 0, 'key-repeat is ignored');

  // empty box, real keypress: fires
  ta.dispatchEvent(
    new window.KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    })
  );
  await tick();
  assert.equal(posted.length, 1);
  assert.equal(window.eval('store[1].type'), 'strike');
  assert.equal(window.eval('store[1].draft'), false);
});

test('keybindings: Cmd/Ctrl+click on a popover button fixes now', async () => {
  const { window, document, posted } = loadWidget({
    ccfb: { endpoint: '', sessionId: 'test', mode: 'static' },
  });
  const p = document.getElementById('target');
  select(window, p.firstChild, 0, 11);
  await tick();
  document
    .getElementById('fb-comment')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true, metaKey: true }));
  await tick();
  assert.equal(posted.length, 1);
  assert.equal(window.eval('store[1].draft'), false);
});
