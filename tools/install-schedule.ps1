# Pheenyx Capital - Pipeline Workflow
# tools/install-schedule.ps1
# ------------------------------------------------------------------
# Sets up the GHL email sync to run by itself on THIS computer.
# Run it once on any machine that should keep the Email Campaigns page
# up to date (only ONE machine should - two would double the GHL calls).
#
#     powershell -ExecutionPolicy Bypass -File tools\install-schedule.ps1
#     powershell -ExecutionPolicy Bypass -File tools\install-schedule.ps1 -Remove
#
# Creates two Windows scheduled tasks, both pointing at this copy of the repo:
#   PHC GHL Email Sync           daily 6:00 AM - new emails + re-check 90 days (~2 h)
#   PHC GHL Email Sync (recent)  every 2 hours - re-check the last 3 days (~5 min)
# If the computer is off at a start time, the task runs once it is back on.
# A lock file stops two runs overlapping.
#
# Before the tasks can do anything, this copy needs (see README):
#   - Node 18+ and `npm install`
#   - .env.local with GHL_API_TOKEN and GHL_LOCATION_ID
#   - tools\service-account.json (Firebase -> Project settings -> Service accounts)

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot
$cmd   = Join-Path $PSScriptRoot 'ghl-email-sync.cmd'
$daily = 'PHC GHL Email Sync'
$quick = 'PHC GHL Email Sync (recent)'

if ($Remove) {
  foreach ($n in $daily, $quick) {
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $n -Confirm:$false
      Write-Host "removed: $n"
    }
  }
  return
}

# ---- preflight: say what is missing rather than schedule something that fails
$missing = @()
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $missing += 'Node.js (https://nodejs.org)' }
if (-not (Test-Path (Join-Path $root 'node_modules\firebase-admin'))) { $missing += 'npm install (run it in the repo folder)' }
$envFile = Join-Path $root '.env.local'
$envText = if (Test-Path $envFile) { Get-Content $envFile -Raw } else { '' }
if ($envText -notmatch '(?m)^GHL_API_TOKEN=\S+')   { $missing += 'GHL_API_TOKEN in .env.local' }
if ($envText -notmatch '(?m)^GHL_LOCATION_ID=\S+') { $missing += 'GHL_LOCATION_ID in .env.local' }
if (-not (Test-Path (Join-Path $PSScriptRoot 'service-account.json'))) { $missing += 'tools\service-account.json' }
if ($missing.Count) {
  Write-Host "Not ready yet - add these first:" -ForegroundColor Yellow
  $missing | ForEach-Object { Write-Host "  - $_" }
  exit 1
}

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 20)

$a1 = New-ScheduledTaskAction -Execute $cmd -WorkingDirectory $root
$t1 = New-ScheduledTaskTrigger -Daily -At 6:00AM
Register-ScheduledTask -TaskName $daily -Action $a1 -Trigger $t1 -Settings $settings -Force `
  -Description 'Daily GoHighLevel email sync for the Email Campaigns page: new emails + 90-day re-check.' | Out-Null

$a2 = New-ScheduledTaskAction -Execute $cmd -Argument '--days=3' -WorkingDirectory $root
$t2 = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddHours(7)) `
  -RepetitionInterval (New-TimeSpan -Hours 2) -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $quick -Action $a2 -Trigger $t2 -Settings $settings -Force `
  -Description 'Every 2 hours: re-check the last 3 days of GHL emails so "Last 24 hours" stays current.' | Out-Null

Get-ScheduledTask -TaskName $daily, $quick | Get-ScheduledTaskInfo |
  Select-Object TaskName, NextRunTime | Format-Table -AutoSize
Write-Host "Installed. Log: $root\tools\.ghl-cache\sync.log"
