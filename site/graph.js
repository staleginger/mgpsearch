// Search-results graph: bar chart, X = episode number, Y = hits per episode.
// Bars are positioned proportionally to the episode value, so episodes with
// zero hits show up as gaps in the trend. Dependency-free, returns an
// inline-SVG string (styled via the .graph classes in style.css).
import { esc, fmtEp } from './common.js';

/** "Nice" tick step (1/2/5 × 10^n) for a target interval. */
const niceStep = (raw) => {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f >= 5 ? 10 : f >= 2 ? 5 : 1) * p;
};

/**
 * Render the trend as an inline-SVG bar chart. `points` is an x-sorted array
 * of `{x, y, href, label}` (x = episode number, y = hits ≥ 1, href = episode
 * page, label = episode title for the bar tooltip); empty input → "".
 */
export function graphSvg(points) {
  if (!points.length) return '';
  const W = 640, H = 200, pl = 34, pr = 10, pt = 10, pb = 26;
  const iw = W - pl - pr, ih = H - pt - pb;
  let x0 = Math.min(...points.map((p) => p.x));
  let x1 = Math.max(...points.map((p) => p.x));
  if (x0 === x1) {
    x0 -= 1;
    x1 += 1;
  } else {
    const pad = (x1 - x0) * 0.05;
    x0 -= pad;
    x1 += pad;
  }
  const yMax = Math.max(1, ...points.map((p) => p.y)) * 1.08;
  const X = (v) => pl + ((v - x0) / (x1 - x0)) * iw;
  const Y = (v) => pt + ih - (v / yMax) * ih;

  // Bar width from the closest pair of bars, capped so a sparse result
  // doesn't render poster-sized bars (and floored so dense results stay
  // visible).
  const xs = points.map((p) => X(p.x));
  let bw = iw;
  for (let i = 1; i < xs.length; i++) bw = Math.min(bw, xs[i] - xs[i - 1]);
  bw = Math.max(2, Math.min(bw * 0.7, 28));

  // Y ticks at nice integer hit counts.
  const ystep = Math.max(1, niceStep(yMax / 4));
  const yt = [];
  for (let v = ystep; v <= yMax + 1e-9; v += ystep) yt.push(v);
  const grid = yt.map((v) => `<line x1="${pl}" y1="${Y(v).toFixed(1)}" x2="${W - pr}" y2="${Y(v).toFixed(1)}"/>`).join('');
  const ylab = yt.map((v) => `<text x="${pl - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${v}</text>`).join('');
  // One label per bar (its episode number), skipping labels that would
  // overlap the previous one when the bars are dense.
  const xlab = [];
  let end = -Infinity;
  for (const p of points) {
    const cx = X(p.x);
    const w = fmtEp(p.x).length * 7;
    if (cx - w / 2 < end) continue;
    xlab.push(`<text x="${cx.toFixed(1)}" y="${H - pb + 16}" text-anchor="middle">${fmtEp(p.x)}</text>`);
    end = cx + w / 2 + 4;
  }
  const bars = points
    .map((p) => {
      const y = Y(p.y);
      return `<a href="${esc(p.href)}"><title>${esc(p.label)}</title><rect x="${(X(p.x) - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(pt + ih - y).toFixed(1)}"/></a>`;
    })
    .join('');

  return `<svg class="graph" viewBox="0 0 ${W} ${H}" role="img" aria-label="Stapeldiagram över träffar per avsnittsnummer">${grid}${ylab}${xlab}${bars}</svg>`;
}
