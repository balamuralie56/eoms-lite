// Static server for the production build used by the E2E suite. It does what Cloudflare Pages does with
// public/_headers (security headers incl. the CSP) and public/_redirects (SPA fallback), so those files are
// exercised for real. The only difference: connect-src also allows the local API origin.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '..', process.env.E2E_DIST || 'dist-e2e');
const port = Number(process.env.E2E_WEB_PORT || 4173);
const apiOrigin = process.env.E2E_API_ORIGIN || 'http://127.0.0.1:54321';

// parse public/_headers (only the "/*" block is used here)
const raw = fs.readFileSync(path.resolve(here, '..', 'public', '_headers'), 'utf8').split(/\r?\n/);
const headers = {};
let inAll = false;
for (const line of raw) {
  if (/^\S/.test(line)) { inAll = line.trim() === '/*'; continue; }
  if (inAll && line.trim()) {
    const i = line.indexOf(':');
    headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}
headers['Content-Security-Policy'] = headers['Content-Security-Policy'].replace("connect-src 'self'", `connect-src 'self' ${apiOrigin}`);
if (!headers['Content-Security-Policy']?.includes(apiOrigin)) throw new Error('CSP rewrite failed');

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.map': 'application/json' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');   // "/*  /index.html  200"
  const ext = path.extname(file);
  res.writeHead(200, { ...headers, 'content-type': types[ext] || 'application/octet-stream',
    ...(url.pathname.startsWith('/assets/') ? { 'cache-control': 'no-store' } : {}) });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`serving ${dist} on http://127.0.0.1:${port}`));
