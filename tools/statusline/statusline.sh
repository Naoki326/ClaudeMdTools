#!/bin/bash
# Claude Code statusline - 显示 context 和 usage 信息
# 仅在两个条件同时满足时更新缓存：
#   1. 每次对话结束（Stop hook 设置标记）
#   2. 距上次缓存更新超过 MIN_SECS 秒

INPUT=$(cat)
CACHE="$HOME/.claude/statusline-cache.json"
FLAG="$HOME/.claude/statusline-stop.flag"
MIN_SECS=300  # 最小刷新间隔（秒），默认 5 分钟

# 判断是否需要更新缓存
SHOULD_UPDATE=false
if [ -f "$FLAG" ]; then
    NOW=$(date +%s)
    if [ -f "$CACHE" ]; then
        LAST=$(node -e "try{const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log(d.ts||0)}catch(e){console.log(0)}" "$CACHE" 2>/dev/null || echo 0)
        ELAPSED=$((NOW - LAST))
        [ "$ELAPSED" -ge "$MIN_SECS" ] && SHOULD_UPDATE=true
    else
        SHOULD_UPDATE=true
    fi
fi

# 更新缓存
if [ "$SHOULD_UPDATE" = true ]; then
    echo "$INPUT" | node "$HOME/.claude/statusline-update.js" "$CACHE" 2>/dev/null
    rm -f "$FLAG"
fi

# 从缓存读取并显示
if [ -f "$CACHE" ]; then
    node "$HOME/.claude/statusline-display.js" "$CACHE" 2>/dev/null || echo "claude | cache error"
else
    echo "claude | 等待首次对话..."
fi
