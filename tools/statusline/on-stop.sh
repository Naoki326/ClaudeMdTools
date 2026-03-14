#!/bin/bash
# Stop hook：每次 Claude 完成响应时设置标记
# statusline 脚本检测到此标记后（且时间间隔足够）会刷新缓存
touch "$HOME/.claude/statusline-stop.flag"
