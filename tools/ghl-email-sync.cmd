@echo off
rem Daily run of the GHL email sync - started by Windows Task Scheduler.
rem Appends to tools\.ghl-cache\sync.log. Safe to run by hand too.
cd /d "%~dp0.."
node tools\ghl-email-sync.js >> tools\.ghl-cache\sync.log 2>&1
