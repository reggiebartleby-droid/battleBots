@echo off
rem Robot Revolution: commit v0.31, create the public GitHub repo, push, turn on Pages.
rem Uses the GitHub CLI (gh), which knows your account, so no username needs typing.
cd /d "%~dp0"
where gh >nul 2>nul || (echo GitHub CLI not found. Run:  winget install GitHub.cli  then reopen and run this again. & pause & exit /b 1)
gh auth status >nul 2>nul || gh auth login --web --git-protocol https
if exist "deploy-pages.yml" (
  if not exist ".github\workflows" mkdir ".github\workflows"
  move /y "deploy-pages.yml" ".github\workflows\deploy-pages.yml" >nul
)
git add -A
git commit -m "v0.31"
gh repo create battleBots --public --source . --remote origin --push || (echo Repo create/push failed. & pause & exit /b 1)
for /f %%u in ('gh api user --jq .login') do set GHUSER=%%u
gh api -X POST "repos/%GHUSER%/battleBots/pages" -f build_type=workflow >nul 2>nul
echo.
echo Pushed. Game link (live in a few minutes): https://%GHUSER%.github.io/battleBots/
echo Build progress: https://github.com/%GHUSER%/battleBots/actions
pause
