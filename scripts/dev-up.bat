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

set "PG_RUNNING="
for /f %%I in ('docker ps --filter "name=monexus-db" --filter "status=running" --format "{{.Names}}"') do set "PG_RUNNING=%%I"

if /I "%PG_RUNNING%"=="monexus-db" (
  echo [INFO] PostgreSQL container is already running.
) else (
  REM Container exists but stopped? Restart it. Otherwise compose up.
  set "PG_EXISTS="
  for /f %%I in ('docker ps -a --filter "name=monexus-db" --format "{{.Names}}"') do set "PG_EXISTS=%%I"
  if /I "%PG_EXISTS%"=="monexus-db" (
    echo [INFO] Restarting existing PostgreSQL container...
    docker start monexus-db
  ) else (
    echo [INFO] Creating PostgreSQL container...
    docker compose up -d postgres
  )
  if errorlevel 1 (
    echo [ERROR] Failed to start PostgreSQL container.
    exit /b 1
  )
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
start "MoNexus Backend" /D "%BACKEND_DIR%" cmd /k "npm run dev"
start "MoNexus Frontend" /D "%FRONTEND_DIR%" cmd /k "npm run dev"

echo.
echo Backend:  http://localhost:3000
echo Frontend: http://localhost:5173
echo Admin:    admin@moyuan.net / admin123
echo User:     test@moyuan.net / user123
echo Merchant: merchant@moyuan.net / merchant123
echo.
echo Tip: use "scripts\dev-up.bat --seed" when you want to re-run seed.
exit /b 0

:error
popd 2>nul
echo [ERROR] Startup preparation failed.
exit /b 1
