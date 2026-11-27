@echo off
chcp 65001 >nul
rem しろを塗る・屋上建築Web版をこの PC で開く（tools/serve.py で配って、ブラウザで開く。キャッシュしないので直したらすぐ反映）
rem 止めるときはこの窓を閉じる。ポートを変えたいときは: start.bat 8080
cd /d "%~dp0"
set PORT=%1
if "%PORT%"=="" set PORT=8765
set URL=http://localhost:%PORT%/

where python >nul 2>nul
if %errorlevel%==0 (
  set PY=python
) else (
  where py >nul 2>nul
  if errorlevel 1 (
    echo Python が見つかりません。https://www.python.org/ から入れてください。
    pause
    exit /b 1
  )
  set PY=py
)

echo %URL% で開きます（この窓を閉じると止まります）
start "" %URL%
%PY% tools/serve.py %PORT%
pause
