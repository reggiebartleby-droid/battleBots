@echo off
rem Moves deploy-pages.yml into .github\workflows (Claude cannot write into .github directly).
cd /d "%~dp0"
if not exist ".github\workflows" mkdir ".github\workflows"
move /y "deploy-pages.yml" ".github\workflows\deploy-pages.yml"
if exist ".github\workflows\deploy-pages.yml" (echo OK: .github\workflows\deploy-pages.yml) else (echo FAILED)
pause
