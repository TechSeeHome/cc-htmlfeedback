# DesignHub agent access - the Sheet is the API

No custom API (design D5): agents use Drive/Sheets REST with their own Google
identity. Verified end-to-end in `docs/designhub/pocs/poc4/`.

## Access (one-time, D18)

Your identity needs membership on the DesignHub Shared Drive (or its folder):
**Viewer** = read everything; **Contributor** = also write comment rows.
Agents get Contributor - it cannot move or delete anything.

## Reading a doc's review state

1. Catalog: read the `_portal-index` Sheet in the DesignHub root - one row per
   doc: `id, type, title, repo, feature, jira, tags, owner, driveFileId,
   commentSheetId, url, status, publishedAt, updatedAt`.
2. Comments: `GET https://sheets.googleapis.com/v4/spreadsheets/{commentSheetId}/values/tickets!A2:P`
   with columns `id, parentId, type, status, quote, context, section, note,
   authorEmail, authorName, source, docVersion, result, files, createdAt, updatedAt`.
   Top-level tickets have empty `parentId`; replies set it.
3. Doc bytes (exact): `GET https://www.googleapis.com/drive/v3/files/{driveFileId}?alt=media&supportsAllDrives=true`
4. Visual context: render the fetched doc locally (dev-browser) and locate each
   ticket's quote/context/section anchor triple on the rendered page.

## Writing (as yourself - your row carries YOUR authorEmail)

- Reply: append a row to `tickets!A:P` with a fresh uuid, `parentId` = the
  ticket you answer, `type=reply`, `source=agent`, your email, ISO timestamps.
- Status: update the ticket row's `status` cell to one of
  `open | in-progress | resolved | declined` (+ bump `updatedAt`); put your
  reasoning/outcome in `result` and touched files in `files`.
- Use `values:append` for new rows (atomic) and row-addressed
  `values:update` for edits; every Drive call takes `supportsAllDrives=true`.

Reference implementation: `docs/designhub/pocs/poc4/agent-path.py`.
