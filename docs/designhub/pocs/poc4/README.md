# POC-4 - agent writes as a non-publisher via Shared Drive membership

**Status:** PASSED 2026-07-05 (see Results)
**Gate:** no - but must land before the agent-access documentation ("the Sheet
is the API") is finalized; it is design.md §9's explicit agent-path check,
updated for D18 (Shared Drive membership instead of the deferred D13 groups).
**Prereqs:** P3 (`home-knowledge@techsee.me` token), P5 (Shared Drive ID + `home@` as
Contributor); a companion Sheet from POC-2
**Estimate:** ~2 hours

## Goal

Prove the v1 write model end to end (D13 authorship + D18 access): an identity
that did **not** publish the doc and has no per-Sheet grant can read open
tickets and write a reply/status to the companion Sheet, authorized **only**
by its one-time membership on the DesignHub Shared Drive. `igora@` cannot
prove this - as the publisher it has access regardless. Test identity:
**`home-knowledge@techsee.me`**.

## Plan

1. Setup (as publisher, `igora@`): take a POC-2 companion Sheet on the Shared
   Drive and add one `open` ticket row. **No per-Sheet grant is made** - that
   is the point.
2. **Negative test first:** before `home-knowledge@techsee.me` is added to the Shared
   Drive (or with it temporarily removed), attempt a `values.get` and an
   `append` as `home@` → expect 403/404. This proves membership is what
   authorizes, not domain-wide sharing or a leftover ACL.
3. Add `home-knowledge@techsee.me` to the Shared Drive as **Contributor** (P5 step).
   Record how long the grant takes to propagate to API calls.
4. As `home@` (token from P3), run the documented agent recipe using only §5
   contracts:
   - `values.get` the `tickets` tab, filter `status=open`
   - `files.get?alt=media` the doc itself (read via the drive, D11/D18)
   - `values.append` a `reply` row (`parentId` set, `source=agent`,
     `authorEmail` = `home-knowledge@techsee.me`)
   - `values.update` the parent ticket's `status` to `in-progress`
5. Verify as publisher: rows present, attribution correct.

## Exit criteria

- [ ] Without membership: Sheet reads and writes are denied
- [ ] With Contributor membership: reply + status update succeed with **zero
      per-Sheet or per-publish grants**
- [ ] Rows carry the agent's own identity (`authorEmail` = `home-knowledge@techsee.me`)
- [ ] Doc bytes readable via Drive REST with the same token
      (`supportsAllDrives=true`)
- [ ] Propagation delay recorded (informs the publish skill docs)
- Fail → fall back toward D13's explicit grants: per-identity
      `permissions.create` at publish time, or resurrect the groups - decide
      in the implementation plan with this data

## Results

**PASSED - 2026-07-05.** Script: [`agent-path.py`](./agent-path.py), run as
`home-knowledge@techsee.me` with only §5 contracts (Sheets values + Drive
files REST), token from P3.

| check | result |
|---|---|
| Negative (Viewer, pre-grant) | ✅ ticket reads and doc metadata OK (drive Viewer), `values:append` denied **HTTP 403** |
| Standing grant | Igor set `home-knowledge@` as **Contributor** on DesignHub/DesignHub-POC (Drive UI). No per-Sheet grants anywhere |
| Positive: agent recipe | ✅ read open tickets → `values:append` a threaded `reply` (`parentId` set) → `values:update` parent to `in-progress`. First attempt, ~1 s per write |
| Attribution | ✅ row carries `authorEmail=home-knowledge@techsee.me`, `source=agent`; publisher-side verification confirms threading and the status flip |
| Propagation delay | grant was already effective at first attempt (< the ~1 min between grant and test) |

Note on `source`: agent rows carry client-written `source=agent` because with
"the Sheet is the API" the writer IS trusted at the ACL level - D17's
server-side stamping applies to the *bridge* (untrusted browser context), not
to direct Sheets REST writers, whose identity is enforced by Drive ACLs and
visible in the row.
