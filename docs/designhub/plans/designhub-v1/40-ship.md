# DesignHub v1 Implementation Plan - part 4 of 4: CI, E2E, dogfood, PR

> Tasks 12-14. Read [00-overview.md](00-overview.md) FIRST - it holds the goal,
> the non-negotiable constraints (D16, dual-use modules, HtmlService gotchas,
> Shared Drive REST discipline, hyphens-only), the fixed configuration
> placeholders, the file map, and the final verification checklist. Task
> numbering is global across the four part files. Steps use checkbox
> (`- [ ]`) syntax for tracking.

---

### Task 12: Marketplace entry (the sole upstream-file edit) + CI

**Files:**
- Modify: `.claude-plugin/marketplace.json` (add ONE entry - D16's single sanctioned upstream touch)
- Create: `.github/workflows/designhub.yml`

- [ ] **Step 1: Add the designhub plugin to `.claude-plugin/marketplace.json`.** Read the file first; append to its `plugins` array, matching the existing entry's shape exactly (same key order and style as the `cc-htmlfeedback` entry):

```json
    {
      "name": "designhub",
      "source": "./plugins/designhub",
      "description": "Publish design docs to DesignHub - Google-login-gated review hub with in-page comments stored in Sheets.",
      "version": "0.1.0"
    }
```

(If the real file's entries carry different/extra keys, mirror those instead - the existing entry is the template. Keep the diff to this one addition.)

- [ ] **Step 2: Create `.github/workflows/designhub.yml`** (D16: fork-side CI on every merge - upstream tests must keep passing next to ours):

```yaml
name: designhub
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - name: upstream build is clean (never edited)
        run: node build.js --check
      - name: upstream tests
        run: npm test
      - name: designhub widget transform is fresh + anchors hold
        run: node designhub/build-designhub.js --check
      - name: designhub tests
        run: node --test designhub/test/
```

- [ ] **Step 3: Verify locally the exact commands CI runs:**

```bash
node build.js --check && npm test && node designhub/build-designhub.js --check && node --test designhub/test/
```

Expected: all four green. (`npm test` and `build.js --check` prove the D16 promise: our additions did not disturb upstream.) `npm test` runs `node --test --test-force-exit`, a flag added in Node 20.14 - CI's `setup-node@v4` with `node-version: 20` resolves to a current 20.x and is fine, but if this fails locally with `bad option: --test-force-exit`, the dev machine's pinned node is older; `nvm install 20 && nvm use 20` (or bump the symlink per the user's global CLAUDE.md npm-globals note) before continuing. Do NOT edit upstream's `package.json` to work around it (D16).

**Trap this exact command sequence can't catch:** a dev machine already has `node_modules/` installed from earlier work, so `npm test` passing locally does NOT prove CI (a fresh checkout) has its dependencies (e.g. `jsdom`, a devDependency `test/widget.test.js` needs) - that's exactly what caused this workflow to ship without an `npm ci` step in an earlier pass. To genuinely reproduce what CI sees, verify from a clean export: `git archive HEAD | (mkdir -p /tmp/ci-check && tar -x -C /tmp/ci-check) && cd /tmp/ci-check && npm ci && node build.js --check && npm test && node designhub/build-designhub.js --check && node --test designhub/test/; cd -`.

- [ ] **Step 4: Commit:** `git add .claude-plugin/marketplace.json .github/ && git commit -m "designhub: marketplace entry + fork-side CI (D16)"`

---

### Task 13: E2E script + dogfood publish (the real thing, end to end)

**Files:**
- Create: `designhub/e2e/serve-and-comment.mjs` (dev-browser script - run manually, not in CI)

- [ ] **Step 1: Create `designhub/e2e/serve-and-comment.mjs`.** This is a dev-browser stdin script (poc1/poc3 pattern). IMPORTANT: dev-browser scripts run in a QuickJS sandbox with NO `process`/env access - parameters are baked in by `sed` at run time:

```bash
# Run:
sed -e 's|__DH_EXEC__|https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec|' \
    -e 's|__DH_DOC__|cc-htmlfeedback/design--designhub-platform/docs/designhub/design.html|' \
    designhub/e2e/serve-and-comment.mjs | dev-browser --browser designhub --timeout 180
```

```js
// Verifies: page serves, widget boots, identity chip shows an org-domain user,
// a programmatic selection submits through the bridge (fix-now path), and the
// board reflects it.
const EXEC = "__DH_EXEC__", DOC = "__DH_DOC__";
const page = await browser.getPage("dh-e2e");
await page.goto(`${EXEC}?doc=${DOC}`, { waitUntil: "domcontentloaded", timeout: 90000 });
let frame = null;
for (let i = 0; i < 45 && !frame; i++) {
  await page.waitForTimeout(1000);
  for (const f of page.frames()) {
    if (await f.evaluate(() => !!document.getElementById("fb-launch")).catch(() => false)) { frame = f; break; }
  }
}
if (!frame) throw new Error("widget never appeared");
// The chip (#dh-identity, set by widgetTags in render.js) lands asynchronously:
// widgetTags polls for the panel + google.script.run, then a bridge round trip -
// poll for it instead of reading immediately. (Do NOT use a positional selector
// like ".fb-head div:last-child": it matches the Clean/dock button row.)
let identity = "";
for (let i = 0; i < 20 && !identity; i++) {
  await page.waitForTimeout(1000);
  identity = await frame.evaluate(() =>
    (document.getElementById("dh-identity") || {}).textContent || "");
}
console.log("identity chip:", identity);
const selected = await frame.evaluate(() => {
  const p = [...document.querySelectorAll("p,td,li")].find(el => el.innerText.trim().length > 60);
  const r = document.createRange(); r.selectNodeContents(p);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  // The widget opens its popover ONLY on a real mouseup on the content (a
  // programmatic Selection alone never triggers it) - synthesize one that bubbles.
  p.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  return p.innerText.trim().slice(0, 40);
});
console.log("selected:", JSON.stringify(selected));
await page.waitForTimeout(800);
// Meta/Ctrl+click on the popover Comment button is the connected-mode
// "fix now" fast path - it calls submitDraft() and therefore the BRIDGE
// immediately (a plain click only creates a local draft).
await frame.click("#fb-comment", { modifiers: ["Meta"] });
// bridge round-trip is async - give it time, then count board cards
await page.waitForTimeout(6000);
console.log("board cards:", await frame.evaluate(() =>
  document.querySelectorAll("#fb-panel li, #fb-panel .fb-card, #fb-panel .fb-item").length));
console.log("screenshot:", await saveScreenshot(await page.screenshot(), "dh-e2e.png"));
```

(The exact popover/panel selectors come from `feedback-widget.html` markup - if `fb-comment`/`fb-list` drifted, read the markup block of the widget source and fix the selectors; do not guess.)

- [ ] **Step 2: Dogfood - publish the real design docs to the PRODUCTION root:**

```bash
node plugins/designhub/skills/publish-design/scripts/publish.mjs \
  --file docs/designhub/design.html --repo cc-htmlfeedback \
  --feature design/designhub-platform --path-in-repo docs/designhub/design.html --allow-assets
node plugins/designhub/skills/publish-design/scripts/publish.mjs \
  --file docs/designhub/design.md --repo cc-htmlfeedback \
  --feature design/designhub-platform --path-in-repo docs/designhub/design.md
```

Expected: two `Published:` URLs under the production exec URL.

- [ ] **Step 3: Run the E2E against both published docs** - run the Step 1 `sed | dev-browser` command twice: first exactly as shown (the html doc), then with the `__DH_DOC__` substitution changed to `cc-htmlfeedback/design--designhub-platform/docs/designhub/design.md`. Expected: identity chip shows `signed in as <DH_PUBLISHER_ACCOUNT>`, a card appears after submit, screenshot looks right (check it - the human eye is part of this step). Verify the rows landed:  read the companion Sheet's `tickets` tab via REST and confirm the new row's `authorEmail`.

- [ ] **Step 4: Check the tree page** (exec URL with no params) in dev-browser: both docs listed under `cc-htmlfeedback / design/designhub-platform`.

- [ ] **Step 5: Commit:** `git add designhub/e2e/ && git commit -m "designhub: E2E serve-and-comment script + dogfood publish verified"`

---

### Task 14: Wrap up - README, design doc status, PR

**Files:**
- Create: `designhub/README.md`
- Modify: `docs/designhub/design.md` (status line only)

- [ ] **Step 1: Create `designhub/README.md`:**

```markdown
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
  `docs/designhub/plans/environment.local.md` (all three local files gitignored;
  the template stays outside `gas/` so clasp never pushes it).
```

- [ ] **Step 2: Update the design doc status line** - in `docs/designhub/design.md`, change the `> **Status: draft v0.1 ...**` line to:

```markdown
> **Status: v1 implemented · spike-validated (see pocs/) · 2026-07-05 draft accepted**
```

- [ ] **Step 3: Full verification sweep** (the same four commands as CI) and manual checklist:

```bash
node build.js --check && npm test && node designhub/build-designhub.js --check && node --test designhub/test/
```

Then confirm against `docs/designhub/design.md` §7 "V1 (must-have)": publish skill ✓, self-contained scan ✓, login-gated viewing (html + md + widget) ✓, tree UI ✓, comments with identity/threading/statuses ✓, agent access docs ✓.

- [ ] **Step 4: Commit remaining files, push, open the PR (fork only - PRs never target upstream without the repo owner's explicit approval):**

```bash
git add -A && git commit -m "designhub: v1 - README + design doc status"
git push
gh pr create --repo <DH_FORK_REPO> --base main \
  --title "DesignHub v1: publish skill + GAS serving layer + agent access" \
  --body "Implements docs/designhub/design.md (D1-D19) per docs/designhub/plans/designhub-v1/ (00-overview.md + parts 1-4). All mechanisms POC-validated (docs/designhub/pocs/, dev-machine-local). Upstream files untouched except the marketplace.json entry (D16)."
```

---

