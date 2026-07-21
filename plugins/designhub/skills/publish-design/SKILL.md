---
name: publish-design
description: >
  Publish an HTML or Markdown design doc from this repo to DesignHub - the
  company's Google-login-gated design hub with in-page commenting. Use when the
  user runs /publish-design, asks to "publish this design doc", "share this
  dashboard with PMs", or wants company-wide (non-GitHub) review of a design
  file. Uploads to the DesignHub Shared Drive, creates/updates the catalog row
  and companion comment Sheet, runs the re-anchor pass, and returns the link.
---

# /publish-design

TOOLING = ${CLAUDE_PLUGIN_ROOT}/skills/publish-design/scripts

## Flow (D9: infer, then the USER approves - never publish silently)

1. **Resolve the file.** The doc the user wants published (ask if ambiguous).
   Path-in-repo = its path relative to the repo root.
2. **Infer metadata** and SHOW it for approval before publishing:
   - repo: `git remote get-url origin` -> last path segment without `.git`
   - feature: current branch (`git branch --show-current`)
   - jira: first `ABC-123`-shaped token in the branch name, else `unassigned`
   Present the resolved values in one short block and ask the user to confirm
   or correct. Anything unknown stays the literal string `unassigned`. **Stop
   and wait for the user's reply here - do not run step 3 in the same turn.**
   Showing the inferred values is not the same as the user approving them;
   only an explicit go-ahead counts, even if the values look obviously right.
3. **Publish (only after the user approved step 2):**

   ```bash
   TOOLING="${CLAUDE_PLUGIN_ROOT}/skills/publish-design/scripts"
   node "$TOOLING/publish.mjs" --file <path> --repo <repo> --feature <branch> \
     --jira <key-or-unassigned> --path-in-repo <repo-relative-path>
   ```

   - First run on a machine may print an OAuth URL - have the user authorize
     (they publish as THEMSELVES, D13).
   - `BLOCK relative ASSET refs`: the page would render broken (v1 serves a
     single file). Show the list to the user; only re-run with
     `--allow-assets` if they explicitly accept broken assets.
   - `WARN relative nav links`: tell the user those links will 404 on the hub;
     publishing proceeds.
4. **Report:** give the user the printed `Published:` URL (viewable by anyone
   in the domain with a Google login) and the comments Sheet link. If the
   output shows `D15:` lines, summarize which old comments auto-closed
   (strike -> resolved) or went `anchor-lost`.

## Notes

- One-time credential setup: if publish.mjs exits with "No Google OAuth client
  secret found", place your installed-app `client_secret.json` at
  `~/.claude/designhub/client_secret.json` (or set `DH_CLIENT_SECRET_FILE`).
  Full instructions - including how to create the client - are in
  `${CLAUDE_PLUGIN_ROOT}/CREDENTIALS-SETUP.md` (bundled with this plugin).
- One-time machine setup: if publish.mjs exits complaining that
  `designhub.config.local.json` is missing, copy the plugin's
  `designhub.config.json` to `designhub.config.local.json` (same directory) and
  fill the real `rootFolderId`/`execUrl` - the committed file is a placeholder
  template, the real org values are never committed.
- Re-publishing the same file updates it in place: same link, Drive revision
  history, catalog row updated - never duplicated.
- A feature-folder collision error (exit 4) means the sanitized branch name
  clashes with a different feature (D14) - pick an explicit `--feature`.
- The web app, catalog, and Sheet schemas are documented in
  `docs/designhub/design.md`; agents consume comments per
  `docs/designhub/agent-access.md`.
