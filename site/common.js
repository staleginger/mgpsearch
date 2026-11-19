// Shared by the build script (Node) and the browser. Keep dependency-free.

/** Lowercase and strip diacritics, so å/ä/ö match a/a/o (and vice versa). */
export const fold = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

/** Searchable tokens of a string (folded, min length 2). */
export function tokens(s) {
  return (fold(s).match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length >= 2);
}

/** Index shard file key: first two characters as hex code points. */
export function shardKey(term) {
  return [...term].slice(0, 2).map((c) => c.codePointAt(0).toString(16)).join('-');
}

export function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// Transcripts leak markup in three notations: escaped tags
// (&lt;i&gt;…&lt;/i&gt;), occasionally raw tags, and asterisk spans (*…*);
// plus entities (&amp;, &gt;, &lt;, &nbsp;). cleanInlineHtml normalizes a
// line to plain text plus a small whitelist of real tags (<em> for
// <i>/<em>/*…*, <strong> for <b>/<strong>); renderInline and highlight
// display it safely.

const ENTITIES = { amp: '&', lt: '<', gt: '>', nbsp: ' ', apos: "'", quot: '"' };

/**
 * One-pass decode of the HTML entities that occur in the transcripts.
 * Runs of spaces left by decoding (e.g. " " + &nbsp;) collapse to one.
 */
export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);|&#x([0-9a-fA-F]+);|&([a-zA-Z]+);/g, (m, dec, hex, name) => {
      if (dec !== undefined) return String.fromCodePoint(Number(dec));
      if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
      const c = ENTITIES[name.toLowerCase()];
      return c !== undefined ? c : m; // unknown entities stay as-is
    })
    .replace(/ {2,}/g, ' ');
}

// Formatting tags we keep: <i>/<em> → <em>, <b>/<strong> → <strong>.
const FMT = { i: 'em', em: 'em', b: 'strong', strong: 'strong' };

/**
 * Normalize leaked inline markup in a transcript line: decode entities,
 * convert known formatting tags and *…* asterisk spans to <em>/<strong>,
 * drop all other tags (keeping their text), drop orphan closers and close
 * unclosed tags. A * only counts as a span marker when it is not adjacent
 * to a letter or digit, so censored words (f*ttan, j*vla) and unpaired
 * asterisks are left as literal text.
 */
export function cleanInlineHtml(s) {
  const open = { em: 0, strong: 0 };
  s = decodeEntities(s).replace(/<\s*\/?\s*[a-zA-Z][^<>]*>/g, (tag) => {
    const inner = tag.slice(1, -1).trimStart();
    const close = inner.startsWith('/');
    const keep = FMT[(close ? inner.slice(1) : inner).split(/\s/)[0].toLowerCase()];
    if (!keep) return '';
    if (close) {
      if (!open[keep]) return '';
      open[keep]--;
    } else open[keep]++;
    return (close ? '</' : '<') + keep + '>';
  });
  // Asterisk spans: a * only counts as a span marker when it is NOT
  // adjacent to a letter or digit, so a censored word (letters on both
  // sides of the *) can never match.
  s = s.replace(/(^|[^\p{L}\p{N}])\*([^*]+)\*(?=[^\p{L}\p{N}]|$)/gu, (_, pre, inner) => pre + '<em>' + inner + '</em>');
  return s + '</em>'.repeat(open.em) + '</strong>'.repeat(open.strong);
}

/** Whitelisted inline tags (what cleanInlineHtml can produce). */
const INLINE_TAG = /<\/?(?:em|strong)>/g;

/** HTML-escape text, passing the whitelisted inline tags through. */
export function renderInline(s) {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(INLINE_TAG)) {
    out += esc(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}

/** HTML-escape text, wrapping words that start with any (folded) term in <mark>. */
export function highlight(text, terms) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(INLINE_TAG)) {
    out += markTerms(text.slice(last, m.index), terms) + m[0]; // whitelisted tag: pass through
    last = m.index + m[0].length;
  }
  return out + markTerms(text.slice(last), terms);
}

function markTerms(seg, terms) {
  let out = '';
  let last = 0;
  for (const m of seg.matchAll(/[\p{L}\p{N}]+/gu)) {
    const f = fold(m[0]);
    if (terms.some((t) => f.startsWith(t))) {
      out += esc(seg.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
      last = m.index + m[0].length;
    }
  }
  return out + esc(seg.slice(last));
}

export function fmtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}

/** Episode numbers display Swedish-style: 100.5 → "100,5". */
export const fmtEp = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));
