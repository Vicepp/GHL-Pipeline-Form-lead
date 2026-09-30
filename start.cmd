@echo off
REM Pheenyx Capital - Pipeline Workflow : local preview
REM Serves this folder on http://localhost:8080 and opens your browser.

cd /d "%~dp0"

where py >nul 2>nul && goto :py
where python >nul 2>nul && goto :python
where node >nul 2>nul && goto :node

echo Could not find Python or Node on this machine.
echo Open index.html directly in your browser instead, or install Python from python.org.
pause
exit /b 1

:py
start "" http://localhost:8080/
py -3 -m http.server 8080
exit /b

:python
start "" http://localhost:8080/
python -m http.server 8080
exit /b

:node
start "" http://localhost:8080/
npx --yes http-server -p 8080 -c-1 .
exit /b
