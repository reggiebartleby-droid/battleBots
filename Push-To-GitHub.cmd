@echo off
rem Robot Revolution: commit everything, push to GitHub, make sure Pages is on.
rem Safe to run every time: creates the repo only if it doesn't exist yet.
cd /d "%~dp0"
where gh >nul 2>nul || (echo GitHub CLI not found. Run:  winget install GitHub.cli  then reopen and run this again. & pause & exit /b 1)
gh auth status >nul 2>nul || gh auth login --web --git-protocol https
for /f %%u in ('gh api user --jq .login') do set GHUSER=%%u
if exist "deploy-pages.yml" (
  if not exist ".github\workflows" mkdir ".github\workflows"
  move /y "deploy-pages.yml" ".github\workflows\deploy-pages.yml" >nul
)
git add -A
git commit -m "v0.32 phone mode" >nul 2>nul
git remote get-url origin >nul 2>nul || (
  gh repo view %GHUSER%/battleBots >nul 2>nul && git remote add origin https://github.com/%GHUSER%/battleBots.git
)
git remote get-url origin >nul 2>nul || (
  gh repo create battleBots --public --source . --remote origin || (echo Repo create failed. & pause & exit /b 1)
)
git push -u origin master || (echo Push failed. Copy the lines above to Claude. & pause & exit /b 1)
gh api -X POST "repos/%GHUSER%/battleBots/pages" -f build_type=workflow >nul 2>nul
echo.
echo Pushed. Game link (live in a few minutes): https://%GHUSER%.github.io/battleBots/
echo Build progress: https://github.com/%GHUSER%/battleBots/actions
pause
