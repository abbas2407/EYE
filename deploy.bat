@echo off
title FieldPulse — Deploy to Server
color 0A

echo.
echo  =========================================
echo    FieldPulse  ^|  Deploy to Server
echo  =========================================
echo.

set SERVER=root@167.233.90.245
set REMOTE=~/EYE

echo  [1/4]  Uploading backend...
scp -r "D:\Eye\backend" %SERVER%:%REMOTE%/
if %errorlevel% neq 0 ( echo  ERROR: Backend upload failed & pause & exit /b 1 )
echo         Done.
echo.

echo  [2/4]  Uploading admin panel...
scp -r "D:\Eye\admin" %SERVER%:%REMOTE%/
if %errorlevel% neq 0 ( echo  ERROR: Admin upload failed & pause & exit /b 1 )
echo         Done.
echo.

echo  [3/4]  Uploading docker-compose.yml...
scp "D:\Eye\docker-compose.yml" %SERVER%:%REMOTE%/
if %errorlevel% neq 0 ( echo  ERROR: Compose file upload failed & pause & exit /b 1 )
echo         Done.
echo.

echo  [4/4]  Rebuilding containers on server...
ssh %SERVER% "cd ~/EYE && docker compose up -d --build"
if %errorlevel% neq 0 ( echo  ERROR: Docker rebuild failed & pause & exit /b 1 )
echo         Done.
echo.

echo  =========================================
echo    Deploy complete!
echo    Admin:  http://167.233.90.245:8080
echo    API:    http://167.233.90.245:8001
echo  =========================================
echo.
pause
