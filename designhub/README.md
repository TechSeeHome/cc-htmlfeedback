# DesignHub (v1)

Publish design docs from this repo to a Google-login-gated hub with in-page
commenting; comments live in per-doc Google Sheets that agents read/write over
REST. Spec: `docs/designhub/design.md` (D1-D19). POC evidence:
`docs/designhub/pocs/`. Agent how-to: `docs/designhub/agent-access.md`.

- `build-designhub.js` - generates `gas/widget.js` from upstream
  `feedback-widget.html` (never edit either output or upstream; `--check` in CI).
  A plain `.js` string constant, not an HtmlService `.html` file - Chrome's
  Opaque Response Blocking (ORB) blocks the latter as a `<script>` subresource
  fetched from the sandboxed content iframe (found via Task 13's real E2E run).
- `gas/` - the Apps Script web app (clasp project). Deploy:
  `cd designhub/gas && clasp push -f && clasp create-deployment -i <id> -d "<desc>"`.
- `test/` - `node --test designhub/test/`; `e2e/` (sibling dir, NOT under `test/` - the node test runner would try to execute it) holds manual dev-browser scripts.
- Publishing: the `designhub` plugin's `/publish-design` skill
  (`plugins/designhub/`).
- Org-specific config is never committed: copy `config.example.js` to
  `gas/config.js` and `plugins/designhub/designhub.config.json` to
  `designhub.config.local.json`, then fill both from
  `docs/designhub/environment.local.md` (all three local files gitignored;
  the template stays outside `gas/` so clasp never pushes it).
