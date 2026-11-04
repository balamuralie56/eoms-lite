// Generates the PERMANENT check-in QR code as a high-resolution PNG.
//
//   node scripts/generate-qr.mjs https://checkin.example.org --verified --out qr/eoms-checkin-qr.png
//
// Run it ONLY after the final HTTPS address is live and you have opened it on a phone and seen the check-in page.
// The QR contains exactly the URL you pass: no employee, session, date or token. The admin portal's Settings page has the
// same tool; this script is for printing workflows. It refuses http:// and refuses to run without --verified.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'web', 'package.json'));   // reuse the frontend's installed "qrcode"
const QRCode = require('qrcode');

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'qr/eoms-checkin-qr.png';

if (!url || !/^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(url)) {
  console.error('Give the final public address, e.g. https://checkin.example.org (https only, no query string or fragment).');
  process.exit(1);
}
if (!args.includes('--verified')) {
  console.error('Refusing: pass --verified to confirm you opened this address on a phone over HTTPS and saw the check-in page.');
  process.exit(1);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
await QRCode.toFile(out, url, { width: 2048, margin: 4, errorCorrectionLevel: 'H' });
console.log(`wrote ${out} (2048 px, error correction H) encoding exactly: ${url}`);
console.log('Now scan the printed/preview code with two different phones before printing in bulk.');
