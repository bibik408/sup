@echo off
REM запуск sup-сервера. требует python 3.10+ в PATH.
setlocal
cd /d "%~dp0"

if not exist ".venv" (
  echo [sup] creating venv...
  python -m venv .venv || goto :err
)

call ".venv\Scripts\activate.bat" || goto :err

echo [sup] installing deps...
pip install -q -r requirements.txt || goto :err

echo [sup] starting server...
python server.py
goto :eof

:err
echo [sup] startup failed
exit /b 1
