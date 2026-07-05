# Prerequisites - one-time setup (for Igor)

Step-by-step instructions for the things only you (or a Workspace admin) can do.
Work through them in order of need; after each one, tell Claude it's done and it
will verify and proceed.

**Already verified working - no action needed:**
Claude can already call the Drive API and Sheets API non-interactively as
`igora@techsee.me`, reusing the OAuth client + refresh token from the
`gdoc-md-sync` skill (`~/.claude/skills/gdoc-md-sync/`). Verified live on
2026-07-05: token refresh OK, Drive `about.get` OK, Sheets API enabled in GCP
project `techsee-175308` and accepts the `drive` scope. This covers **poc2 and
poc5 entirely** - they can run today.

| Prereq | Needed for | Who |
|---|---|---|
| P1 - Apps Script deploy (clasp) - **DONE 2026-07-05** | poc1, poc3 | you (5 min) |
| P2 - Google login in the dev-browser Chromium - **DONE 2026-07-05** | poc1, poc3 | you (2 min) |
| P3 - second Google identity = **`home-knowledge@techsee.me`** - **DONE 2026-07-05** | poc4 | you (1 min) |
| P4 - Google groups - **DEFERRED, not needed for v1** (superseded by Shared Drive membership - see D18) | - | - |
| P5 - **DECIDED 2026-07-05: Shared Drive.** Folder/Drive ID still needed | poc2 params, production | you |

---

## P1 - enable Apps Script deployment via clasp

> **Status: DONE - verified 2026-07-05.** clasp 3.3.0 installed, logged in as
> `igora@techsee.me`, Apps Script API confirmed enabled (canary script
> created, pushed, and trashed). Note: clasp v3 renamed the status command -
> it is `clasp show-authorized-user`, not v2's `clasp login --status`; the
> steps below are updated accordingly.

Claude deploys the spike web app with `clasp push` / `clasp deploy`, but the
login is an interactive browser flow only you can complete.

1. **Install clasp** (or just ask Claude to run this part):

   ```bash
   npm install -g @google/clasp
   ln -sf ~/.nvm/versions/node/v20.13.1/bin/clasp ~/.local/bin/clasp
   ```

   (The symlink is needed because nvm's global bin is not on PATH in Claude's
   shell - same pattern as your other global tools.)

2. **Enable the Apps Script API** for your account: open
   <https://script.google.com/home/usersettings> while logged in as
   `igora@techsee.me` and switch **Google Apps Script API** to **On**.
   If it was off, wait a few minutes before the first `clasp push`.

3. **Log in**:

   ```bash
   clasp login
   ```

   A browser opens; authorize with `igora@techsee.me`. Credentials are cached in
   `~/.clasprc.json` and Claude can use them non-interactively from then on.

4. **Verify** (or let Claude verify):

   ```bash
   clasp show-authorized-user
   ```

   Expected: `You are logged in as igora@techsee.me.`

**Done when:** step 4 shows you logged in. Tell Claude "P1 done".

---

## P2 - log into Google once in the dev-browser Chromium

> **Status: DONE - verified 2026-07-05.** The `designhub` named browser profile
> (`~/.dev-browser/browsers/designhub/chromium-profile`) holds a signed-in
> session for `igora@techsee.me` (verified on myaccount.google.com from a fresh
> page; screenshot checked). No "browser not secure" block was hit.

poc1/poc3 verification drives the deployed, login-gated web app through
**dev-browser** (persistent daemon-managed Chromium; scripts use the full
Playwright API). Profiles persist at
`~/.dev-browser/browsers/<name>/chromium-profile` and survive daemon restarts,
so one manual Google login is enough - but Google blocks fully automated
logins, so the typing must be yours.

1. Tell Claude **"open the browser for Google login"**. Claude runs a headed
   dev-browser script (named browser `designhub`) that opens
   <https://accounts.google.com> and leaves the window up.
2. In that window, log in as `igora@techsee.me` manually (password + 2FA as
   usual). Tell Claude when you see the signed-in state.
3. Claude verifies the session sticks (reopens a Google page in the same named
   browser and checks the account chip).

**If Google shows "This browser or app may not be secure":** tell Claude -
fallback is `dev-browser --connect` to your real Chrome (quit Chrome, relaunch
with `--remote-debugging-port=9222`, rides your existing session; note the
debug port lets local processes control that Chrome while it's open). Worst
case, poc1's browser checks become a 5-minute manual pass by you against a
checklist Claude prepares, with Claude verifying the data side (Sheet rows)
via API.

**Done when:** the `designhub` dev-browser profile holds a signed-in Google
session. Tell Claude "P2 done".

---

## P3 - a second Google identity (non-publisher): `home-knowledge@techsee.me`

> **Status: DONE - verified 2026-07-05.** Token minted with a refresh token
> (`drive` scope) at `pocs/poc4/.secrets/token-agent.json` (gitignored,
> verified); `about.get` confirmed `home-knowledge@techsee.me`. Note:
> `home@techsee.me` turned out to be a **group** (home team members), not a
> user - the group remains a candidate Shared Drive member for team-wide
> access later (the D18 groups-as-members upgrade path).

poc4 must prove an agent that is **not** the publisher can write to a comment
Sheet purely via the standing access grant (Shared Drive membership - D18).
Your own account can't prove that - as the Sheet's creator you have access
anyway. **Chosen identity: `home-knowledge@techsee.me`** (Igor's, already exists).

Minting its token on this machine:

1. Tell Claude "mint the agent token". Claude runs the OAuth consent flow
   (same client as `gdoc-md-sync`); a browser opens.
2. In the account chooser pick **`home-knowledge@techsee.me`** (not `igora@`) and
   approve. Claude saves the token to `pocs/poc4/.secrets/token-agent.json`
   (gitignored) and verifies `about.get` returns `home-knowledge@techsee.me`.

**Done when:** the token exists and verifies.

---

## P4 - Google groups - DEFERRED (superseded by D18)

Not needed for the POCs or v1. The groups in design D13
(`designhub-publishers@`, `designhub-agents@`) existed to give any identity a
one-time, join-once grant - but with the root on a **Shared Drive** (P5),
drive **membership** provides exactly that with no Workspace-admin work:
publishers = Content manager, each agent identity (e.g. `home-knowledge@techsee.me`) =
Contributor, added once. Publish-time `permissions.create` grants disappear.

Revisit groups only when agent/publisher identities multiply and churn enough
that admin-managed groups beat direct membership (production hardening, not
v1). Recorded as **D18** in `design.md`.

---

## P5 - DesignHub root location: **DONE - Shared Drive (verified 2026-07-05)**

> **Status: DONE.** Root received and verified via the Drive API:
>
> | thing | name | id |
> |---|---|---|
> | Shared Drive | HOME Drive | `0AIDe9QcffDv_Uk9PVA` |
> | parent folder | Home - R&D | `1H7S4iRkH_V9OmcLpSa6hLEefobbIBid2` |
> | **DesignHub root** | DesignHub | `1ggj9Z0zc1ZJnSwAfVqsYD95W5uh5aBqh` |
> | POC area (kept out of the real root) | DesignHub-POC | created by poc2 under Home - R&D |
>
> Verified: `igora@` has `canAddChildren` on the drive and the DesignHub folder
> (Content manager) - publishing works. Two follow-ups discovered:
>
> 1. `igora@` has `canManageMembers: false` - adding `home-knowledge@` as a
>    drive member (poc4's grant) needs a **HOME Drive Manager**; poc4 will
>    also test the fallback of a folder-level editor grant on DesignHub,
>    which `igora@` can do alone.
> 2. `home-knowledge@` already has **read-only** visibility of the DesignHub
>    folder without being a drive member (canDownload=true, canEdit=false) -
>    poc4's negative write test baseline is already in place, and the D11
>    read story is partially confirmed.
