// Shared jsdom bootstrap for widget tests. jsdom has no layout engine, so geometry reads
// (popover positioning) and innerText (needs layout) are stubbed — tests only exercise
// widget LOGIC, never pixel positioning.
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const WIDGET_SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'extension', 'feedback-widget.js'),
  'utf8'
);

function stubGeometry(window) {
  const zeroRect = () => ({
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON() {
      return this;
    },
  });
  window.Range.prototype.getBoundingClientRect = zeroRect;
  window.Element.prototype.getBoundingClientRect = zeroRect;
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return 0;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return 0;
    },
  });
  // textContent is an accurate stand-in for innerText on the single-line plain-text notes
  // these tests use (no nested block elements needing <br>-to-\n translation).
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent;
    },
    set(v) {
      this.textContent = v;
    },
  });
}

const DEFAULT_BODY = '<p id="target">Hello world, this is a test paragraph for selection.</p>';

// Loads the REAL generated widget into a fresh jsdom window and lets it run, exactly as a
// browser would (the script auto-invokes on load — see build.js's fbInit() wrapper).
// ccfb: pass an object to simulate connected mode (the server's window.__CCFB injection);
// omit for disconnected mode. fetchImpl lets a test observe/control POST responses —
// the default resolves every POST with a fresh id and empty ticket list.
function loadWidget({
  url = 'http://127.0.0.1:4317/test.html',
  bodyHTML = DEFAULT_BODY,
  ccfb = null,
  fetchImpl,
} = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHTML}</body></html>`, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  stubGeometry(window);
  if (ccfb) window.__CCFB = ccfb;
  window.EventSource = class {
    constructor() {}
    close() {}
    addEventListener() {}
  };
  const posted = [];
  window.fetch =
    fetchImpl ||
    ((reqUrl, opts) => {
      if (opts && opts.method === 'POST' && String(reqUrl).includes('/__ccfb/tickets')) {
        posted.push(JSON.parse(opts.body));
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ id: 'srv-' + posted.length, tickets: [] }),
      });
    });
  window.eval(WIDGET_SRC);
  return { window, document: window.document, posted };
}

// Simulates the real mouseup -> getSelection -> showPop flow. node/start/end select a
// range within a single text node (matches how every test in this suite selects text).
function select(window, node, start, end) {
  const range = window.document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  node.parentElement.dispatchEvent(new window.Event('mouseup', { bubbles: true }));
}

function tick(ms = 10) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { loadWidget, select, tick };
