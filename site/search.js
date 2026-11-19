import { highlight, fmtTime, fmtEp, esc, fold } from './common.js';
import { createEngine } from './engine.js';
import { graphSvg } from './graph.js';

const V = document.documentElement.dataset.v;
const get = (path) =>
  fetch(`${path}?v=${V}`).then((r) => {
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  });

const $ = (id) => document.getElementById(id);
const input = $('q');
const PAGE = 20;
let meta, engine, current = null, shown = 0, seq = 0;

const href = (doc, terms, line) =>
  `p/${encodeURIComponent(meta.docs[doc].slug)}.html?q=${encodeURIComponent(terms.join(' '))}#l${line}`;

function snippet(text, terms) {
  if (text.length <= 260) return highlight(text, terms);
  // Locate the earliest match using the same folding as the engine, so a query
  // like "valkomna" still finds "Välkomna". Fall back to the start of the line.
  const f = fold(text);
  const found = terms.map((t) => f.indexOf(t)).filter((i) => i >= 0);
  const at = found.length ? Math.min(...found) : 0;
  let start = Math.max(0, at - 100);
  let end = Math.min(text.length, start + 260);
  // Never cut a tag at the window edges (it would render as broken markup).
  for (const m of text.matchAll(/<\/?(?:em|strong)>/g)) {
    if (m.index < start && start < m.index + m[0].length) start = m.index;
    if (m.index < end && end < m.index + m[0].length) end = m.index + m[0].length;
  }
  return (start ? '…' : '') + highlight(text.slice(start, end), terms) + (end < text.length ? '…' : '');
}

async function renderMore() {
  const batch = current.results.slice(shown, shown + PAGE);
  shown += batch.length;
  const my = seq;
  const html = await Promise.all(
    batch.map(async (r) => {
      const txt = await engine.lines(r.doc);
      const ls = (r.all.length ? r.all : r.any).slice(0, 3);
      const items = ls
        .map((l) => {
          const [t, text] = txt[l - 1];
          return `<li><a href="${href(r.doc, current.terms, l)}"><span class="ts">${fmtTime(t)}</span> ${snippet(text, current.terms)}</a></li>`;
        })
        .join('');
      const d = meta.docs[r.doc];
      const ep = d.e != null ? `<span class="ep">${fmtEp(d.e)}</span> ` : '';
      return `<li class="result"><h2><a href="${href(r.doc, current.terms, ls[0])}">${ep}${esc(d.t)}</a> <small>${r.hits} träffar</small></h2><ul>${items}</ul></li>`;
    }),
  );
  if (my !== seq) return;
  $('results').insertAdjacentHTML('beforeend', html.join(''));
  $('more').hidden = shown >= current.results.length;
}

// Bar chart above the results: one bar per episode with hits, positioned by
// episode number (zero-hit episodes are simply gaps). Docs without an episode
// number (non-episode pages) are skipped; two docs sharing a number would sum
// their hits.
function renderGraph(res) {
  const byEp = new Map();
  for (const r of res.results) {
    const d = meta.docs[r.doc];
    if (d.e == null) continue;
    const p = byEp.get(d.e);
    if (p) p.y += r.hits;
    else byEp.set(d.e, { x: d.e, y: r.hits, href: `p/${encodeURIComponent(d.slug)}.html`, label: `${fmtEp(d.e)} ${d.t}` });
  }
  const pts = [...byEp.values()].sort((a, b) => a.x - b.x);
  $('graph').innerHTML = graphSvg(pts);
  $('graph').hidden = !pts.length;
}

function hideGraph() {
  $('graph').innerHTML = '';
  $('graph').hidden = true;
}

const episodeOrder = (a, b) => {
  const ae = a.e ?? Infinity;
  const be = b.e ?? Infinity;
  if (ae !== be) return ae - be;
  return a.t.localeCompare(b.t, 'sv');
};

function listAll() {
  hideGraph();
  $('status').textContent = `${meta.docs.length} avsnitt`;
  $('results').innerHTML = [...meta.docs]
    .sort(episodeOrder)
    .map((d) => {
      const ep = d.e != null ? `<span class="ep">${fmtEp(d.e)}</span> ` : '';
      return `<li class="result"><h2><a href="p/${encodeURIComponent(d.slug)}.html">${ep}${esc(d.t)}</a> <small>${fmtTime(d.d)}</small></h2></li>`;
    })
    .join('');
  $('more').hidden = true;
}

async function run(q) {
  const my = ++seq;
  if (!q.trim()) {
    current = null;
    return listAll();
  }
  $('status').textContent = 'Söker…';
  let res;
  try {
    res = await engine.search(q);
  } catch (e) {
    $('status').textContent = 'Något gick fel: ' + e.message;
    return;
  }
  if (my !== seq) return;
  $('results').innerHTML = '';
  if (!res) return listAll();
  current = res;
  shown = 0;
  const lines = res.results.reduce((a, r) => a + r.hits, 0);
  $('status').textContent = res.results.length
    ? `${res.results.length} avsnitt, ${lines} rader`
    : 'Inga träffar.';
  renderGraph(res);
  await renderMore();
}

let timer;
input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const q = input.value;
    history.replaceState(null, '', q.trim() ? `?q=${encodeURIComponent(q)}` : location.pathname);
    run(q);
  }, 150);
});
$('form').addEventListener('submit', (e) => e.preventDefault());
$('more').addEventListener('click', renderMore);

(async () => {
  meta = await get('meta.json');
  engine = createEngine(get, meta);
  input.value = new URLSearchParams(location.search).get('q') || '';
  run(input.value);
})();
