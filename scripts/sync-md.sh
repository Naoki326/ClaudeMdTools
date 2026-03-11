#!/bin/bash
# Claude Code PostToolUse Hook - 自动同步 .md 文件到 docs 目录
# 当 Claude 使用 Write 或 Edit 工具操作 .md 文件时，自动复制到 docs 目录
# 同时记录对话 session ID 和时间戳到 .metadata.json

DOCS_DIR="$(dirname "$(dirname "$0")")/docs"
PROJECT_ROOT="$(cd "$(dirname "$(dirname "$0")")" && pwd)"

# 从 stdin 读取 hook 数据（Claude Code 通过 stdin 传递 JSON）
read -r INPUT

if [ -z "$INPUT" ]; then
  exit 0
fi

# 解析 file_path（取 tool_input 中的第一个 file_path）
FILE_PATH=$(echo "$INPUT" | sed -n 's/.*"tool_input"[^}]*"file_path"\s*:\s*"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# 检查是否为 .md 文件
if [[ ! "$FILE_PATH" =~ \.md$ ]]; then
  exit 0
fi

# 检查文件是否存在
if [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

# 计算相对于项目根目录的相对路径
NORM_FILE=$(echo "$FILE_PATH" | sed 's|\\\\|/|g; s|\\|/|g')
NORM_FILE=$(cygpath -u "$NORM_FILE" 2>/dev/null || echo "$NORM_FILE")
REL_SOURCE=$(realpath --relative-to="$PROJECT_ROOT" "$NORM_FILE" 2>/dev/null || echo "$FILE_PATH")

# 确保 docs 目录存在
mkdir -p "$DOCS_DIR"

# 生成目标文件名：用路径前缀区分避免冲突
BASENAME=$(basename "$FILE_PATH")

# 获取文件所在目录的相对路径作为前缀
DIR_PATH=$(dirname "$FILE_PATH")
PREFIX=$(echo "$DIR_PATH" | sed 's|[/\\:]|_|g' | sed 's/^_*//')

# 如果文件本身就在 docs 目录中，不需要复制
REAL_DOCS=$(cd "$DOCS_DIR" 2>/dev/null && pwd)
REAL_FILE_DIR=$(cd "$(dirname "$FILE_PATH")" 2>/dev/null && pwd)
if [ "$REAL_DOCS" = "$REAL_FILE_DIR" ]; then
  exit 0
fi

# 确定目标文件名
TARGET_NAME="$BASENAME"
TARGET_PATH="$DOCS_DIR/$TARGET_NAME"

# 如果目标文件已存在且来源不同，用路径前缀区分
if [ -f "$TARGET_PATH" ]; then
  SOURCE_RECORD="$DOCS_DIR/.sources"
  RECORDED_SOURCE=""
  if [ -f "$SOURCE_RECORD" ]; then
    RECORDED_SOURCE=$(grep "^${TARGET_NAME}=" "$SOURCE_RECORD" 2>/dev/null | head -1 | cut -d= -f2-)
  fi
  if [ -n "$RECORDED_SOURCE" ] && [ "$RECORDED_SOURCE" != "$REL_SOURCE" ]; then
    TARGET_NAME="${PREFIX}_${BASENAME}"
    TARGET_PATH="$DOCS_DIR/$TARGET_NAME"
  fi
fi

# 复制文件
cp "$FILE_PATH" "$TARGET_PATH"

# 记录来源映射
SOURCE_RECORD="$DOCS_DIR/.sources"
if [ -f "$SOURCE_RECORD" ]; then
  grep -v "^${TARGET_NAME}=" "$SOURCE_RECORD" > "${SOURCE_RECORD}.tmp" 2>/dev/null
  mv "${SOURCE_RECORD}.tmp" "$SOURCE_RECORD"
fi
echo "${TARGET_NAME}=${REL_SOURCE}" >> "$SOURCE_RECORD"

# 从 stdin JSON 中提取 session_id
SESSION_ID=$(echo "$INPUT" | sed -n 's/.*"session_id"\s*:\s*"\([^"]*\)".*/\1/p' | head -1)
SESSION_ID="${SESSION_ID:-unknown}"
TIMESTAMP=$(date +%s%3N 2>/dev/null || python3 -c "import time; print(int(time.time()*1000))" 2>/dev/null || echo "0")

# 通知服务器更新元数据（通过 HTTP API）
curl -s -X POST "http://localhost:8080/api/metadata" \
  -H "Content-Type: application/json" \
  -d "{\"fileName\":\"${TARGET_NAME}\",\"sessionId\":\"${SESSION_ID}\",\"timestamp\":${TIMESTAMP},\"sourcePath\":\"${REL_SOURCE}\"}" \
  > /dev/null 2>&1 || true
