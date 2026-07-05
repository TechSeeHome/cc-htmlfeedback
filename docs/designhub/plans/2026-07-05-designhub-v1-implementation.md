# DesignHub v1 Implementation Plan

Split into per-phase files (reviewability + per-task subagent execution) - start
at [designhub-v1/00-overview.md](designhub-v1/00-overview.md):

- [00-overview.md](designhub-v1/00-overview.md) - goal, constraints, fixed config, file map, backlog, verification checklist
- [10-core-libs.md](designhub-v1/10-core-libs.md) - Tasks 1-5: scaffold, schema, paths, rollup, render
- [20-gas-and-widget.md](designhub-v1/20-gas-and-widget.md) - Tasks 6-8: GAS entries, widget transform, deploy
- [30-publish-skill.md](designhub-v1/30-publish-skill.md) - Tasks 9-11: D15 anchors, publish flow, skill + agent docs
- [40-ship.md](designhub-v1/40-ship.md) - Tasks 12-14: marketplace + CI, E2E + dogfood, wrap-up + PR

History note: this file WAS the single-file plan through commit c57b128 (review
rounds 1-2, scores 72 -> 93); the split is content-preserving.
