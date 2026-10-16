@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
set "VAULT_RUNTIME=%~dp0..\..\node_modules\electron\dist\electron.exe"
if not exist "%VAULT_RUNTIME%" (
  echo Install settings-vault inside your Toolbox mods folder first.
  pause
  exit /b 1
)
"%VAULT_RUNTIME%" "%~dp0lib\minimap-patch.js" %*
pause
