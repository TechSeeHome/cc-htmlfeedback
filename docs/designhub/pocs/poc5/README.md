# POC-5 - settle the rollup "poke" mechanism

**Status:** PASSED 2026-07-05 - candidate A adopted as D19 (see Results)
**Gate:** no - but it closes a real design gap and must be settled before the
catalog part of the plan; the outcome becomes a decision row in design.md.
**Prereqs:** none (POC-2's `_index` shards make convenient fixtures)
**Estimate:** 1-2 hours

## The gap

design.md §4 says the `_portal-index` rollup is rebuilt "on publish + a
periodic Apps Script trigger", and the publish skill "pokes the rollup
refresh" - but the poke mechanism is undefined. Calling a domain-gated Apps
Script web app from a CLI OAuth token is genuinely fiddly (web-app `/exec`
auth from outside a browser is its own project). Meanwhile the skill already
holds Sheets credentials and the exact row it just wrote.

## Candidates

- **A (recommended): skill upserts the rollup row directly** via Sheets API,
  same transaction as the shard write. The periodic GAS trigger remains as a
  reconciler that fully rebuilds from shards (the rollup stays a disposable
  cache - a wrong/missed direct write is corrected on the next rebuild).
  No skill→web-app call exists at all.
- **B: skill calls a GAS endpoint to trigger a rebuild.** Only worth testing
  if A fails; requires solving CLI→web-app auth (or an anonymous-but-tokened
  endpoint, which D11 forbids in spirit).
- **C: periodic trigger only.** Zero publish-time work, but the tree is stale
  until the next tick - measure whether the minimum trigger interval makes
  this tolerable as a fallback.

## Plan

1. Test A: extend POC-2's script - after the shard upsert, upsert the same row
   into a `_portal-index` Sheet (find by `driveFileId`, update or append).
   Confirm idempotency across reruns and that concurrent publishes to
   *different* features don't clobber each other (two parallel runs).
2. Prototype the reconciler as plain JS (per D5 / §6 testing discipline:
   `node --test` with the Sheets boundary mocked): read all `_index` shards
   under the root, rebuild the rollup, verify it converges after a simulated
   missed direct write (delete a rollup row, run reconciler, row returns).
3. Only if A hits a wall: evaluate B and C, recording the auth cost of B and
   the staleness window of C.

## Exit criteria

- [ ] Direct rollup upsert works, is idempotent, and survives two concurrent
      publishes to different features
- [ ] Reconciler rebuild converges from shards alone (rollup provably remains
      a disposable cache)
- [ ] Decision written up and added to design.md as a new D-row (mechanism +
      reconciler interval)

## Results

**PASSED - 2026-07-05. Candidate A adopted (recorded as D19 in design.md).**
Code: [`rollup-lib.mjs`](./rollup-lib.mjs) (pure logic),
[`rollup-lib.test.mjs`](./rollup-lib.test.mjs) (**8/8 under `node --test`**),
[`run-live.mjs`](./run-live.mjs) (live driver, real Shared Drive).

| check | result |
|---|---|
| Direct upsert (candidate A) | ✅ publish-time upsert into `_portal-index` keyed by `driveFileId`; new keys use the atomic `values:append` |
| Idempotency | ✅ same row upserted twice -> updated in place, no duplicate |
| Concurrency | ✅ two parallel upserts (distinct keys) both landed - `:append` is server-side atomic; no clobber |
| Reconciler (pure JS, D5 discipline) | ✅ `buildRollup(shards)` unit-tested without any Google API: union, newest-updatedAt dedup, ghost-row healing, deterministic sort |
| Convergence after corruption | ✅ live: cleared the rollup entirely -> `rebuild` restored the shard-backed row (content healed to shard truth) and dropped synthetic non-shard rows - **the rollup is a pure derived cache** |

**Adopted mechanism (D19):** the publish skill upserts the rollup row directly
via Sheets REST in the same flow as the shard write (it already holds the creds
and the row - no skill→web-app call exists at all); a periodic Apps Script
trigger runs the reconciler as a full rebuild from shards, healing missed
writes, same-key race duplicates, and any corruption. Candidates B (skill calls
a GAS endpoint) and C (trigger only) were not needed: A hit no wall.

**Residual race, accepted:** two concurrent publishes of the *same brand-new
doc* could double-append; the reconciler dedups it at the next tick, and the
publish flow itself is single-doc-single-publisher in practice.
