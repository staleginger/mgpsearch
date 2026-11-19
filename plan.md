# How mgpsearch works

A static full-text search over the podcast transcripts in `output/`, built by
`scripts/build.mjs` and deployed to GitHub Pages. Follows Pagefind's core idea:
pre-build a sharded inverted index at build time; the browser fetches only the
shards a query needs. No dependencies beyond Node ≥ 24.

## Data

- `output/*.md` – transcripts, one `[HH:MM:SS] text` line each (minutes-only
  `[MM:SS]` also accepted, fractional seconds ignored). Lines without a
  timestamp inherit the previous line's timestamp. `output/index.md` is skipped.
  Lines leak HTML (escaped `<i>` tags as `&lt;i&gt;…&lt;/i&gt;`, entities like
  `&amp;`/`&gt;`/`&nbsp;`, occasionally raw tags); `parseTranscript`
  normalizes it via `cleanInlineHtml` (see Tokenization).
- File names are `<episode>_<title-slug>.md` with a **truncated** title slug
  (about 20 characters) and possibly fractional episode numbers with exactly
  one digit after the comma (`116_5_…` is "116,5", `116_ha_…` is "116",
  `109_15_…` is "109"). Titles used to be derived from the stem, which
  made them ugly (e.g. `364 med ljudets hast`); every file now carries a
  `title:` front matter, so the title no longer contains the episode
  number — the number is shown as a badge (`.ep`) before the title, taken
  from `e`. File order is plain lexicographic, so the browse list and doc
  IDs are not in numeric episode order (accepted).
- Each transcript has `slug:` front matter with the episode number as a
  **string** (commas, not dots: `"100,5"`). This is the page ID: pages live at
  `p/<slug>.html`. The build derives the slug from the file name as fallback
  if the front matter is missing. The slug and the episode *number* are kept
  distinct: `episodeOf` in `build.mjs` takes the `episode:` front matter
  (accepting `100`, `100,5`, `100.5`) first, else the numeric first `_`-field
  of the file name, else `null`. A future non-episode page (no number in the
  name, no `episode:` key) gets `e: null` and is excluded from the results
  graph, which plots hits against the episode number.

## Build (`scripts/build.mjs` → `dist/`)

1. `p/<slug>.html` – one static page per transcript, named by the episode slug
   (e.g. `p/100,5.html`). Each line is
   `<p id="l<N>"><a class="ts" href="#l<N>">[00:01:23]</a> <span class="tx">…</span></p>`
   where the text is HTML-escaped except for the whitelisted `<em>`/`<strong>`
   markup (see `renderInline`); deep links work without JavaScript.
2. `raw/<file name>.md` – copy of the source under its original file name
   (linked as "råtext" from each page).
3. `txt/<docId>.json` – per-episode line texts `[[seconds, text], …]`, fetched
   lazily by the client only for visible results.
4. `idx/<key>.json` – inverted index, sharded by the first two characters of
   the term (hex code points joined with `-`, e.g. `76-65.json` for `ve…`).
   Per term: `[docId, lineCount, line, line, …, …]`, doc IDs sorted ascending.
   No delta encoding at this size; GitHub Pages' gzip does the rest.
5. `meta.json` – `{version, builtAt, docs: [{s: stem, slug, e: episodeNumber (number|null), t: title, n: lines, d: duration}]}`.
   `version` is a SHA-1 over the shard keys + shard contents + docs + the
   `txt/` contents. It is substituted into `index.html` as `data-v`
   (`__VERSION__`), and every client fetch appends `?v=<version>` so a rebuild
   busts all cached JSON.
6. `site/*` is copied in; `robots.txt` (disallow all – the site is deliberately
   not indexed by search engines, including the pages' `noindex` meta),
   `404.html` and an empty `.nojekyll` are generated.
7. Sanity: fail if `dist/` exceeds 500 MB, and print doc/term/shard counts,
   total size and the largest shard (gzipped).

## Tokenization (`site/common.js`, shared by build and browser)

Lowercase → NFD → strip diacritics (so `å/ä/ö` fold to `a/a/o` and queries
from English keyboards still match) → split on `[^\p{L}\p{N}]+` → drop tokens
shorter than 2 characters. No stemming; prefix matching at query time covers
Swedish word endings.

### Leaked HTML

`cleanInlineHtml` (run by `parseTranscript` on every line) decodes the
entities that leak from the transcripts (`&amp;`, `&gt;`, `&lt;`, `&nbsp;`,
numeric), converts the markup to a canonical whitelist — escaped or raw
`<i>`/`<em>` → `<em>`, `<b>`/`<strong>` → `<strong>`, and `*…*` asterisk
spans → `<em>` — drops all other tags (keeping their text), drops orphan
closers and closes unclosed ones. A `*` only counts as a span marker when
it is not adjacent to a letter or digit, so censored words (`f*ttan`) and
unpaired `*` are left as literal text. The
normalized text (with `<em>`/`<strong>` in it) is what goes into `txt/` and
the pages; `raw/` stays verbatim. The client only ever emits the whitelisted
tags: `renderInline` escapes everything else, and `highlight`/snippet
rendering pass the tags through unchanged.

## Client

- `index.html` + `search.js` – search UI. Query state lives in `?q=`. Input is
  debounced 150 ms. An empty query lists all episodes.
- `engine.js` – `parseQuery` treats every word as AND-ed; only the **last**
  plain (unquoted) word is a prefix, and only if the query doesn't end in
  whitespace or a quote. Quoted phrases of 2+ words are verified by checking
  the candidate lines' token text. Each term's shard is fetched (and cached);
  a lookup collects `doc → Set(lines)` for the exact term plus, for prefixes,
  all terms starting with it.
- Ranking: `(3 × lines with all terms + lines with any term) / (1 + log10 doc
  lines)`, so line-level co-occurrence dominates.
- Snippets: up to 3 lines per result from `txt/<id>.json`, windowed around the
  earliest (folded) match, `<mark>`-highlighted, each linking to
  `p/<slug>.html?q=…#l<N>`.
- Bar chart above the results (`graph.js`): one bar per episode with hits,
  X positioned proportionally to the **episode number** (so zero-hit
  episodes show as gaps), Y = hits. Pure dependency-free function
  returning inline SVG; bars are labeled with the episode number and are
  links to the episode page with a "number title" tooltip. Rendered from
  `res.results` + `meta.docs` — no extra fetches; hidden for empty queries
  and queries with no numbered results.
- `page.js` – on transcript pages, highlights `?q=` terms by splitting text
  nodes only (so `<em>`/`<strong>` markup survives) and re-centers the
  `#l<N>` target.

## CI/CD (`.github/workflows/pages.yml`)

Runs on push to `main` touching `output/`, `site/`, `scripts/`, `tests/` or
the workflow itself, plus `workflow_dispatch`. `npm test` performs the full
build (integration tests run against a fresh `dist/`), then the Pages
deploy job publishes `dist/`. A `[skip pages]` commit message skips the build
job. `concurrency: {group: pages, cancel-in-progress: true}` drops superseded
runs. One-time repo setting: **Settings → Pages → Source: GitHub Actions**.

## Adding episodes

Drop `.md` files in `output/` and push to `main`; the next run rebuilds
everything. Incremental builds are not worth it at this size (~370 docs,
~15 MB index).

## Known limitations / open items

- Titles come from truncated slugs (see "Data").
- No wildcard/regex search – see `todo.md` for the plan.
- `dist/raw/` duplicates `output/` (~17 MB of ~70 MB dist) – see `todo.md`.
