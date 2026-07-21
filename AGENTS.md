# cc-htmlfeedback - review guidance for AI reviewers

Runtime tooling for an in-page HTML feedback loop, shipped as a Claude Code plugin
marketplace. Things a useful review of this repo must know:

## Layout and generated code

- Canonical sources live at the repo root: `server.js`, `lib/`, `build.js`, and
  `extension/feedback-widget.js` (itself built from `feedback-widget.html` by `build.js`).
- `plugins/cc-htmlfeedback/` contains **build-artifact copies** of the server, lib, and
  widget, assembled by `node build.js`. Never suggest editing those copies directly;
  if a diff hand-edits them without a matching root-source change, flag it. Drift is
  caught by `node build.js --check` in CI.
- The skill source of truth is `plugins/cc-htmlfeedback/skills/cc-htmlfeedback/` - that
  directory IS hand-edited (it is not a build artifact).

## Conventions

- Core (`server.js`, `lib/`, `build.js`, tests) is **CommonJS**, zero runtime
  dependencies by design - flag any new runtime dependency as a significant decision.
- Formatting: prettier (printWidth 100, singleQuote). Linting: oxlint (correctness rules
  are errors). Both are enforced in CI.

## Testing

- Framework is `node:test` (built-in runner), never jest/vitest/mocha.
- The widget is tested through a jsdom harness (`test/helpers/dom.js`) that stubs
  geometry, `EventSource`, and `fetch` - layout/pixel behavior is intentionally out of
  unit-test scope (covered by browser E2E separately).
- Coverage gate: c8, 75% lines minimum, run via `npm run test:cov`. New logic in
  `lib/` or `server.js` should come with tests.

## Review priorities

1. Hand-edits to generated files (`plugins/cc-htmlfeedback/{server.js,lib,feedback-widget.js}`).
2. Silent failure handling around the SSE/inbox loop (`lib/watch-inbox.js`, widget
   reconnect paths) - errors must surface, not be swallowed.
3. Security of the local server (`server.js`): it serves user files - watch for path
   traversal and injection in the widget-injection path (`lib/inject.js`).
4. Cross-runtime mistakes (Node APIs in GAS code, ESM/CJS mixups).
