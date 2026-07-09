# DesignHub environment values - example (committed)

The DesignHub design doc and implementation plan reference org-specific values through
`<DH_*>` placeholders. The real values live in `environment.local.md` in this directory,
which is gitignored (`docs/designhub/**/*.local.md`) and never committed.

Setup: copy this file to `environment.local.md` and fill in your org's values.

| placeholder | what it is | example |
|---|---|---|
| `<DH_ROOT_FOLDER_ID>` | Drive folder ID of the production DesignHub root (inside your org's Shared Drive) | `1AbCdEfGhIjKlMnOpQrStUvWxYz012345` |
| `<DH_POC_FOLDER_ID>` | Drive folder ID of the disposable POC/dev fixtures folder | `1ZyXwVuTsRqPoNmLkJiHgFeDcBa543210` |
| `<DH_MARKED_BUNDLE_ID>` | Drive file ID of the marked 15 minified bundle | `1Aa...` |
| `<DH_MERMAID_BUNDLE_ID>` | Drive file ID of the mermaid 11 minified bundle | `1Bb...` |
| `<DH_POC_DEPLOYMENT_ID>` | Apps Script deployment ID of the POC web app (reference only) | `AKfycb...` |
| `<DH_SCRIPT_ID>` | Apps Script script ID of the production web app (created in plan Task 8) | `1A2b...` |
| `<DH_DEPLOYMENT_ID>` | Apps Script deployment ID of the production web app (its exec URL suffix) | `AKfycb...` |
| `<DH_PUBLISHER_ACCOUNT>` | Google account that publishes docs (clasp login, OAuth consent) | `you@your-org.example` |
| `<DH_AGENT_ACCOUNT>` | Non-publisher agent identity granted Shared Drive membership (D18) | `agent@your-org.example` |
| `<DH_FORK_REPO>` | GitHub `owner/repo` slug of the fork that PRs target | `your-org/cc-htmlfeedback` |
| `<DH_ORG_NAME>` | Display name for `plugins/designhub/.claude-plugin/plugin.json`'s `author.name` (cosmetic - not read programmatically) | `Your Org` |
