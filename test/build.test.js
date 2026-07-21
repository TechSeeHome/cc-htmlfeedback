// build.js is a standalone CLI script (top-level code, no exports, hardcodes
// `root = __dirname`) so it can't be `require()`-d in-process without mutating
// this repo's own tracked files.
//
// Two kinds of tests here:
//  1. Fixture tests copy build.js into a throwaway tmpdir alongside a minimal,
//     valid `feedback-widget.html` (and the other inputs it reads: lib/,
//     server.js, extension/) and run it as a child process there - safe
//     coverage of every structural-invariant guard (drift detection, the
//     <style>/<script> count checks, the IIFE-wrapper check, etc.) without
//     touching this repo. Because the child runs a *copy* of build.js, c8
//     cannot attribute that execution back to the tracked build.js file, so
//     these are correctness/regression tests, not what satisfies the
//     coverage gate.
//  2. The two "real repo" tests below run the actual tracked build.js
//     in place (cwd = repo root) so c8 attributes their coverage to it.
//     Both are provably side-effect-free: `--check` never writes, and the
//     plain run only re-writes outputs that `--check` (run first, in the
//     same test) already confirmed are byte-identical to what would be
//     written - so this repo's tracked files never actually change.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');

test("build.js --check passes against this repo's real, in-sync outputs", () => {
  const out = execFileSync(process.execPath, ['build.js', '--check'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.match(out, /build\.js --check: all \d+ plugin\/extension outputs in sync/);
});

test('build.js (write mode) against the real repo is a byte-for-byte no-op when already in sync', () => {
  // Precondition established by the previous test (and enforced by CI/pre-push
  // separately): the repo's generated outputs already match feedback-widget.html,
  // server.js, and lib/. So re-running the write path here cannot change any
  // tracked file - it rewrites each output with the exact content --check just
  // verified is already on disk. Snapshot + assert-unchanged anyway, defensively.
  const watched = [
    'extension/feedback-widget.js',
    'plugins/cc-htmlfeedback/feedback-widget.js',
    'plugins/cc-htmlfeedback/server.js',
  ];
  const before = watched.map((rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
  const out = execFileSync(process.execPath, ['build.js'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.match(
    out,
    /^Built extension\/feedback-widget\.js \+ assembled plugins\/cc-htmlfeedback\/ \(\d+ files, widget \d+B\)/
  );
  const after = watched.map((rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
  assert.deepEqual(after, before, 'build.js (write mode) must not alter already-in-sync outputs');
});

// A source big enough to clear build.js's `< 100 chars` sanity floor for
// css/markup/body.
const PAD = '/* padding to clear the 100-char sanity floor */\n'.repeat(4);

function validSource({
  style = PAD,
  markup = '<div id="fb-root">' + PAD + '</div>',
  body = PAD + 'console.log("hi");',
} = {}) {
  return (
    '<!doctype html>\n<html><head><style>' +
    style +
    '</style></head><body>\n<!-- a leading comment, stripped by build.js -->\n' +
    markup +
    '\n<script>\n(function(){' +
    body +
    '})();\n</script>\n</body></html>\n'
  );
}

function makeFixture({ source = validSource(), withExtensionDir = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfb-build-'));
  fs.copyFileSync(path.join(REPO_ROOT, 'build.js'), path.join(root, 'build.js'));
  fs.writeFileSync(path.join(root, 'feedback-widget.html'), source);
  fs.writeFileSync(path.join(root, 'server.js'), '// stub server\nmodule.exports = {};\n');
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib', 'queue.js'), '// stub lib file\nmodule.exports = {};\n');
  if (withExtensionDir) fs.mkdirSync(path.join(root, 'extension'));
  return root;
}

function run(root, args = []) {
  return execFileSync(process.execPath, ['build.js', ...args], { cwd: root, encoding: 'utf8' });
}

function runExpectFailure(root, args = []) {
  try {
    run(root, args);
    assert.fail('expected build.js to exit non-zero');
  } catch (e) {
    assert.equal(e.status, 1);
    return e.stderr;
  }
}

test('build.js (write mode) generates the extension + plugin outputs', () => {
  const root = makeFixture();
  const out = run(root);
  assert.match(out, /Built extension\/feedback-widget\.js/);

  const widget = fs.readFileSync(path.join(root, 'extension/feedback-widget.js'), 'utf8');
  assert.match(widget, /GENERATED from feedback-widget\.html by build\.js/);
  assert.match(widget, /console\.log\("hi"\);/);
  assert.match(widget, /fb-root/);

  const pluginWidget = fs.readFileSync(
    path.join(root, 'plugins/cc-htmlfeedback/feedback-widget.js'),
    'utf8'
  );
  assert.equal(pluginWidget, widget);
  assert.equal(
    fs.readFileSync(path.join(root, 'plugins/cc-htmlfeedback/server.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'server.js'), 'utf8')
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'plugins/cc-htmlfeedback/lib/queue.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'lib/queue.js'), 'utf8')
  );
});

test('build.js --check passes once outputs are in sync, and is a no-op (writes nothing new)', () => {
  const root = makeFixture();
  run(root);
  const before = fs.readFileSync(path.join(root, 'extension/feedback-widget.js'), 'utf8');
  const out = run(root, ['--check']);
  assert.match(out, /all 4 plugin\/extension outputs in sync/);
  assert.equal(fs.readFileSync(path.join(root, 'extension/feedback-widget.js'), 'utf8'), before);
});

test('build.js --check fails with DRIFT when an output is missing', () => {
  const root = makeFixture();
  run(root);
  fs.rmSync(path.join(root, 'extension/feedback-widget.js'));
  const stderr = runExpectFailure(root, ['--check']);
  assert.match(stderr, /DRIFT: extension\/feedback-widget\.js \(missing\)/);
});

test('build.js --check fails with DRIFT when an output was hand-edited out of sync', () => {
  const root = makeFixture();
  run(root);
  fs.writeFileSync(
    path.join(root, 'plugins/cc-htmlfeedback/server.js'),
    '// hand-edited, no longer matches source\n'
  );
  const stderr = runExpectFailure(root, ['--check']);
  assert.match(
    stderr,
    /DRIFT: plugins\/cc-htmlfeedback\/server\.js \(out of sync with server\.js\)/
  );
});

test('build.js refuses to run (write mode) when extension/ does not exist', () => {
  const root = makeFixture({ withExtensionDir: false });
  const stderr = runExpectFailure(root);
  assert.match(stderr, /extension\/ directory not found/);
});

test('build.js rejects a source with more than one <style> block', () => {
  const root = makeFixture({
    source: validSource().replace('</head>', '<style>' + PAD + '</style></head>'),
  });
  const stderr = runExpectFailure(root, ['--check']);
  assert.match(stderr, /expected exactly one <style> block, found 2/);
});

test('build.js rejects a source with more than one <script> block', () => {
  const source = validSource() + '<script>(function(){})();</script>\n';
  const root = makeFixture({ source });
  const stderr = runExpectFailure(root, ['--check']);
  assert.match(stderr, /expected exactly one <script> block, found 2/);
});

test('build.js rejects a <script> that is not a single bare IIFE', () => {
  const root = makeFixture({ source: validSource({ body: 'not.an.iife();' }) });
  // Rewrite the whole file so the <script> body is a plain statement, not `(function(){...})();`.
  fs.writeFileSync(
    path.join(root, 'feedback-widget.html'),
    validSource().replace(
      /<script>[\s\S]*?<\/script>/,
      '<script>\nconsole.log("not wrapped");\n</script>'
    )
  );
  const stderr = runExpectFailure(root, ['--check']);
  assert.match(stderr, /source <script> must be a single bare IIFE/);
});

test('build.js rejects extraction that is suspiciously small', () => {
  const root = makeFixture({
    source: validSource({ style: 'x', markup: '<div>y</div>', body: 'z' }),
  });
  const stderr = runExpectFailure(root, ['--check']);
  assert.match(stderr, /extraction produced suspiciously small output/);
});

test('build.js fails when </style> is not followed by a <script> block (markup extraction)', () => {
  // Exactly one <style> and one <script>, but <script> comes before <style> so the
  // `</style>...<script>` window build.js relies on never matches.
  const source =
    '<html><head><script>(function(){' +
    PAD +
    '})();</script></head><body><style>' +
    PAD +
    '</style></body></html>';
  const root = makeFixture({ source });
  const stderr = runExpectFailure(root, ['--check']);
  assert.match(stderr, /could not find markup between <\/style> and <script>/);
});
