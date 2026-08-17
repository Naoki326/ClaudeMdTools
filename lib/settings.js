'use strict';
// 服务配置（CONTEXT.md「服务配置」，ADR-0003）：
// 数据目录下 settings.json，可选字段 port / host，与知识库 / 课程两个内容配置并列。
// 生效优先级：PORT 环境变量 > settings > 内置默认 8080 / 0.0.0.0；
// 文件不存在、缺字段、值非法一律静默回落默认（不报错、不写文件）。
// 改动重启后生效；网页 ⚙ 配置对话框不暴露这两项。
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE_NAME = 'settings.json';
const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '0.0.0.0';

// 端口必须是 1–65535 的整数形式（数字或纯数字字符串），否则视为未配置
function parsePort(value) {
  const n = typeof value === 'string' ? /^\d+$/.test(value.trim()) ? parseInt(value.trim(), 10) : NaN : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

// host 必须是非空字符串；无效值视为未配置
function parseHost(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v ? v : null;
}

function readSettingsFile(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, SETTINGS_FILE_NAME), 'utf-8'));
  } catch {
    return {}; // 文件不存在 / JSON 损坏 → 回落默认，不报错
  }
}

// 解析监听端口与地址（优先级：环境变量 > settings > 内置默认）
function resolveListen(dataDir, env = process.env) {
  const settings = readSettingsFile(dataDir);
  const port = parsePort(env.PORT) ?? parsePort(settings.port) ?? DEFAULT_PORT;
  const host = parseHost(settings.host) ?? DEFAULT_HOST;
  return { port, host };
}

module.exports = { SETTINGS_FILE_NAME, DEFAULT_PORT, DEFAULT_HOST, resolveListen };
