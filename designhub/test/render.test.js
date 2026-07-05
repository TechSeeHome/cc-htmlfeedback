const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../gas/lib/render.js');

const EXEC = 'https://script.google.com/macros/s/XXX/exec';

test('injectBase adds base target=_top inside head', () => {
  const out = R.injectBase('<html><head><title>t</title></head><body>x</body></html>');
  assert.match(out, /<head><base target="_top">/);
});

test('injectBase rewrites bare #anchor links to target=_self (poc1 finding)', () => {
  const out = R.injectBase('<head></head><a href="#sec">jump</a><a href="https://x">out</a>');
  assert.match(out, /<a target="_self" href="#sec">/);
  assert.doesNotMatch(out, /target="_self" href="https/);
  // single-quoted attributes get the same treatment
  assert.match(R.injectBase("<head></head><a href='#s2'>j</a>"), /<a target="_self" href='#s2'>/);
});

test('injectBase prepends base when there is no head', () => {
  assert.match(R.injectBase('<p>x</p>'), /^<base target="_top">/);
});

test('serveHtml injects __CCFB config + widget asset tag before </body>', () => {
  const out = R.serveHtml('<html><head></head><body><p>doc</p></body></html>',
    'repo/feat/docs/a.html', EXEC);
  assert.match(out, /window\.__CCFB=\{.*"docPath":"repo\/feat\/docs\/a\.html".*\}/);
  assert.match(out, new RegExp(EXEC.replace(/[/.]/g, '\\$&') + '\\?asset=widget'));
  assert.ok(out.indexOf('?asset=widget') < out.indexOf('</body>'));
  assert.match(out, /"mode":"proxy"/);   // disables the widget's morph path
  assert.match(out, /d\.id="dh-identity"/);   // the Task 13 E2E finds the chip by this id
});

test('widgetTags defuses </script> inside docPath (D14 does not character-restrict segments)', () => {
  // parseDocPath rejects empty/./.. segments but not HTML-special characters -
  // a docPath whose real Drive path components straddle a "/" can carry a
  // literal </script> substring into the inline __CCFB config.
  const evil = 'repo/feat/foo</script><script>alert(1)</script>x.html';
  const out = R.widgetTags(evil, EXEC);
  assert.doesNotMatch(out, /alert\(1\)<\/script>x/);
  assert.match(out, /<\\\/script/);
});

test('serveHtml defuses </script> inside docPath the same way', () => {
  const evil = 'repo/feat/foo</script><script>alert(1)</script>x.html';
  const out = R.serveHtml('<html><head></head><body></body></html>', evil, EXEC);
  assert.doesNotMatch(out, /alert\(1\)<\/script>x/);
  assert.match(out, /<\\\/script/);
});

test('mdShell embeds MD as JSON, inlines marked, loads mermaid as asset', () => {
  const out = R.mdShell('# Hi\n```mermaid\ngraph TD;A-->B;\n```', 'var marked={parse:function(){}};',
    EXEC + '?asset=mermaid', 'design.md');
  assert.match(out, /var MD_SOURCE="# Hi/);
  assert.match(out, /var marked=/);
  assert.match(out, /\?asset=mermaid/);
  assert.match(out, /<base target="_top">/);
  // poc1: rendered #anchor links must get target=_self at runtime or a TOC
  // click navigates the top window out of the sandbox
  assert.match(out, /a\.target="_self"/);
});

test('mdShell defuses </script> inside the markdown payload', () => {
  const out = R.mdShell('bad </script> here', 'x', 'y', 't');
  assert.doesNotMatch(out, /bad <\/script> here/);
  assert.match(out, /<\\\/script/);
});

test('treeHtml groups rows repo -> feature and links via the url column', () => {
  const rows = [
    { repo: 'r1', feature: 'f1', title: 'Doc A', url: EXEC + '?doc=r1/f1/a.html', status: 'active' },
    { repo: 'r1', feature: 'f2', title: 'Doc B', url: EXEC + '?doc=r1/f2/b.html', status: 'active' },
    { repo: 'r1', feature: 'f1', title: 'gone', url: '#', status: 'archived' },
  ];
  const out = R.treeHtml(rows, EXEC);
  assert.match(out, /r1/);
  assert.match(out, />Doc A</);
  assert.doesNotMatch(out, />gone</);          // archived rows hidden
  assert.match(out, /<h3>f1<\/h3>[\s\S]*Doc A/);
});

test('treeHtml escapes titles', () => {
  const out = R.treeHtml([{ repo: 'r', feature: 'f', title: '<img src=x>', url: '#', status: 'active' }], EXEC);
  assert.doesNotMatch(out, /<img src=x>/);
  assert.match(out, /&lt;img/);
});

test('treeHtml renders an empty state', () => {
  assert.match(R.treeHtml([], EXEC), /No docs published yet/);
});

test('treeHtml blocks javascript: URLs planted in the url column (D18 Contributor Sheet access)', () => {
  // r.url is normally a code-generated execUrl, but it is read back from the
  // _portal-index Sheet at render time and Contributor Shared Drive access
  // can edit that Sheet's cells directly - esc() alone would not stop a
  // scheme-based attack since a javascript: URI needs no HTML-special chars.
  const rows = [{ repo: 'r', feature: 'f', title: 'Evil', url: 'javascript:alert(1)', status: 'active' }];
  const out = R.treeHtml(rows, EXEC);
  assert.doesNotMatch(out, /javascript:/i);
  assert.match(out, /href="#"/);
});

test('safeHref allowlists http(s) and scheme-less refs, rejects other schemes', () => {
  assert.equal(R.safeHref('https://example.com/x'), 'https://example.com/x');
  assert.equal(R.safeHref('http://example.com/x'), 'http://example.com/x');
  assert.equal(R.safeHref('#'), '#');
  assert.equal(R.safeHref('javascript:alert(1)'), '#');
  assert.equal(R.safeHref('data:text/html,<script>alert(1)</script>'), '#');
  // classic filter-bypass forms: browsers strip leading whitespace/control
  // chars and embedded tabs/newlines before parsing the scheme
  assert.equal(R.safeHref('  javascript:alert(1)'), '#');
  assert.equal(R.safeHref('java\tscript:alert(1)'), '#');
  assert.equal(R.safeHref('\n\tjavascript:alert(1)'), '#');
});
