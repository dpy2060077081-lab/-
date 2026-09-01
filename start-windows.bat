@echo off
cd /d "%~dp0"
where py >nul 2>nul && (py -3 review_app\server.py & pause & exit /b)
python review_app\server.py
pause
