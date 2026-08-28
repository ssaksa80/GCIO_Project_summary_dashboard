@echo off
REM Execution-policy-proof launcher for code-update.ps1.
REM
REM A copy of code-update.ps1 carried over from another machine has a
REM mark-of-the-web zone marker and cannot unblock itself, so RemoteSigned
REM refuses to run it. This .cmd bootstraps past that.
REM
REM Usage:  Update-GCIO.cmd            install whatever artifact is beside it
REM         Update-GCIO.cmd -Rollback   revert to the previous version
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0code-update.ps1" %*
