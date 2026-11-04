# Persistent local demo

A long-running copy of the whole app on this computer, for exploring and showing EOMS Lite. **Local only (127.0.0.1); not Supabase.**

| Part | Address |
|---|---|
| App (employee page) | http://127.0.0.1:4180/ |
| Admin portal | http://127.0.0.1:4180/admin/login (`admin@example.test` / `demo-admin-password`) |
| Signed-in non-admin (to see the refusal screen) | `viewer@example.test` / `demo-not-admin` |
| API front door | http://127.0.0.1:54322 (PostgREST proxy + auth stand-in; reset/test helpers disabled) |
| Database | PostgreSQL 17, container `eoms-demo-db`, port 54330, Docker volume `eoms-demo_eoms_demo_pgdata` |

Separate from the test stack (ports 54321/3010/54329/4173), so running the tests never touches demo data.

## How it stays up

* Docker containers `eoms-demo-db` and `eoms-demo-postgrest` have restart policy `unless-stopped` and keep their data in a volume.
* `scripts/demo/start-demo.ps1` is a supervisor: every 15 s it starts the containers, the front door and the web server if any is down
  (tested: a killed web server came back within one cycle; data survived a database restart). Logs: `.demo\*.log`.
* **Auto-start at Windows sign-in** is a scheduled task for your user only. Install it yourself (it is your machine's configuration):

```
powershell -ExecutionPolicy Bypass -File scripts\demo\install-autostart.ps1
```

Remove it (data is kept): `powershell -ExecutionPolicy Bypass -File scripts\demo\uninstall-autostart.ps1`.
Docker Desktop must also start at sign-in (Docker Desktop -> Settings -> General -> "Start Docker Desktop when you sign in").

## Things to know

* The demo session's check-in window was seeded as "2 h ago to 3 h ahead". After it closes, create a new session in **Admin -> Sessions** (times are IST)
  and assign rooms; or re-seed (wipes the demo database): stop the supervisor, then in a shell set `STACK_PORT=54322 POSTGREST_PORT=3011
  E2E_DATABASE_URL=postgres://postgres:demo-local-only@127.0.0.1:54330/eoms_demo STACK_USERS_FILE=<repo>\.demo\users.json STACK_URL=http://127.0.0.1:54322`,
  run `node tools/local-stack/server.mjs --local-test-stack` (helpers enabled) and `node tools/local-stack/seed-demo.mjs`, then restart the supervisor.
* Demo users live in `.demo\users.json` as salted scrypt hashes (never in clear). The JWT secret and database password are local-only demo values.
* To delete everything: uninstall the auto-start, then `docker compose -f docker-compose.demo.yml down -v`.
* After changing frontend code, rebuild the demo bundle: in `web`, set `VITE_SUPABASE_URL=http://127.0.0.1:54322` and
  `VITE_SUPABASE_ANON_KEY=<output of node ../tools/local-stack/anon-key.mjs>`, then `npx vite build --outDir dist-demo --emptyOutDir`.
