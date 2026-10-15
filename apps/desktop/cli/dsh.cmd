@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\OpenGameGen.exe" --expose-internals "%~dp0..\cli.mjs" %*
exit /b %errorlevel%
