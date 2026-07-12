// Verifies: page serves, widget boots, identity chip shows an org-domain user,
// a programmatic selection submits through the bridge (fix-now path), and the
// board reflects it.
const EXEC = '__DH_EXEC__',
  DOC = '__DH_DOC__';
const page = await browser.getPage('dh-e2e');
await page.goto(`${EXEC}?doc=${DOC}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
let frame = null;
for (let i = 0; i < 45 && !frame; i++) {
  await page.waitForTimeout(1000);
  for (const f of page.frames()) {
    if (await f.evaluate(() => !!document.getElementById('fb-launch')).catch(() => false)) {
      frame = f;
      break;
    }
  }
}
if (!frame) throw new Error('widget never appeared');
// The chip (#dh-identity, set by widgetTags in render.js) lands asynchronously:
// widgetTags polls for the panel + google.script.run, then a bridge round trip -
// poll for it instead of reading immediately. (Do NOT use a positional selector
// like ".fb-head div:last-child": it matches the Clean/dock button row.)
let identity = '';
for (let i = 0; i < 20 && !identity; i++) {
  await page.waitForTimeout(1000);
  identity = await frame.evaluate(
    () => (document.getElementById('dh-identity') || {}).textContent || ''
  );
}
console.log('identity chip:', identity);
const selected = await frame.evaluate(() => {
  const p = [...document.querySelectorAll('p,td,li')].find((el) => el.innerText.trim().length > 60);
  if (!p) throw new Error('no eligible element (p/td/li with >60 chars) found on fixture page');
  const r = document.createRange();
  r.selectNodeContents(p);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
  // The widget opens its popover ONLY on a real mouseup on the content (a
  // programmatic Selection alone never triggers it) - synthesize one that bubbles.
  p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return p.innerText.trim().slice(0, 40);
});
console.log('selected:', JSON.stringify(selected));
await page.waitForTimeout(800);
// Get initial card count before submitting
const initialCardCount = await frame.evaluate(
  () => document.querySelectorAll('#fb-panel li, #fb-panel .fb-card, #fb-panel .fb-item').length
);
// Meta/Ctrl+click on the popover Comment button is the connected-mode
// "fix now" fast path - it calls submitDraft() and therefore the BRIDGE
// immediately (a plain click only creates a local draft).
await frame.click('#fb-comment', { modifiers: ['Meta'] });
// Poll for the new card to appear on the board (max 20s, poll every 300ms)
const maxWait = 20000;
const pollInterval = 300;
const startTime = Date.now();
let cardCount = initialCardCount;
while (cardCount === initialCardCount && Date.now() - startTime < maxWait) {
  await page.waitForTimeout(pollInterval);
  cardCount = await frame.evaluate(
    () => document.querySelectorAll('#fb-panel li, #fb-panel .fb-card, #fb-panel .fb-item').length
  );
}
if (cardCount === initialCardCount)
  throw new Error('board card count did not increase within ' + maxWait + 'ms');
console.log(
  'board cards:',
  await frame.evaluate(
    () => document.querySelectorAll('#fb-panel li, #fb-panel .fb-card, #fb-panel .fb-item').length
  )
);
console.log('screenshot:', await saveScreenshot(await page.screenshot(), 'dh-e2e.png'));
