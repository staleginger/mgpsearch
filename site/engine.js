// Query engine. `get(path)` must resolve to parsed JSON (and reject if missing).
import { tokens, shardKey, fold } from './common.js';

/** Parse a query into terms (last plain term is a prefix) and quoted phrases. */
export function parseQuery(q) {
  const terms = [];
  const phrases = [];
  let lastPlain = null;
  for (const m of q.matchAll(/"([^"]*)"|(\S+)/g)) {
    const toks = tokens(m[1] ?? m[2]);
    if (!toks.length) continue;
    if (m[1] !== undefined) {
      if (toks.length > 1) phrases.push(toks);
      for (const t of toks) terms.push({ text: t, prefix: false });
    } else {
      for (const t of toks) {
        lastPlain = { text: t, prefix: false };
        terms.push(lastPlain);
      }
    }
  }
  // Only the last plain word is treated as a prefix (search-as-you-type), unless
  // the query ends with whitespace / a closing quote.
  if (lastPlain && !/[\s"]$/.test(q)) lastPlain.prefix = true;
  return { terms, phrases };
}

export function createEngine(get, meta) {
  const shards = new Map();
  const texts = new Map();

  const shard = (key) => {
    if (!shards.has(key)) shards.set(key, get(`idx/${key}.json`).catch(() => ({})));
    return shards.get(key);
  };
  const lines = (doc) => {
    if (!texts.has(doc)) texts.set(doc, get(`txt/${doc}.json`));
    return texts.get(doc);
  };

  /** term -> Map(doc -> Set(line numbers)) */
  async function lookup({ text, prefix }) {
    const sh = await shard(shardKey(text));
    const out = new Map();
    for (const term in sh) {
      if (term !== text && !(prefix && term.startsWith(text))) continue;
      const a = sh[term];
      for (let i = 0; i < a.length; ) {
        const doc = a[i];
        const n = a[i + 1];
        let set = out.get(doc);
        if (!set) out.set(doc, (set = new Set()));
        for (let j = 0; j < n; j++) set.add(a[i + 2 + j]);
        i += 2 + n;
      }
    }
    return out;
  }

  async function search(q) {
    const { terms, phrases } = parseQuery(q);
    if (!terms.length) return null;
    const maps = await Promise.all(terms.map(lookup));
    const results = [];
    for (const doc of maps[0].keys()) {
      if (!maps.every((m) => m.has(doc))) continue;
      const sets = maps.map((m) => m.get(doc));
      const all = [...sets[0]].filter((l) => sets.every((s) => s.has(l))).sort((a, b) => a - b);
      const any = [...new Set(sets.flatMap((s) => [...s]))].sort((a, b) => a - b);
      results.push({ doc, all, any });
    }
    let kept = results;
    if (phrases.length) {
      kept = [];
      for (const r of results) {
        if (!r.all.length) continue;
        const txt = await lines(r.doc);
        const ok = r.all.filter((l) => {
          const t = ' ' + tokens(txt[l - 1][1]).join(' ') + ' ';
          return phrases.every((p) => t.includes(' ' + p.join(' ') + ' '));
        });
        if (ok.length) kept.push({ ...r, all: ok, any: ok });
      }
    }
    for (const r of kept) {
      const n = meta.docs[r.doc].n;
      r.hits = (r.all.length ? r.all : r.any).length;
      r.score = (r.all.length * 3 + r.any.length) / (1 + Math.log10(n));
    }
    kept.sort((a, b) => b.score - a.score || a.doc - b.doc);
    return { terms: terms.map((t) => t.text), results: kept };
  }

  return { search, lines };
}
