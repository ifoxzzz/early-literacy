@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo ==========================================
echo  一键生成全部语音（已有文件会自动跳过）
echo  提示：若刚改过 tools\data\volume-*.txt，请先运行 tools\生成字库.bat
echo ==========================================
echo.
echo [1/5] 通用提示语（请找出、答对啦、完成啦等）
python tools\scripts\gen_phrase_audio.py
echo.
echo [2/5] 名字语音（不同小朋友的问候、夸奖、结束语）
python tools\scripts\gen_name_audio.py
echo.
echo [3/5] 音节语音（拼音命名的单字发音）
python tools\scripts\gen_syllable_audio.py
echo.
echo [4/5] 组词语音（每个字的解释句）
python tools\scripts\gen_words_audio.py
echo.
echo [5/5] 星星语音（stars0 ~ stars20）
python tools\scripts\gen_star_audio.py
pause
