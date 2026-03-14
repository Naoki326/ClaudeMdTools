#!/bin/bash
# 安装 Claude Code statusline（context & usage 信息）
# 用法：bash install.sh
# 依赖：node（随 Claude Code 安装）

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
HOOKS_DIR="$CLAUDE_DIR/hooks"
SETTINGS="$CLAUDE_DIR/settings.json"

echo "==> 安装 statusline 脚本..."
mkdir -p "$HOOKS_DIR"
cp "$SCRIPT_DIR/statusline.sh"         "$CLAUDE_DIR/statusline.sh"
cp "$SCRIPT_DIR/statusline-update.js"  "$CLAUDE_DIR/statusline-update.js"
cp "$SCRIPT_DIR/statusline-display.js" "$CLAUDE_DIR/statusline-display.js"
cp "$SCRIPT_DIR/on-stop.sh"            "$HOOKS_DIR/on-stop.sh"

echo "==> 合并 settings.json..."
# 用 Node.js 合并配置（保留现有设置，只添加 statusLine 和 Stop hook）
node - "$SETTINGS" "$HOME" << 'EOF'
const fs = require('fs');
const path = require('path');
const settingsFile = process.argv[2];
const homeDir = process.argv[3]; // 使用 bash 传入的 $HOME（路径格式一致）

// 读取现有配置（不存在则用空对象）
let settings = {};
if (fs.existsSync(settingsFile)) {
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
}

// 设置 statusLine
settings.statusLine = {
  type: 'command',
  command: `bash ${homeDir}/.claude/statusline.sh`,
};

// 添加 Stop hook（避免重复）
if (!settings.hooks) settings.hooks = {};
if (!settings.hooks.Stop) settings.hooks.Stop = [];

const stopCmd = `bash ${homeDir}/.claude/hooks/on-stop.sh`;
const alreadyExists = settings.hooks.Stop.some(
  entry => entry.hooks && entry.hooks.some(h => h.command === stopCmd)
);

if (!alreadyExists) {
  settings.hooks.Stop.push({
    matcher: '',
    hooks: [{ type: 'command', command: stopCmd, timeout: 5 }],
  });
}

fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
console.log('settings.json 已更新');
EOF

echo ""
echo "✓ 安装完成！重启 Claude Code 后生效。"
echo "  刷新条件：对话结束 + 距上次超过 5 分钟（可修改 statusline.sh 中的 MIN_SECS）"
