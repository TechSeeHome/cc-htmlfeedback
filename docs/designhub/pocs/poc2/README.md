# POC-2 - publish surface dry-run (Drive + Sheets REST)

**Status:** PASSED 2026-07-05 (see Results)
**Gate:** yes - turns design.md §5's data contracts into proven API calls; the
resulting script is the skeleton of `/publish-design`'s Google layer.
**Prereqs:** none - the OAuth path is already verified working (see
PREREQUISITES.md header). P5 (root location decision) is only needed before the
code graduates into the skill; the POC runs against a My Drive folder.
**Estimate:** half a day

## Goal

Execute, from a throwaway Node script, **exactly the sequence of Google calls
`/publish-design` will make**, and confirm each behaves as the design assumes:

| step | API call | proves |
|---|---|---|
| resolve/create `DesignHub-POC/<repo>/<feature>/` | `files.list` + `files.create` (folder mime) | folder navigation by name under a known root; D14 sanitized-feature folder naming |
| first publish | `files.create` multipart upload (HTML) | upload path, returned `driveFileId` |
| **re-publish** | `files.update` on the same `driveFileId` | link stability + Drive revisions accrue (`revisions.list` shows 2+) |
| companion Sheet | `spreadsheets.create` + move to folder | Sheet creation, `commentSheetId` capture |
| feature `_index` | `spreadsheets.create` once, then `values.get` + `append`/`update` | the upsert: find row by `driveFileId`, update if present, append if not |
| `meta` tab + publish history | `values.update` / `append` | the §5 meta contract |
| access model (D18) | **no `permissions.create` calls** - instead `permissions.list` on the published doc + a read probe as `home-knowledge@techsee.me` | D18's membership-based access + the D11 whole-domain read story on a Shared Drive |
| relative-asset scan | local scan of the HTML before upload | the v1 self-contained-only warning |

Also exercised implicitly: idempotent re-run of the whole script (second run
must update, not duplicate), and D14's collision check (publishing into an
existing folder whose `_index` records a different original feature must fail
loudly).

## Plan

1. Script at `poc2/publish-dry-run.mjs`: auth = refresh-token → access token
   (reusing the `gdoc-md-sync` client), thin `fetch` wrappers for Drive v3 and
   Sheets v4 - no SDK, so the calls stay visible.
2. Inputs: this repo's `docs/designhub/design.html` as the doc,
   `repo=cc-htmlfeedback`, `feature=design--designhub-platform` (exercises the
   D14 slash encoding).
3. Run twice; assert second run is an update everywhere (same file ID, same
   Sheet IDs, one `_index` row, one new publish-history row, one new revision).
4. Negative test: rerun with a conflicting original-feature string in `_index`
   → expect loud failure.
5. Record every request/response shape in Results - these become the skill's
   documented Google surface.

## Exit criteria

- [ ] Full sequence succeeds end to end with the existing credentials
- [ ] Re-publish keeps `driveFileId` (stable link) and adds a Drive revision
- [ ] `_index` upsert is idempotent (no duplicate rows on rerun)
- [ ] D14 feature-collision check fails loudly as designed
- [ ] Access model verified per D18: no grants made, `home-knowledge@` read
      probe on the published doc recorded (D11 story on a Shared Drive)
- [ ] All calls run with `supportsAllDrives=true` against the real Shared
      Drive root (P5)

## Results

**PASSED - 2026-07-05.** Script: [`publish-dry-run.mjs`](./publish-dry-run.mjs),
run as `igora@` against the real Shared Drive (HOME Drive `0AIDe9QcffDv_Uk9PVA`),
artifacts under `Home - R&D/DesignHub-POC/`. Every exit criterion met:

| check | result |
|---|---|
| Full sequence with existing creds | ✅ folder chain, `_index`, doc upload, companion Sheet, meta history, index row - one run, no manual steps |
| Re-publish keeps `driveFileId` + adds revision | ✅ run 2: all `created:false`, same IDs, revisions 1 → 2 |
| `_index` upsert idempotent | ✅ run 2 updated row 2 in place, UUID stable, no duplicate |
| D14 collision fails loudly | ✅ literal `design--designhub-platform` vs slashed original → exit 2, refused **before any write** |
| D18/D11 access | ✅ zero grants made; `home-knowledge@` (drive **Viewer**) read doc metadata + byte-exact content + tickets header via REST; its Sheet **write was denied (403)** - poc4's negative baseline confirmed live |
| Shared Drive params | ✅ every call ran with `supportsAllDrives=true` (list also needs `includeItemsFromAllDrives=true`) |

Artifact IDs: doc `1acs8dWa-irv4c86CFTw2Cyj916qOAti4` · companion
`1dT1HD7K8bLt0AofnG9n_PkU50MkdT1Jk8aYcK3x9F0c` · `_index`
`1Fa3bgIEk0ygba2UUF4U9UiLrQOI1wF-PEnn3L3QQTd4` · POC root (delete-all-in-one)
`1TgoFYQddjDZXc8O0eVH-W3Rx9NVO5a0V`.

**Learnings for the implementation plan:**

1. **The asset scan needs two severity classes.** `design.html` itself tripped
   the warning - but on `<a href>` *navigation* links (`./design.md`,
   `../how-it-works.md`), not on asset loads (`src`, stylesheets). Broken
   nav links degrade (404 on click); broken assets break rendering. The skill
   should warn differently and maybe only hard-confirm on asset loads.
2. **Creating Sheets directly in place** via Drive `files.create` with the
   spreadsheet mimeType (then Sheets `batchUpdate` for tabs/headers) avoids
   the create-in-My-Drive-then-move dance entirely - works fine on Shared
   Drives.
3. **HOME Drive membership snapshot** (from inherited permissions):
   Managers = revital.kats, renans, shir.weiss; `ts-home@techsee.me` group and
   `igora@` = Content manager; `home-knowledge@` = Viewer. For poc4's write
   grant, a Manager bumps `home-knowledge@` to Contributor - or poc4 tests a
   folder-level editor grant that `igora@` can place alone.
4. `permissions.list` on any published file surfaces the effective inherited
   access - a cheap way for the publish skill to *display* who will see a doc
   (D11 transparency) without managing any ACLs itself.
