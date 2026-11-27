@echo off
rem Siro wo Nuru - Roof Build Web: serve this folder and open it in the browser.
rem tools\serve.py sends no-cache headers, so edits show up on reload.
rem Close this window to stop. Other port: start.bat 8080
cd /d "%~dp0"
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8765"
set "PY=python"
where python >NUL 2>NUL || set "PY=py"
echo Serving http://localhost:%PORT%/  (close this window to stop)
if not defined NOBROWSER start "" "http://localhost:%PORT%/"
%PY% tools\serve.py %PORT%
if errorlevel 1 echo Python was not found or the server failed. Install Python from https://www.python.org/
pause
