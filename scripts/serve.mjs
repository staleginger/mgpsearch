// Tiny static server for dist/ (npm run serve). PORT env var optional.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(fileURLToPath(import.meta.url), '..', '..', 'dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/plain; charset=utf-8' };
createServer(async (req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p.endsWith('/')) p += 'index.html';
  try {
    const data = await readFile(join(dist, p));
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }).end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(process.env.PORT || 8000, () => console.log(`http://localhost:${process.env.PORT || 8000}/`));
