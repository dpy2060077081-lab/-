import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = dirname(project);
const port = Number(process.env.PORT ?? 8766);
const types = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

createServer(async (request, response) => {
  const relative = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '');
  const target = resolve(root, relative);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!target.startsWith(prefix)) return response.writeHead(403).end();
  try {
    if (!(await stat(target)).isFile()) throw new Error('not a file');
    response.writeHead(200, { 'content-type': types[extname(target)] ?? 'application/octet-stream' });
    createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
