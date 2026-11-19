import { tokens, fold } from './common.js';

const q = new URLSearchParams(location.search).get('q') || '';
const terms = tokens(q);
if (q) document.getElementById('back').href = `../index.html?q=${encodeURIComponent(q)}`;
if (terms.length) {
  // Wrap matching word runs in <mark> by splitting text nodes only, so the
  // surrounding markup (<em>/<strong>) is left untouched.
  const markIn = (el) => {
    const walk = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) {
          const text = child.nodeValue;
          const runs = [...text.matchAll(/[\p{L}\p{N}]+/gu)].filter((m) =>
            terms.some((t) => fold(m[0]).startsWith(t)));
          if (!runs.length) continue;
          const frag = document.createDocumentFragment();
          let last = 0;
          for (const m of runs) {
            frag.append(text.slice(last, m.index));
            const mark = document.createElement('mark');
            mark.textContent = m[0];
            frag.append(mark);
            last = m.index + m[0].length;
          }
          frag.append(text.slice(last));
          node.replaceChild(frag, child);
        } else if (child.nodeType === 1) walk(child);
      }
    };
    walk(el);
  };
  for (const el of document.querySelectorAll('#transcript .tx')) markIn(el);
}
// Re-scroll after highlighting changed the layout.
if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' });
