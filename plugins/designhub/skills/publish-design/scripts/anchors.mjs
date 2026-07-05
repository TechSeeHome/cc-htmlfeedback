// D15 re-anchor pass, pure. Matching runs on normalized RENDERED-equivalent
// TEXT (html: tags stripped + entities decoded; md: inline markdown syntax
// stripped; whitespace collapsed) because the widget's quote/context come
// from rendered text, not source bytes - raw-source matching would false-lose
// any quote spanning **bold**, `code`, a [link](url), or an HTML entity like
// &amp; (a strike whose quote only LOOKS gone due to entity mismatch would
// otherwise wrongly auto-resolve as fixed - the exact outcome D15 exists to
// prevent).
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const decodeEntities = (s) => String(s)
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&(?:#0*39|apos);/g, "'")
  .replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));

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

const textify = (source, isHtml) => norm(decodeEntities(isHtml
  ? String(source).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ')
  : mdText(source)));

// The widget clips context to 160 chars with a trailing ellipsis - strip it
// and require a reasonable core before using context as a disambiguator.
// 12 chars is a deliberately lenient floor, not a tuned constant: the widget
// stops context capture at the enclosing TD/TH, so a comparison-table cell
// ("Yes", "N/A") legitimately produces a very short context - below the floor
// this falls back to quote+section only rather than treating "too short to
// be meaningful" as a mismatch.
const contextCore = (context) => norm(String(context || '').replace(/…\s*$/, ''));

export function reanchorPass(tickets, docSource, isHtml) {
  const text = textify(docSource, isHtml);
  const changes = [];
  for (const t of tickets) {
    if (t.type === 'reply') continue;
    if (t.status !== 'open' && t.status !== 'in-progress') continue;
    const quote = norm(t.quote);
    if (!quote) continue;
    const quoteFound = text.includes(quote);
    if (!quoteFound) {
      changes.push(t.type === 'strike'
        ? { id: t.id, status: 'resolved', result: 'auto-verified on re-publish: struck text is gone (D15)' }
        : { id: t.id, status: 'anchor-lost', result: 'quote not found after re-publish (D15)' });
      continue;
    }
    const ctx = contextCore(t.context);
    if (ctx.length >= 12 && !text.includes(ctx)) {
      changes.push({ id: t.id, status: 'anchor-lost',
        result: 'quote exists but its context moved - treated as lost (D15 full-triple rule)' });
      continue;
    }
    // Third leg of the triple: the section heading must still exist somewhere
    // in the doc (headings are body text once tags/markers are stripped).
    const sec = norm(t.section);
    if (sec && !text.includes(sec)) {
      changes.push({ id: t.id, status: 'anchor-lost',
        result: 'quote exists but its section heading is gone (D15 full-triple rule)' });
    }
  }
  return changes;
}
