// @vitest-environment node
// The site can be hosted on Vercel (vercel.json) or Cloudflare Pages (public/_headers + public/_redirects).
// The browser tests exercise public/_headers for real, so these checks keep vercel.json identical in effect.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const web = path.resolve(__dirname, '..');
const vercel = JSON.parse(fs.readFileSync(path.join(web, 'vercel.json'), 'utf8'));

function parseHeadersFile(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let block = '';
  for (const line of fs.readFileSync(path.join(web, 'public', '_headers'), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^\S/.test(line)) { block = line.trim(); out[block] = {}; continue; }
    const i = line.indexOf(':');
    out[block][line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const vercelBlock = (source: string): Record<string, string> =>
  Object.fromEntries((vercel.headers.find((h: { source: string }) => h.source === source)?.headers ?? []).map((h: { key: string; value: string }) => [h.key, h.value]));

describe('vercel.json mirrors the tested Cloudflare-format hosting rules', () => {
  const cf = parseHeadersFile();

  it('sends every security header (including the CSP) with exactly the same value', () => {
    expect(vercelBlock('/(.*)')).toEqual(cf['/*']);
    expect(Object.keys(cf['/*'])).toContain('Content-Security-Policy');
  });

  it('caches built assets the same way', () => {
    expect(vercelBlock('/assets/(.*)')).toEqual(cf['/assets/*']);
  });

  it('serves the app for every path (deep links like /admin/schedule survive a refresh)', () => {
    expect(fs.readFileSync(path.join(web, 'public', '_redirects'), 'utf8')).toMatch(/^\/\*\s+\/index\.html\s+200/m);
    expect(vercel.rewrites).toEqual([{ source: '/(.*)', destination: '/index.html' }]);
  });

  it('builds the right thing: Vite, npm ci, dist', () => {
    expect([vercel.framework, vercel.installCommand, vercel.buildCommand, vercel.outputDirectory]).toEqual(['vite', 'npm ci', 'npm run build', 'dist']);
  });

  it('only lets the browser talk to the site itself and Supabase', () => {
    const csp: string = cf['/*']['Content-Security-Policy'];
    expect(csp).toMatch(/connect-src 'self' https:\/\/\*\.supabase\.co;/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).not.toMatch(/unsafe-eval/);
  });
});
