// D15 re-anchor pass, pure. Matching runs on normalized RENDERED-equivalent
// TEXT (html: tags stripped + entities decoded; md: inline markdown syntax
// stripped; whitespace collapsed) because the widget's quote/context come
// from rendered text, not source bytes - raw-source matching would false-lose
// any quote spanning **bold**, `code`, a [link](url), or an HTML entity like
// &amp; (a strike whose quote only LOOKS gone due to entity mismatch would
// otherwise wrongly auto-resolve as fixed - the exact outcome D15 exists to
// prevent).
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// A code point is only valid to hand to String.fromCodePoint if it's an
// integer in the Unicode range [0, 0x10FFFF] - anything else (e.g. a
// malformed `&#x110000;` beyond the max code point) makes fromCodePoint
// throw RangeError. reanchorPass runs unconditionally on every publish,
// AFTER Drive/Sheets mutations already happened, so one bad entity anywhere
// in the doc must never abort the pass - leave the original entity text
// untouched (rather than throwing) when it's not a valid reference (D15 §1).
const isValidCodePoint = (n) => Number.isInteger(n) && n >= 0 && n <= 0x10FFFF;
const codePointOrOriginal = (match, cp) => {
  if (!isValidCodePoint(cp)) return match;
  try { return String.fromCodePoint(cp); } catch { return match; }
};

const decodeEntities = (s) => String(s)
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&(?:#0*39|apos);/g, "'")
  .replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (m, n) => codePointOrOriginal(m, Number(n)))
  .replace(/&#x([0-9a-fA-F]+);/g, (m, n) => codePointOrOriginal(m, parseInt(n, 16)));

// Strip literal HTML tags. Used on the HTML path, and (D15 §4) on the
// Markdown path too: `marked` (the renderer the published page actually
// uses) renders raw inline HTML in a .md doc (e.g. "The <b>quick</b> fox")
// as its text content ("The quick fox") - if the md branch left tags in
// place, a quote spanning them would false-lose, or a strike whose struck
// text is still literally present (just re-tagged) could false-resolve.
// Replace with a space (not '') so "quick</b>brown" doesn't fuse into one
// word if the source has no whitespace around the tag.
const stripHtmlTags = (s) => String(s).replace(/<[^>]*>/g, ' ');

// Approximate md-to-text: conservative in the right direction - leftovers only
// ADD characters to the haystack; the needle (quote/context) is rendered text.
// Placeholder for an ESCAPED pipe (\|), so the blanket table-pipe strip below
// doesn't erase a literal '|' a doc means to display (e.g. a "string | number"
// type union in a spec table) - restored to '|' as the final step.
const PIPE_PLACEHOLDER = String.fromCharCode(0);
const mdText = (md) => {
  let text = String(md)
    .replace(/^```[^\n]*$/gm, ' ')             // code-fence delimiter lines
    .replace(/`([^`]*)`/g, '$1')               // inline code
    .replace(/\\\|/g, PIPE_PLACEHOLDER)        // escaped pipe -> placeholder, restored below
    // Lazy [\s\S]*? (not [^\]]*): a link/image whose text itself contains a
    // "]" (e.g. "[quick [brown] fox](url)") must still match end-to-end -
    // a match that fails outright leaves the raw "[...](url)" (URL and all)
    // sitting in the haystack, breaking any quote that spans past it.
    .replace(/!\[([\s\S]*?)\]\([^)]*\)/g, '$1') // images -> alt text
    .replace(/\[([\s\S]*?)\]\([^)]*\)/g, '$1')  // links -> link text
    .replace(/^#{1,6}\s+/gm, '')                // heading markers
    .replace(/^\s*[-*+]\s+/gm, '')              // list bullets
    .replace(/^\s*>\s?/gm, '')                  // blockquote markers
    .replace(/\|/g, ' ');                       // remaining (unescaped/table) pipes
  // Bold/emphasis run to a FIXED POINT: nested markers (e.g. "**bold _italic_
  // text**") don't fully strip in one pass - the bold regex can't match
  // through the inner "_..._" content, so a single pass leaves literal "**"
  // characters injected mid-haystack, breaking any quote spanning them.
  let prev;
  do {
    prev = text;
    text = text
      .replace(/(\*\*|__)([^*_]+)\1/g, '$2')    // bold
      .replace(/(\*|_)([^*_]+)\1/g, '$2');       // emphasis
  } while (text !== prev);
  return text.replace(new RegExp(PIPE_PLACEHOLDER, 'g'), '|');
};

// Strip <head>...</head> (title/meta/etc.) before the body-tag strip below.
// Without this, a quote/context/section that was removed from the visible
// BODY but still lingers in <title> (or elsewhere in <head>) would still
// "be found" by a haystack search, even though nothing selectable on the
// rendered page contains it anymore (D15 §3).
const stripHead = (s) => String(s).replace(/<head[\s\S]*?<\/head>/gi, ' ');

const textify = (source, isHtml) => norm(decodeEntities(isHtml
  ? stripHead(String(source)).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ')
  : stripHtmlTags(mdText(source))));

// The widget clips context to 160 chars with a trailing ellipsis - strip it
// and require a reasonable core before using context as a disambiguator.
// 12 chars is a deliberately lenient floor, not a tuned constant: the widget
// stops context capture at the enclosing TD/TH, so a comparison-table cell
// ("Yes", "N/A") legitimately produces a very short context - below the floor
// this falls back to quote+section only rather than treating "too short to
// be meaningful" as a mismatch.
const contextCore = (context) => norm(String(context || '').replace(/…\s*$/, ''));

// ---- D15 §2: section-boundary detection, for occurrence correlation ----
// Headings become ordinary body text once tags/markers are stripped (see
// textify) - there's no marker left in `text` to say "this offset is under
// heading X". So we extract heading TITLES from docSource in document order
// (independently, using the same normalization textify applies to body
// text), then locate each title's position in the FINAL haystack via a
// forward-only search. Stripping never reorders content, so heading titles
// must appear in the haystack in the same relative order they appear in the
// source - a plain sequential indexOf walk is enough to recover positions
// without re-implementing an HTML/Markdown parser.
function extractHeadingTitles(docSource, isHtml) {
  const titles = [];
  if (isHtml) {
    const stripped = stripHead(String(docSource))
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ');
    const re = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
    let m;
    while ((m = re.exec(stripped))) {
      const title = norm(decodeEntities(m[1].replace(/<[^>]*>/g, ' ')));
      if (title) titles.push(title);
    }
  } else {
    const re = /^#{1,6}\s+(.+)$/gm;
    let m;
    while ((m = re.exec(String(docSource)))) {
      const title = norm(decodeEntities(stripHtmlTags(mdText(m[1]))));
      if (title) titles.push(title);
    }
  }
  return titles;
}

// Returns [{ start, title }, ...] sorted ascending by `start` (guaranteed by
// construction: each search starts after the previous match). A title that
// can't be located in `text` is skipped (best-effort, not fatal) rather than
// desyncing every heading after it.
function buildSections(docSource, isHtml, text) {
  const sections = [];
  let cursor = 0;
  for (const title of extractHeadingTitles(docSource, isHtml)) {
    const idx = text.indexOf(title, cursor);
    if (idx === -1) continue;
    sections.push({ start: idx, title });
    cursor = idx + title.length;
  }
  return sections;
}

// The section a given offset falls under: the title of the last heading
// whose start is <= offset, or '' if offset precedes every heading (or
// there are no headings at all).
function sectionAt(offset, sections) {
  let title = '';
  for (const s of sections) {
    if (s.start > offset) break;
    title = s.title;
  }
  return title;
}

function findAllIndices(haystack, needle) {
  const out = [];
  if (!needle) return out;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    out.push(idx);
    idx = haystack.indexOf(needle, idx + 1);
  }
  return out;
}

// A quote occurrence [qStart, qStart+quoteLen) "correlates" with a context
// occurrence [cStart, cStart+ctxLen) when the quote sits inside (or very
// close to) that context window - i.e. this is the SAME occurrence the
// context was captured around, not just some other spot in the doc where
// both strings happen to independently exist. A small tolerance absorbs
// whitespace-collapse drift between quote/context normalized separately.
const CORRELATION_TOLERANCE = 20;
const correlates = (qStart, qEnd, cStart, cEnd) =>
  qStart >= cStart - CORRELATION_TOLERANCE && qEnd <= cEnd + CORRELATION_TOLERANCE;

export function reanchorPass(tickets, docSource, isHtml) {
  const text = textify(docSource, isHtml);
  const sections = buildSections(docSource, isHtml, text);
  const changes = [];
  for (const t of tickets) {
    if (t.type === 'reply') continue;
    if (t.status !== 'open' && t.status !== 'in-progress') continue;
    const quote = norm(t.quote);
    if (!quote) continue;
    const quoteOccs = findAllIndices(text, quote);
    if (!quoteOccs.length) {
      changes.push(t.type === 'strike'
        ? { id: t.id, status: 'resolved', result: 'auto-verified on re-publish: struck text is gone (D15)' }
        : { id: t.id, status: 'anchor-lost', result: 'quote not found after re-publish (D15)' });
      continue;
    }

    // D15 §2: correlate quote occurrences with context occurrences
    // positionally - "does context exist somewhere in the doc" isn't enough;
    // it must bracket THIS quote occurrence, or a quote that recurs
    // verbatim elsewhere could wrongly borrow an unrelated occurrence's
    // still-present context.
    const ctx = contextCore(t.context);
    const ctxTracked = ctx.length >= 12;
    const ctxOccs = ctxTracked ? findAllIndices(text, ctx) : [];
    const withContext = quoteOccs.filter((qStart) => {
      if (!ctxTracked) return true;
      const qEnd = qStart + quote.length;
      return ctxOccs.some((cStart) => correlates(qStart, qEnd, cStart, cStart + ctx.length));
    });
    if (ctxTracked && !withContext.length) {
      changes.push({ id: t.id, status: 'anchor-lost',
        result: 'quote exists but its context moved - treated as lost (D15 full-triple rule)' });
      continue;
    }

    // Third leg of the triple: of the context-correlated occurrences, at
    // least one must sit under the recorded section heading. Correlated
    // (not "does the section heading text exist anywhere in the doc"): if
    // the original section was removed while the same sentence survived
    // verbatim under a DIFFERENT heading, that's still a lost anchor - the
    // specific occurrence the comment was about is gone even though the
    // words aren't. Degrade gracefully when section boundaries aren't
    // trackable for this doc (no headings found at all): fall back to the
    // quote+context-only correlation above rather than guessing.
    const sec = norm(t.section);
    if (sec && sections.length) {
      const matched = withContext.some((qStart) => sectionAt(qStart, sections) === sec);
      if (!matched) {
        changes.push({ id: t.id, status: 'anchor-lost',
          result: 'quote and context found but not under its recorded section - treated as lost (D15 full-triple rule)' });
      }
    }
  }
  return changes;
}
