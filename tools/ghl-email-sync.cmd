@echo off
rem GHL email sync - started by Windows Task Scheduler.
rem   daily at 6:00 AM : no arguments (re-checks the last 90 days)
rem   every 2 hours    : --days=3      (keeps "last 24 hours" current)
rem Appends to tools\.ghl-cache\sync.log. Safe to run by hand too.
cd /d "%~dp0.."
node tools\ghl-email-sync.js %* >> tools\.ghl-cache\sync.log 2>&1
