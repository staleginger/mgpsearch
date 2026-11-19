// Integration test: runs the engine against a fresh build of output/.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../site/engine.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
let meta, engine;

before(() => {
  execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: 'pipe' });
  meta = JSON.parse(readFileSync(join(dist, 'meta.json')));
  engine = createEngine(async (p) => JSON.parse(readFileSync(join(dist, p))), meta);
});

test('every transcript has a page and the count matches', () => {
  const md = readdirSync(join(root, 'output')).filter((f) => f.endsWith('.md') && f !== 'index.md');
  assert.equal(meta.docs.length, md.length);
  for (const d of meta.docs) readFileSync(join(dist, 'p', d.slug + '.html'));
});

test('meta carries a numeric episode number for every doc', () => {
  for (const d of meta.docs) assert.equal(typeof d.e, 'number');
  assert.equal(meta.docs.find((d) => d.s === '100_5_undgumshalsan').e, 100.5);
  assert.equal(meta.docs.find((d) => d.s === '227_pollywood').e, 227);
});

test('search hits point at lines that really contain the term', async () => {
  const res = await engine.search('välkomna');
  assert.ok(res.results.length > 0);
  const r = res.results[0];
  const txt = await engine.lines(r.doc);
  assert.match(txt[r.any[0] - 1][1].toLowerCase(), /välkomna/);
});

test('diacritics are optional and prefixes work', async () => {
  const a = await engine.search('valkomna');
  const b = await engine.search('välkom');
  assert.ok(a.results.length > 0);
  assert.ok(b.results.length >= a.results.length);
});

test('phrase search only returns lines with the adjacent words', async () => {
  const res = await engine.search('"music unite"');
  for (const r of res.results.slice(0, 5)) {
    const txt = await engine.lines(r.doc);
    for (const l of r.all) assert.match(txt[l - 1][1].toLowerCase(), /music unite/);
  }
});

test('leaked *…* spans become <em> markup', async () => {
  // 100: a whole line is a span.
  const d = meta.docs.findIndex((d) => d.s === '100_5_undgumshalsan');
  assert.ok(d >= 0);
  const txt = await engine.lines(d);
  const line = txt.find(([, t]) => t.startsWith('<em>Jag vill veta'));
  assert.ok(line, 'expected a span line normalized');
  assert.match(line[1], /^<em>.*<\/em>$/);
  const html = readFileSync(join(dist, 'p', meta.docs[d].slug + '.html'), 'utf8');
  assert.match(html, /<em>Jag vill veta/);
  // Search still finds the text inside the markup.
  const res = await engine.search('samma');
  assert.ok(res.results.some((r) => r.doc === d));
  // 227: short span and an unpaired * left as literal text.
  const e = meta.docs.findIndex((d) => d.s === '227_pollywood');
  assert.ok(e >= 0);
  const t2 = await engine.lines(e);
  assert.ok(t2.some(([, t]) => t === '<em>I love you</em>'), 'expected a span normalized');
  assert.ok(
    t2.some(([, t]) => t.includes("'Cause only when you want the boots") && t.includes('*')),
    'expected an unpaired * left literal'
  );
});

test('garbage queries do not throw', async () => {
  assert.equal(await engine.search('!!! ??'), null);
  assert.deepEqual((await engine.search('zzzqqqxx')).results, []);
});
