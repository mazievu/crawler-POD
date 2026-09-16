@echo off
chcp 65001 >nul
title Crawler POD - Tool System
cd /d "%~dp0"

echo ===================================================
echo           CRAWLER POD - HE THONG TOOL
echo ===================================================
echo.

:: 1. Kiem tra Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [LOI] Khong tim thay Node.js tren may. Vui long cai dat Node.js truoc.
    pause
    exit /b 1
)

:: 2. Kiem tra xem server co dang chay tren port 20129 khong
netstat -ano | findstr /R /C:":20129 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
    echo [THONG BAO] He thong Tool dang chay tren cong 20129.
    echo Dang mo trinh duyet: http://localhost:20129
    start http://localhost:20129
    echo.
    echo Nhan phim bat ky de thoat cua so nay...
    pause >nul
    exit /b 0
)

echo [1/2] Dang khoi dong Server Tool tai port 20129...
echo       - SearXNG: TAT (Khong bat theo yeu cau)
echo       - PGlite Database: BAT
echo       - MCP Bridge: BAT
echo.

:: 3. Tu dong mo trinh duyet sau 2 giay
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:20129"

echo [2/2] He thong san sang tai: http://localhost:20129
echo.
echo Dang chay live logs (Nhan Ctrl+C de dung server)...
echo ---------------------------------------------------
node server.js

if errorlevel 1 (
    echo.
    echo [LOI] Server dung voi ma loi: %errorlevel%
    pause
)
