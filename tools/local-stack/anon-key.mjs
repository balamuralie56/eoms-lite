// Prints the local test stack's anon key: a JWT (role "anon") signed with the local PostgREST test secret.
// Same shape as a Supabase anon key. LOCAL TEST SECRET ONLY.
import { createHmac } from 'node:crypto';

const secret = process.env.PGRST_JWT_SECRET || 'e2e-only-jwt-secret-0123456789abcdef0123456789';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const head = b64u({ alg: 'HS256', typ: 'JWT' });
const body = b64u({ role: 'anon', iss: 'local-test-stack', iat: 1_700_000_000, exp: 4_102_444_800 });
process.stdout.write(`${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`);
