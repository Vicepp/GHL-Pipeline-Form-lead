@echo off
rem Calendly sync - started by Windows Task Scheduler.
rem   daily at 5:30 AM : no arguments (full history, marks anything Calendly dropped)
rem   every 15 minutes : --recent      (last 14 days + upcoming, new recaps/transcripts)
rem Appends to tools\.calendly-cache\sync.log. Safe to run by hand too.
cd /d "%~dp0.."
if not exist tools\.calendly-cache mkdir tools\.calendly-cache
node tools\calendly-sync.js %* >> tools\.calendly-cache\sync.log 2>&1
