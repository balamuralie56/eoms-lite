# Registers the scheduled task "EOMS Lite demo": runs start-demo.ps1 hidden at YOUR Windows sign-in (current user only,
# no administrator rights, no password stored), and starts it now. Undo with uninstall-autostart.ps1.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'start-demo.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'EOMS Lite demo' -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Keeps the local EOMS Lite demo running at http://127.0.0.1:4180 (localhost only).' -Force | Out-Null
Start-ScheduledTask -TaskName 'EOMS Lite demo'
"Registered and started 'EOMS Lite demo'. Open http://127.0.0.1:4180/ (it can take ~30 s after sign-in while Docker starts)."
