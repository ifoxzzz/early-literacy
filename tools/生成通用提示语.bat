@echo off
chcp 65001 >nul
cd /d "%~dp0.."
python tools\scripts\gen_phrase_audio.py
pause
