// k6 load test for the check-in RPC. NOT YET RUN against Supabase: no measurements exist for it.
//
//   k6 run -e SUPABASE_URL=https://<staging-ref>.supabase.co -e ANON_KEY=<staging anon key> \
//          -e SCENARIO=sustained k6-checkin.js
//
// SCENARIO = sustained  500 requests spread over 15 minutes (constant arrival rate)
//            burst100   100 requests all at once
//            burst200   200 requests all at once
//            dupes      60 requests for 20 employees, 3 each, all at once
//
// Use a THROWAWAY staging project seeded by seed_loadtest.sql. The anon key is public by design
// (it is shipped in the frontend); never use the service_role key here.
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const BASE = __ENV.SUPABASE_URL;
const KEY = __ENV.ANON_KEY;
const SCENARIO = __ENV.SCENARIO || 'burst100';

const latency = new Trend('checkin_ms', true);
const unexplained = new Counter('unexplained_errors');
const EXPECTED = ['ALLOCATED', 'ALREADY_ALLOCATED', 'ROOMS_FULL', 'NOT_SCHEDULED', 'NO_ACTIVE_SESSION',
                  'REENTRY_REQUIRES_ADMIN', 'VERIFICATION_REQUIRED', 'INVALID_ID'];

// k6 metrics must be created in the init context; one counter per result code (k6 prints them in its summary).
const CODE_COUNTERS = {};
for (const c of [...EXPECTED, 'BUSY', 'RATE_LIMITED', 'OTHER']) CODE_COUNTERS[c] = new Counter('code_' + c);

const scenarios = {
  sustained: { executor: 'constant-arrival-rate', rate: 500, timeUnit: '15m', duration: '15m', preAllocatedVUs: 50, maxVUs: 200 },
  burst100: { executor: 'shared-iterations', vus: 100, iterations: 100, maxDuration: '2m' },
  burst200: { executor: 'shared-iterations', vus: 200, iterations: 200, maxDuration: '2m' },
  dupes: { executor: 'shared-iterations', vus: 60, iterations: 60, maxDuration: '2m' },
};

export const options = {
  scenarios: { main: scenarios[SCENARIO] },
  thresholds: {
    // TARGETS, not results. Report measured values separately.
    checkin_ms: ['p(95)<1000'],
    unexplained_errors: ['count==0'],
    http_req_failed: ['rate==0'],
  },
};

export default function () {
  let n = __ITER + 1;
  if (SCENARIO === 'dupes') n = (__ITER % 20) + 1;        // each of 20 employees submitted 3x concurrently
  const id = 'LT' + String(n).padStart(4, '0');
  const res = http.post(`${BASE}/rest/v1/rpc/checkin`, JSON.stringify({ p_employee_id: id }), {
    headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  latency.add(res.timings.duration);
  let body = null;
  try { body = res.json(); } catch (e) { /* non-JSON = platform error */ }
  const ok = res.status === 200 && body && EXPECTED.includes(body.code);
  if (!ok) unexplained.add(1);
  check(res, { 'status 200': (r) => r.status === 200 });
  const c = body && body.code ? (CODE_COUNTERS[body.code] || CODE_COUNTERS.OTHER) : CODE_COUNTERS.OTHER;
  c.add(1);
}

export function handleSummary(data) {
  // BUSY / RATE_LIMITED / HTTP 5xx / 429 are counted as unexplained on purpose: they must be investigated.
  return { stdout: `scenario=${SCENARIO}\n${JSON.stringify(data.metrics.checkin_ms.values)}\n`, 'results/summary.json': JSON.stringify(data, null, 2) };
}
