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
const mdText = (md) => String(md)
  .replace(/^```[^\n]*$/gm, ' ')             // code-fence delimiter lines
  .replace(/`([^`]*)`/g, '$1')               // inline code
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')  // images -> alt text
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // links -> link text
  .replace(/^#{1,6}\s+/gm, '')               // heading markers
  .replace(/(\*\*|__)([^*_]+)\1/g, '$2')     // bold
  .replace(/(\*|_)([^*_]+)\1/g, '$2')        // emphasis
  .replace(/^\s*[-*+]\s+/gm, '')             // list bullets
  .replace(/^\s*>\s?/gm, '')                 // blockquote markers
  .replace(/\|/g, ' ');                      // table pipes

const textify = (source, isHtml) => norm(isHtml
  ? decodeEntities(String(source).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' '))
  : mdText(source));

// The widget clips context to 160 chars with a trailing ellipsis - strip it
// and require a reasonable core before using context as a disambiguator.
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
