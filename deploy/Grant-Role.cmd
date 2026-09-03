@echo off
setlocal
rem ---------------------------------------------------------------------------
rem  Break-glass: grant, list or revoke a GCIO role from the host, without the
rem  admin console. Use it when nobody can sign in - a fresh database has no
rem  grants, and a directory outage resolves every role to nothing.
rem
rem    Grant-Role.cmd <sAMAccountName> <admin|pm|viewer>
rem    Grant-Role.cmd --list
rem    Grant-Role.cmd --remove <sAMAccountName>
rem
rem  This wrapper exists because running the .js directly hands it to Windows
rem  Script Host, whose JScript engine cannot parse ESM and fails with an
rem  800A03EA compile error that names nothing useful. It resolves the bundled
rem  runtime (runtime\node\node.exe, NOT runtime\node.exe) and the script, and
rem  passes arguments straight through.
rem
rem  cd to the install directory first: the tool reads .env through dotenv,
rem  which resolves it against the working directory. Launched from anywhere
rem  else it would find no configuration and report a connection failure whose
rem  cause is the shell's cwd.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

set "NODE=%~dp0runtime\node\node.exe"
set "SCRIPT=%~dp0app\server\tools\grant-role.js"

rem A development checkout has no app\ or runtime\; fall back to the repo
rem layout and whatever node is on PATH, so the same wrapper works in both.
if not exist "%SCRIPT%" set "SCRIPT=%~dp0server\tools\grant-role.js"
if not exist "%NODE%"   set "NODE=node"

if not exist "%SCRIPT%" (
  echo [FAIL] cannot find grant-role.js under "%~dp0"
  echo        Run this from the GCIO install directory ^(C:\gcio^) or a checkout.
  exit /b 1
)

"%NODE%" "%SCRIPT%" %*
exit /b %ERRORLEVEL%
