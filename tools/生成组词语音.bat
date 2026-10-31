@echo off
chcp 65001 >nul
cd /d "%~dp0.."
python tools\scripts\gen_words_audio.py
pause
