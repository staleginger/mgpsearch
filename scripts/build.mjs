// Builds dist/: static transcript pages, a sharded inverted index and the search UI.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, cpSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { tokens, shardKey, esc, fmtTime, fmtEp, cleanInlineHtml, renderInline } from '../site/common.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'output');
const OUT = join(root, 'dist');
const MAX_DIST_BYTES = 500 * 1024 * 1024;
const SKIP = new Set(['index.md']); // placeholder file

const TS = /^\[(?:(\d+):)?(\d+):(\d\d)(?:[.,]\d+)?\]\s*/;

export function parseTranscript(src) {
  const lines = [];
  let t = 0;
  for (const raw of src.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const m = raw.match(TS);
    let text = raw;
    if (m) {
      t = Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      text = raw.slice(m[0].length);
    }
    lines.push([t, cleanInlineHtml(text.trim())]); // normalize leaked HTML (see common.js)
  }
  return lines;
}

export const titleOf = (slug) => slug.replace(/_/g, ' ');

// Slug as a string (fractional episodes have exactly ONE digit
// after the comma, e.g. "100,5"): `100_5_…` is "100,5", `100_15_…` and
// `100_…` are "100". Fallback for files without `slug:` front matter.
export const slugOf = (stem) => {
  const [a, b] = stem.split('_');
  return b && /^\d$/.test(b) ? `${a},${b}` : a;
};

// Episode number (a number, or null) for the results graph: the `episode:`
// front matter first (accepts "100", "100,5", "100.5"), else the number
// parsed from the slug derived from the file name. Non-episode pages have
// no episode number and never appear on the graph.
export function episodeOf(attrs, stem) {
  for (const s of [attrs.episode, slugOf(stem)]) {
    const n = Number(String(s).trim().replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// YAML-ish front matter at the top of a file:
//   ---
//   title: Some episode
//   ---
// Only `key: value` lines are read; anything else is ignored for now (see todo.md).
const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontMatter(src) {
  const m = src.match(FM);
  if (!m) return { attrs: {}, body: src };
  const attrs = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(\S.*?)\s*$/);
    if (kv) attrs[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return { attrs, body: src.slice(m[0].length) };
}

function pageHtml(doc, lines) {
  const body = lines
    .map(([t, text], i) => {
      const n = i + 1;
      return `<p id="l${n}"><a class="ts" href="#l${n}">${fmtTime(t)}</a> <span class="tx">${renderInline(text)}</span></p>`;
    })
    .join('\n');
  const title = esc(doc.t);
  const ep = doc.e != null ? `<span class="ep">${fmtEp(doc.e)}</span> ` : '';
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<link rel="stylesheet" href="../style.css">
</head>
<body class="page">
<header><a id="back" href="../index.html">&larr; Sök</a> <a class="raw" href="../raw/${esc(doc.s)}.md">råtext</a></header>
<main>
<h1>${ep}${title}</h1>
<p class="meta">${lines.length} rader &middot; ${fmtTime(doc.d)}</p>
<article id="transcript">
${body}
</article>
</main>
<script type="module" src="../page.js"></script>
</body>
</html>
`;
}

function main() {
  rmSync(OUT, { recursive: true, force: true });
  for (const d of ['p', 'raw', 'idx', 'txt']) mkdirSync(join(OUT, d), { recursive: true });

  const files = readdirSync(SRC).filter((f) => f.endsWith('.md') && !SKIP.has(f)).sort();
  if (!files.length) throw new Error('No transcripts found in output/');

  const docs = [];
  const postings = new Map(); // term -> Map(doc -> lines[])
  const txtHash = createHash('sha1'); // txt/ files feed snippets; must bust the cache when they change

  files.forEach((f, id) => {
    const slug = f.slice(0, -3);
    const src = readFileSync(join(SRC, f), 'utf8');
    const { attrs, body } = parseFrontMatter(src);
    const lines = parseTranscript(body); // front matter is not transcript text
    const doc = { s: slug, slug: attrs.slug || slugOf(slug), e: episodeOf(attrs, slug), t: attrs.title || titleOf(slug), n: lines.length, d: lines.length ? lines[lines.length - 1][0] : 0 };
    docs.push(doc);

    writeFileSync(join(OUT, 'p', `${doc.slug}.html`), pageHtml(doc, lines));
    writeFileSync(join(OUT, 'raw', f), src);
    const txtJson = JSON.stringify(lines);
    writeFileSync(join(OUT, 'txt', `${id}.json`), txtJson);
    txtHash.update(slug).update(txtJson);

    lines.forEach(([, text], i) => {
      for (const term of new Set(tokens(text))) {
        let m = postings.get(term);
        if (!m) postings.set(term, (m = new Map()));
        let a = m.get(id);
        if (!a) m.set(id, (a = []));
        a.push(i + 1);
      }
    });
  });

  // Shard postings by the first two characters of the term.
  // Format per term: flat [doc, count, line, line, ..., doc, count, ...]
  const shards = new Map();
  for (const [term, m] of postings) {
    const key = shardKey(term);
    let sh = shards.get(key);
    if (!sh) shards.set(key, (sh = {}));
    const flat = [];
    for (const [id, ls] of [...m].sort((a, b) => a[0] - b[0])) flat.push(id, ls.length, ...ls);
    sh[term] = flat;
  }

  const hash = createHash('sha1');
  let biggest = { key: '', gz: 0 };
  for (const key of [...shards.keys()].sort()) {
    const json = JSON.stringify(shards.get(key));
    hash.update(key).update(json);
    writeFileSync(join(OUT, 'idx', `${key}.json`), json);
    const gz = gzipSync(json).length;
    if (gz > biggest.gz) biggest = { key, gz };
  }
  const version = hash.update(JSON.stringify(docs)).update(txtHash.digest()).digest('hex').slice(0, 10);
  writeFileSync(join(OUT, 'meta.json'), JSON.stringify({ version, builtAt: new Date().toISOString(), docs }));

  // Static assets. __VERSION__ cache-busts all JSON fetched by the client.
  cpSync(join(root, 'site'), OUT, { recursive: true });
  const idx = join(OUT, 'index.html');
  writeFileSync(idx, readFileSync(idx, 'utf8').replaceAll('__VERSION__', version));
  writeFileSync(join(OUT, '.nojekyll'), '');
  writeFileSync(join(OUT, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  // The old meta-refresh to "./" looped forever for deep paths. Instead, climb
  // the directory tree until index.html is found, with a manual link as fallback.
  writeFileSync(join(OUT, '404.html'), `<!doctype html>
<html lang="sv"><head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<title>Inte funnen</title>
</head><body>
<p><a href="../index.html">Tillbaka till söksidan</a></p>
<script>
(async () => {
  let d = location.pathname;
  for (let i = 0; i < 5 && (d = d.replace(/\\/[^/]*\\/?$/, '/')); i++) {
    if (await fetch(d + 'index.html', { method: 'HEAD' }).then((r) => r.ok).catch(() => false)) {
      location.replace(d);
      return;
    }
  }
})();
</script>
</body></html>`);

  // Sanity checks and report.
  let total = 0;
  const walk = (d) => readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = join(d, e.name);
    e.isDirectory() ? walk(p) : (total += statSync(p).size);
  });
  walk(OUT);
  if (total > MAX_DIST_BYTES) throw new Error(`dist is too big: ${total} bytes`);
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  console.log(`docs: ${docs.length}  terms: ${postings.size}  shards: ${shards.size}`);
  console.log(`dist: ${mb(total)}  largest shard (gz): ${biggest.key} ${(biggest.gz / 1024).toFixed(0)} KB`);
  console.log(`version: ${version}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
