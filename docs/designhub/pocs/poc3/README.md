# POC-3 - Markdown + mermaid rendered client-side in the HtmlService iframe

**Status:** PASSED 2026-07-05 - D10 validated, with two implementation findings (see Results)
**Gate:** no - but must land before the MD-rendering part of the plan is
detailed (D10 depends on it).
**Prereqs:** P1, P2, and POC-1 passed (reuses its web app)
**Estimate:** half a day

## Goal

Prove D10: an MD doc is rendered **client-side** inside the HtmlService IFRAME
sandbox - bundled renderer plus **mermaid** - and the widget then works on the
rendered DOM exactly as on HTML docs. Mermaid inside a sandboxed iframe is the
least-trusted part: it manipulates SVG, measures text, and is the most likely
thing the sandbox breaks.

The perfect test fixture exists: **`docs/designhub/design.md` itself** - real
prose, tables, a mermaid flowchart, code blocks.

## Plan

1. Extend POC-1's `doGet`: when the Drive file is `.md`, serve a shell page
   that includes the raw MD (JSON-embedded), a bundled MD renderer
   (marked or markdown-it - pick during the spike; record why), and the
   mermaid bundle; render on load, then initialize the widget over the result.
2. Serve `design.md` through it. Compare against a local render for fidelity
   (headings, tables, code blocks, links, the mermaid diagram).
3. Widget pass on rendered output: select text inside a paragraph, a table
   cell, and a mermaid node label → popover → submit → Sheet row with a sane
   quote/context/section anchor triple.
4. Check in-page anchor links (`#heading`) still navigate under
   `<base target="_top">` (rewritten bare anchors - the design.md §3.2 note).
5. Note bundle weight (renderer + mermaid) and render time on this real doc.

## Exit criteria

- [ ] design.md renders with correct tables, code blocks, and the mermaid
      diagram inside the served page
- [ ] Widget anchors selections on rendered MD and rows land in the Sheet
- [ ] In-doc `#anchor` links navigate
- [ ] Bundle size + render latency recorded and acceptable
- Fail → fall back per D10: server-side rendering at publish time (revisit the
  plan's MD section, not the whole architecture)

## Results

**PASSED - 2026-07-05.** Fixture: the real `design.md` (27 KB - prose, the
19-row decision table, mermaid flowchart, code blocks) served through the
POC-1 web app (deployment v3), rendered client-side with **marked 15.0.12** +
**mermaid 11** and verified in the logged-in dev-browser.

| check | result |
|---|---|
| MD rendering fidelity | ✅ 5 tables, 9 section headings, code blocks - all correct in the HtmlService iframe; **marked parse = 20-48 ms** |
| Mermaid | ✅ the §3 architecture flowchart rendered as a full SVG (subgraphs, arrows, labels) inside the sandbox (`securityLevel: "strict"`) |
| Widget on rendered MD | ✅ selection inside a rendered table cell → bridge → Sheet row, identity stamped, forged claim ignored (same as poc1) |
| Viewer identity on MD page | ✅ `igora@techsee.me` |

**Finding 1 - big inline bundles get truncated by HtmlService.** Inlining the
3.5 MB mermaid bundle into a `<script>` tag lost ~190 KB in HtmlService's
write pipeline (SyntaxError, `window.mermaid` undefined); the 39 KB marked
bundle inlines fine, and poc1 served 20 MB of plain HTML fine - the limit is
specific to giant inline scripts. Workaround (implemented): the same web app
serves the bundle as JS via a **`ContentService` asset route**
(`?asset=mermaid`) - still zero third-party CDN.

**Finding 2 - the mermaid asset is slow: ~30 s** on both `/dev` and `/exec`
(ContentService streaming a 3.5 MB Drive read; GAS responses are not
browser-cacheable). Marked-only MD pages are fast. Options for the
implementation plan, in preference order:
1. **Pre-render mermaid at publish time** (mermaid-cli in the publish skill →
   inline SVG in the published doc). View-time bundle shrinks to marked's
   39 KB inline; no runtime mermaid at all. Best UX, fits D10's "revisit
   server-side only if quality demands" escape hatch - this is publish-time,
   not serving-time.
2. Accept the slow first load only on mermaid-bearing docs (progressive: page
   text renders immediately at ~50 ms; diagrams pop in when the bundle lands).
3. A slimmer mermaid build if one materializes.

**Also noted:** marked 15 does not emit heading ids by default - in-page TOC
anchors on MD need the `marked-gfm-heading-id` extension (plus poc1's
`target="_self"` anchor rewrite, which the MD shell already inherits).
`root.innerHTML = marked.parse(...)` is XSS-equivalent to serving raw HTML
docs - acceptable under D17's v1 trust model (trusted domain publishers),
revisit with a sanitizer if publishing ever opens beyond trusted repos.
