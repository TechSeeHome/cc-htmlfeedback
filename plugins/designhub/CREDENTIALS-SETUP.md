# DesignHub credentials setup

DesignHub publishing authenticates to Google as **you** using an installed-app
OAuth client. (The Knowledge Portal importer will use this same client and
setup once its later change lands.) You provide two things once per machine;
neither is ever committed to a repo.

## 1. The client secret (shared, low-sensitivity)

An installed-app OAuth **client** JSON identifies the app to Google. It is not a
per-user secret; Google does not treat installed-app client secrets as
confidential. We still keep it out of git.

Resolution order used by the tooling:

1. `DH_CLIENT_SECRET_FILE` environment variable, if set (wins over everything).
2. `~/.claude/designhub/client_secret.json` (**the canonical location**).
3. `~/.claude/skills/gdoc-md-sync/client_secret.json` (**deprecated** legacy
   path; still read so older machines keep working, prints a one-time warning).

### Get the file

- **Preferred:** obtain the team's shared `client_secret.json` from the team
  secrets manager / shared password vault (see the vault entry your team lead
  maintains). Do not paste its contents into chat, tickets, or a repo.
- **Or create your own:** Google Cloud Console -> APIs & Services ->
  Credentials -> Create credentials -> OAuth client ID -> **Desktop app** ->
  Download JSON.

### Place it

```bash
mkdir -p ~/.claude/designhub
cp /path/to/downloaded/client_secret.json ~/.claude/designhub/client_secret.json
chmod 600 ~/.claude/designhub/client_secret.json
```

## 2. The token (per-developer, sensitive)

On first publish/import the tooling opens a browser for you to authorize, then
caches a **refresh token** at `~/.claude/designhub/token.json`. This file grants
access as you - treat it as a real secret:

```bash
chmod 600 ~/.claude/designhub/token.json
```

The token is cached at a shared path, so once the Knowledge Portal importer
adopts this setup a single consent will cover both.

## Troubleshooting

- **"No Google OAuth client secret found"** - no client secret resolved:
  either you have not placed `client_secret.json` at the canonical path (and
  `DH_CLIENT_SECRET_FILE` is unset), or your `DH_CLIENT_SECRET_FILE` override
  points to a missing file. The error message names the exact path it expected
  - check that path. Follow section 1.
- **"Using the DEPRECATED client secret ..."** - you are on the legacy
  `gdoc-md-sync` path; move the file to `~/.claude/designhub/` to silence it.
