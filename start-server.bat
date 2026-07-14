@echo off
title Server Rafturi Depozit
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js nu este instalat pe acest calculator.
  echo   1^) Deschide https://nodejs.org
  echo   2^) Descarca versiunea "LTS" si instaleaza-o ^(Next, Next, Finish^)
  echo   3^) Ruleaza din nou acest fisier ^(start-server.bat^)
  echo.
  pause
  exit /b
)
echo.
echo   Pornesc serverul de rafturi...
echo   LASA ACEASTA FEREASTRA DESCHISA cat timp lucrati.
echo   Ca sa opresti serverul: inchide fereastra sau apasa Ctrl+C.
echo.
node server.js
echo.
echo   Serverul s-a oprit.
pause
