const { test } = require('node:test');
const assert = require('node:assert/strict');
const mod = () => import('../../plugins/designhub/skills/publish-design/scripts/anchors.mjs');

const DOC = '<html><body><h2>Intro</h2><p>The quick brown fox jumps over the lazy dog.</p></body></html>';
const t = (over) => Object.assign({ id: 'x', type: 'comment', status: 'open',
  quote: 'quick brown fox', context: 'The quick brown fox jumps over the lazy dog.',
  section: 'Intro' }, over);

test('unchanged when quote and context still present', async () => {
  const { reanchorPass } = await mod();
  assert.deepEqual(reanchorPass([t()], DOC, true), []);
});

test('quote gone -> anchor-lost (comment), including in-progress tickets', async () => {
  const { reanchorPass } = await mod();
  for (const status of ['open', 'in-progress']) {
    const out = reanchorPass([t({ status, quote: 'vanished text' })], DOC, true);
    assert.equal(out[0].status, 'anchor-lost');
  }
});

test('strike whose quote is gone auto-resolves (the fix WAS the deletion)', async () => {
  const { reanchorPass } = await mod();
  const out = reanchorPass([t({ type: 'strike', quote: 'vanished text' })], DOC, true);
  assert.equal(out[0].status, 'resolved');
  assert.match(out[0].result, /auto-verified/);
});

test('quote present but context gone -> anchor-lost (different occurrence, D15)', async () => {
  const { reanchorPass } = await mod();
  const out = reanchorPass([t({ context: 'A totally different sentence that held the quote before.' })], DOC, true);
  assert.equal(out[0].status, 'anchor-lost');
});

test('terminal tickets and replies are never touched', async () => {
  const { reanchorPass } = await mod();
  const out = reanchorPass([
    t({ status: 'resolved', quote: 'vanished' }),
    t({ status: 'declined', quote: 'vanished' }),
    t({ status: 'anchor-lost', quote: 'vanished' }),
    t({ type: 'reply', quote: '' }),
  ], DOC, true);
  assert.deepEqual(out, []);
});

test('html tags do not break matching (matching runs on text content)', async () => {
  const { reanchorPass } = await mod();
  const doc = '<h2>Intro</h2><p>The <b>quick</b> brown fox jumps over the lazy dog.</p>';
  assert.deepEqual(reanchorPass([t()], doc, true), []);
});

test('markdown syntax does not break matching (quotes come from RENDERED text)', async () => {
  const { reanchorPass } = await mod();
  const md = '## Intro\n\nThe **quick** `brown` [fox](https://x.example) jumps over the lazy dog.\n';
  assert.deepEqual(reanchorPass([t()], md, false), []);
});

test('markdown table decoration is stripped before matching', async () => {
  const { reanchorPass } = await mod();
  const md = '## Intro\n\n| a | b |\n|---|---|\n| The quick brown fox jumps over the lazy dog. | x |\n';
  assert.deepEqual(reanchorPass([t()], md, false), []);
});

test('quote and context present but section heading gone -> anchor-lost (full triple)', async () => {
  const { reanchorPass } = await mod();
  const doc = '<html><body><h2>Renamed</h2><p>The quick brown fox jumps over the lazy dog.</p></body></html>';
  const out = reanchorPass([t()], doc, true);
  assert.equal(out[0].status, 'anchor-lost');
  assert.match(out[0].result, /section/);
});

test('context ellipsis from the widget clip is tolerated', async () => {
  const { reanchorPass } = await mod();
  assert.deepEqual(reanchorPass([t({ context: 'The quick brown fox jumps…' })], DOC, true), []);
});

test('html entities are decoded before matching (source encodes what the browser rendered)', async () => {
  const { reanchorPass } = await mod();
  const doc = '<html><body><h2>Intro</h2><p>Foo &amp; Bar &lt;3 the quick brown fox jumps over the lazy dog.</p></body></html>';
  const ticket = t({ quote: 'Foo & Bar <3 the quick brown fox',
    context: 'Foo & Bar <3 the quick brown fox jumps over the lazy dog.' });
  assert.deepEqual(reanchorPass([ticket], doc, true), []);
});

test('nested emphasis fully unwraps (fixed-point strip) - a strike must NOT auto-resolve when the text is unchanged', async () => {
  const { reanchorPass } = await mod();
  const md = '## Intro\n\nThis is **bold _italic_ text** in a sentence.\n';
  const out = reanchorPass([t({ type: 'strike', quote: 'is bold italic text in',
    context: 'This is bold italic text in a sentence.' })], md, false);
  assert.deepEqual(out, []);
});

test('an escaped table pipe is preserved as a literal | (not confused with table decoration)', async () => {
  const { reanchorPass } = await mod();
  const md = '## Intro\n\n| type | note |\n|---|---|\n| string \\| number | primary key |\n';
  const out = reanchorPass([t({ type: 'strike', quote: 'string | number',
    context: 'string | number' })], md, false);
  assert.deepEqual(out, []);
});

test('a link whose text contains nested brackets still matches end to end', async () => {
  const { reanchorPass } = await mod();
  const md = '## Intro\n\nSee the [quick [brown] fox](https://example.com) jumps over the lazy dog.\n';
  const out = reanchorPass([t({ type: 'strike', quote: 'quick [brown] fox jumps over the lazy dog',
    context: 'quick [brown] fox jumps over the lazy dog' })], md, false);
  assert.deepEqual(out, []);
});

test('html entities are decoded on the markdown path too', async () => {
  const { reanchorPass } = await mod();
  const md = '## Intro\n\nFoo &amp; Bar &lt;3 the quick brown fox jumps over the lazy dog.\n';
  const ticket = t({ quote: 'Foo & Bar <3 the quick brown fox',
    context: 'Foo & Bar <3 the quick brown fox jumps over the lazy dog.' });
  assert.deepEqual(reanchorPass([ticket], md, false), []);
});
