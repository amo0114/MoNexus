@echo off
setlocal EnableExtensions

for %%I in ("%~dp0..") do set "ROOT_DIR=%%~fI"
set "FRONTEND_DIR=%ROOT_DIR%"
set "BACKEND_DIR=%ROOT_DIR%\server"
set "SEED=false"

if /I "%~1"=="--seed" set "SEED=true"
if /I "%~1"=="seed" set "SEED=true"

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found in PATH.
  exit /b 1
)

where docker >nul 2>nul
if errorlevel 1 (
  echo [ERROR] docker not found in PATH.
  exit /b 1
)

set "PG_CONTAINER="
for /f %%I in ('docker ps --filter "name=monexus-db" --filter "status=running" --format "{{.Names}}"') do set "PG_CONTAINER=%%I"

if /I not "%PG_CONTAINER%"=="monexus-db" (
  echo [ERROR] PostgreSQL container "monexus-db" is not running.
  echo Please start it manually first:
  echo   docker compose up -d postgres
  exit /b 1
)

if not exist "%BACKEND_DIR%\.env" (
  if exist "%BACKEND_DIR%\.env.example" (
    copy "%BACKEND_DIR%\.env.example" "%BACKEND_DIR%\.env" >nul
    echo [INFO] Created server\.env from .env.example
  ) else (
    echo [ERROR] Missing %BACKEND_DIR%\.env and .env.example
    exit /b 1
  )
)

if not exist "%FRONTEND_DIR%\node_modules" (
  echo [INFO] Installing frontend dependencies...
  pushd "%FRONTEND_DIR%"
  call npm install
  if errorlevel 1 goto :error
  popd
)

if not exist "%BACKEND_DIR%\node_modules" (
  echo [INFO] Installing backend dependencies...
  pushd "%BACKEND_DIR%"
  call npm install
  if errorlevel 1 goto :error
  popd
)

echo [INFO] Preparing backend runtime...
pushd "%BACKEND_DIR%"
call npm run db:generate
if errorlevel 1 goto :error

call npx prisma migrate deploy
if errorlevel 1 goto :error

if /I "%SEED%"=="true" (
  call npm run db:seed
  if errorlevel 1 goto :error
)
popd

echo [INFO] Starting backend and frontend in new windows...
start "MoNexus Backend" cmd /k "cd /d \"%BACKEND_DIR%\" && npm run dev"
start "MoNexus Frontend" cmd /k "cd /d \"%FRONTEND_DIR%\" && npm run dev"

echo.
echo Backend:  http://localhost:3000
echo Frontend: http://localhost:5173
echo Admin:    admin@moyuan.net / admin123
echo User:     test@moyuan.net / user123
echo.
echo Tip: use "scripts\dev-up.bat --seed" when you want to re-run seed.
exit /b 0

:error
popd 2>nul
echo [ERROR] Startup preparation failed.
exit /b 1
