# DesignHub POCs

De-risking spikes that must run **before the implementation plan** is written
(per [design.md](../design.md) §9). Each POC lives in its own folder; spike code
lands next to its README.

Start here: **[PREREQUISITES.md](./PREREQUISITES.md)** - one-time setup steps for
Igor, mapped to the POCs that need them.

| POC | What it proves | Kills / reshapes | Gate? | Prereqs | Est. |
|---|---|---|---|---|---|
| [poc1](./poc1/README.md) | **PASSED 2026-07-05.** HtmlService serves real HTML + widget + `google.script.run` round-trip + viewer identity - Approach C confirmed | D4 (Approach C), D13/D17 identity model | **yes** | P1, P2 | 0.5 day |
| [poc2](./poc2/README.md) | **PASSED 2026-07-05.** The publish skill's full Drive/Sheets REST surface (folders, upload, revisions, Sheets, index upsert, D18 access) | §5 data contracts, D9/D14 | **yes** | none | 0.5 day |
| [poc3](./poc3/README.md) | **PASSED 2026-07-05.** MD + mermaid rendered client-side in the sandbox, widget on top (2 findings: inline-bundle truncation, mermaid asset latency) | D10 | no (before MD work) | P1, P2, poc1 | 0.5 day |
| [poc4](./poc4/README.md) | **PASSED 2026-07-05.** A non-publisher agent (`home-knowledge@techsee.me`) writes to the comment Sheet via a standing grant (D18) | D13/D18 | no (before agent docs) | P3, P5 | 2 h |
| [poc5](./poc5/README.md) | **PASSED 2026-07-05.** Rollup mechanism settled -> D19: direct upsert + reconciler rebuild | §4 catalog rollup | no (before catalog work) | none | 1-2 h |

**ALL FIVE POCs PASSED (2026-07-05).** The de-risking spike design.md §9 called
for is complete: Approach C validated, all data contracts proven live, access
model (D18) and rollup mechanism (D19) settled by experiment. The
implementation plan is unblocked; each POC README carries findings the plan
must absorb.

**Browser tooling:** all scripted browser verification uses **dev-browser**
(persistent daemon, full Playwright API in scripts, profile per named browser) -
scripts are committed next to their POC README and graduate into E2E tests.
Playwright MCP was removed from this machine; `chrome_devtools` MCP remains for
ad-hoc interactive diagnosis only.

**Cleanup convention:** every Drive/Sheets artifact a POC creates goes under a
single `DesignHub-POC/` folder (never the production `DesignHub/` name), so the
whole spike surface can be deleted in one move.

**Status tracking:** each POC README has a `Status` line at the top
(`not started` / `in progress` / `passed` / `failed: <reason>`). Update it as we
go; results and measured numbers get appended to a `Results` section in the same
file.
