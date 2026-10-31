@echo off
chcp 65001 >nul
cd /d "%~dp0.."
python tools\scripts\gen_syllable_audio.py
pause
