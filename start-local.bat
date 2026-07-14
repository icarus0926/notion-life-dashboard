@echo off
chcp 65001 >nul
title 天罡日程管理系统 - 关掉此窗口即停止
cd /d %~dp0
if not exist .env (
  echo [!] 缺少 .env 文件,请先复制 .env.example 为 .env 并填写配置
  pause
  exit /b 1
)
echo 启动中... 浏览器将自动打开 http://localhost:8787
start "" http://localhost:8787
node server.js
pause
