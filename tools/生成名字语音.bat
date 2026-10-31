@echo off
chcp 65001 >nul
cd /d "%~dp0.."
python tools\scripts\gen_name_audio.py
pause
