@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo   Short Drama Review Tool - Backend Server
echo ============================================================
echo.

python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python not found. Please install Python 3.10+ and add to PATH.
    pause
    exit /b 1
)

echo Checking dependencies...
pip install -r requirements.txt -q 2>nul

echo.
echo Starting server on http://127.0.0.1:5002 ...
echo.
python server.py
pause
