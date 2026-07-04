// Shared jsdom bootstrap for widget tests. jsdom has no layout engine, so geometry reads
// (popover positioning) and innerText (needs layout) are stubbed — tests only exercise
// widget LOGIC, never pixel positioning.
// Safety note: this file and its callers use window.eval() to run the widget inside a
// disposable jsdom sandbox and to poke its state from tests. The evaluated source is always
// our own locally-built, trusted widget code (or literal test fixtures) — never untrusted
// input — so eval here is the intended test mechanism, not a security concern.
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const WIDGET_SRC_RAW = fs.readFileSync(
  path.join(__dirname, '..', '..', 'extension', 'feedback-widget.js'),
  'utf8'
);

// Tests poke the widget's internal state directly (e.g. `store[1] = {...}; render();`
// via a second, separate window.eval() call — see widget.test.js). That only works because
// of this splice: build.js nests all widget logic inside fbInit() (see build.js), so
// store/render are local to that one function call and vanish once it returns; nothing
// makes them reachable from a later, independent eval(). Worse, jsdom's window.eval doesn't
// share a persistent global *lexical* environment across separate calls the way real
// browsers do — top-level `let`/`const` from one eval() are invisible to the next — so even
// hoisting them out of fbInit wouldn't be enough. Real *properties* of the global object
// (window.foo = ...) don't have that problem: they're always live for every later eval() in
// the same window. So we splice a one-line alias, `window.store = store; window.render =
// render;`, right before fbInit()'s closing brace (where store/render are still in scope) —
// giving later eval() calls a bare `store`/`render` that resolves via normal global-object
// property lookup. Extend this list if a later test needs another internal — for a function
// (like `persistDrafts`/`restoreDrafts` below) a plain alias is fine, since the test only ever
// calls it, never expects reassignment to be visible back in the widget. For a plain value like
// `uid` a getter/setter pair is needed instead of a straight alias, since aliasing only copies
// the current value, not a live reference: a getter/setter closes over the `uid` binding
// itself, so reads/writes through `window.uid` stay in sync with the widget's own `++uid` etc.
const EXPOSE_HOOK =
  '\n  window.store = store; window.render = render;\n' +
  '  window.persistDrafts = persistDrafts; window.restoreDrafts = restoreDrafts;\n' +
  "  Object.defineProperty(window, 'uid', { configurable: true, get(){ return uid; }, set(v){ uid = v; } });\n";
const FBINIT_CLOSE_ANCHOR = '\n  }\n  if (document.body) fbInit();';
if (WIDGET_SRC_RAW.split(FBINIT_CLOSE_ANCHOR).length !== 2) {
  throw new Error(
    'test/helpers/dom.js: fbInit() closing-brace anchor not found exactly once in extension/feedback-widget.js — ' +
      "build.js's generated template likely changed; update FBINIT_CLOSE_ANCHOR/EXPOSE_HOOK."
  );
}
const WIDGET_SRC = WIDGET_SRC_RAW.replace(FBINIT_CLOSE_ANCHOR, EXPOSE_HOOK + FBINIT_CLOSE_ANCHOR);

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
