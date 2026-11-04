# Removes the auto-start and stops the demo. Data stays in the Docker volume "eoms-demo_eoms_demo_pgdata".
# To also delete the demo data:  docker compose -f docker-compose.demo.yml down -v   (run in the repository root)
Unregister-ScheduledTask -TaskName 'EOMS Lite demo' -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'start-demo\.ps1' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'local-stack.server\.mjs|serve-dist\.mjs' } |
  Where-Object { $_.CommandLine -notmatch 'dist-e2e' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
docker stop eoms-demo-postgrest eoms-demo-db *> $null
'Auto-start removed and the demo stopped (data kept).'
