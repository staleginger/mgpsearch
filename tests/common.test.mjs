import test from 'node:test';
import assert from 'node:assert/strict';
import { tokens, fold, shardKey, highlight, decodeEntities, cleanInlineHtml, renderInline } from '../site/common.js';
import { parseTranscript, parseFrontMatter, episodeOf } from '../scripts/build.mjs';
import { parseQuery } from '../site/engine.js';
import { graphSvg } from '../site/graph.js';

test('tokens fold Swedish diacritics and drop 1-char tokens', () => {
  assert.deepEqual(tokens('Välkomna, åäö! a 100,5'), ['valkomna', 'aao', '100']);
  assert.equal(fold('Ångström'), 'angstrom');
});

test('shardKey uses first two code points', () => {
  assert.equal(shardKey('abc'), '61-62');
});

test('highlight marks prefix matches and escapes html', () => {
  assert.equal(highlight('Hej <b> världen', ['varld']), 'Hej &lt;b&gt; <mark>världen</mark>');
});

test('decodeEntities decodes the leaked entities, one pass only', () => {
  assert.equal(decodeEntities('M&amp;M &gt; &lt; &nbsp;x'), 'M&M > < x');
  assert.equal(decodeEntities('&amp;lt;i&amp;gt;'), '&lt;i&gt;'); // not re-decoded
});

test('cleanInlineHtml normalizes leaked tags to <em>/<strong>', () => {
  assert.equal(cleanInlineHtml('&lt;i&gt;song&lt;/i&gt; och <em>raw</em>'), '<em>song</em> och <em>raw</em>');
  assert.equal(cleanInlineHtml('<b>bold</b> <strong>s</strong>'), '<strong>bold</strong> <strong>s</strong>');
  assert.equal(cleanInlineHtml('a <u>underlined</u> b'), 'a underlined b');
  assert.equal(cleanInlineHtml('< i>spaced</i>'), '<em>spaced</em>');
});

test('cleanInlineHtml closes unclosed tags and drops orphan closers', () => {
  assert.equal(cleanInlineHtml('<i>never closed'), '<em>never closed</em>');
  assert.equal(cleanInlineHtml('</i> stray opener'), ' stray opener');
});

test('cleanInlineHtml converts *…* asterisk spans to <em>', () => {
  assert.equal(cleanInlineHtml('*I love you*'), '<em>I love you</em>');
  assert.equal(cleanInlineHtml('men *hon* var hora'), 'men <em>hon</em> var hora');
  assert.equal(cleanInlineHtml('*a* *b*'), '<em>a</em> <em>b</em>');
  assert.equal(cleanInlineHtml('För att det är *dewided*.'), 'För att det är <em>dewided</em>.');
});

test('cleanInlineHtml leaves censored words and unpaired * alone', () => {
  assert.equal(cleanInlineHtml('f*ttan och j*vla'), 'f*ttan och j*vla');
  assert.equal(cleanInlineHtml('hora* med stjärnor'), 'hora* med stjärnor');
  assert.equal(cleanInlineHtml('*never closed'), '*never closed');
});

test('cleanInlineHtml mixes all three notations in one line', () => {
  assert.equal(
    cleanInlineHtml('&lt;i&gt;a&lt;/i&gt; <b>b</b> *c*'),
    '<em>a</em> <strong>b</strong> <em>c</em>'
  );
});

test('renderInline escapes text but passes whitelisted tags through', () => {
  assert.equal(renderInline('a & <em>it</em> <b>x</b>'), 'a &amp; <em>it</em> &lt;b&gt;x&lt;/b&gt;');
});

test('highlight passes inline tags through and marks inside them', () => {
  assert.equal(highlight('<em>I love you</em>', ['love']), '<em>I <mark>love</mark> you</em>');
});

test('parseTranscript reads timestamps, keeps untimed lines', () => {
  const l = parseTranscript('[00:01:05] Hej  \n\nutan tid\n[01:02] kort\n');
  assert.deepEqual(l, [[65, 'Hej'], [65, 'utan tid'], [62, 'kort']]);
});

test('parseFrontMatter reads keys, strips the block, is a no-op without it', () => {
  const { attrs, body } = parseFrontMatter('---\ntitle: "Hej du"\ntags: a, b\n---\n[00:00:01] Hej\n');
  assert.deepEqual(attrs, { title: 'Hej du', tags: 'a, b' });
  assert.equal(body, '[00:00:01] Hej\n');
  assert.deepEqual(parseFrontMatter('[00:00:01] Hej\n'), { attrs: {}, body: '[00:00:01] Hej\n' });
});

test('episodeOf: episode: key wins, filename number is fallback, null for non-episodes', () => {
  assert.equal(episodeOf({}, '427_pollywood'), 427);
  assert.equal(episodeOf({}, '100_5_undgumshalsan'), 100.5);
  assert.equal(episodeOf({}, '100_15_hoppas'), 100);
  assert.equal(episodeOf({}, 'om_showet'), null);
  assert.equal(episodeOf({ episode: '100,5' }, 'om_showet'), 100.5);
  assert.equal(episodeOf({ episode: '100.5' }, 'om_showet'), 100.5);
  assert.equal(episodeOf({ episode: '99' }, '427_pollywood'), 99);
  assert.equal(episodeOf({ episode: 'inte ett tal' }, 'om_showet'), null);
});

test('graphSvg: empty input is "", bars get links and tooltips', () => {
  assert.equal(graphSvg([]), '');
  const s = graphSvg([
    { x: 1, y: 1, href: 'p/1.html', label: 'Ett' },
    { x: 5, y: 2, href: 'p/5.html', label: 'Fem' },
  ]);
  assert.match(s, /^<svg class="graph"/);
  assert.equal(s.match(/<rect /g).length, 2);
  assert.match(s, /<a href="p\/1\.html"><title>Ett<\/title><rect /);
  const single = graphSvg([{ x: 42, y: 1, href: 'p/42.html', label: '<x>' }]);
  assert.equal(single.match(/<rect /g).length, 1);
  assert.match(single, /&lt;x&gt;/);
});

test('graphSvg positions bars proportionally to the episode number (gaps show)', () => {
  const s = graphSvg([
    { x: 1, y: 1, href: 'a', label: 'A' },
    { x: 2, y: 1, href: 'b', label: 'B' },
    { x: 100, y: 1, href: 'c', label: 'C' },
  ]);
  const xs = [...s.matchAll(/<rect x="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(xs[2] - xs[1] > 20 * (xs[1] - xs[0]), 'episode gap must be a wide x gap');
  assert.match(s, />100<\/text>/); // bar x-labels carry the episode numbers
});

test('graphSvg formats fractional episode labels Swedish-style', () => {
  const s = graphSvg([
    { x: 100, y: 1, href: 'a', label: 'A' },
    { x: 100.5, y: 2, href: 'b', label: 'B' },
    { x: 101, y: 1, href: 'c', label: 'C' },
  ]);
  assert.match(s, />100,5<\/text>/);
});

test('parseQuery: last plain term is a prefix, phrases are exact', () => {
  const q = parseQuery('"hej du" värld');
  assert.deepEqual(q.phrases, [['hej', 'du']]);
  assert.equal(q.terms.at(-1).prefix, true);
  assert.equal(q.terms[0].prefix, false);
  assert.equal(parseQuery('värld ').terms[0].prefix, false);
});
