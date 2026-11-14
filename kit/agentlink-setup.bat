@echo off
rem AgentLink setup. Double-click to install or update AgentLink on this laptop.
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Jathu23/AgentLink/main/kit/setup.ps1 | iex"
echo.
pause
