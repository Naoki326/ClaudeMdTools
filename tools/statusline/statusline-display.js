#!/usr/bin/env node
// 从缓存文件读取并格式化 statusline 输出
const fs = require('fs');
const cacheFile = process.argv[2];

try {
  const d = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const model = d.model || '?';
  const ctx = Math.round(d.ctx_pct || 0);
  const cost = (d.cost_usd || 0).toFixed(4);
  const inT = d.in_tokens || 0;
  const outT = d.out_tokens || 0;

  const fmt = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);

  let timeStr = '';
  if (d.ts) {
    const d2 = new Date(d.ts * 1000);
    timeStr = ` @${d2.getHours().toString().padStart(2,'0')}:${d2.getMinutes().toString().padStart(2,'0')}`;
  }

  console.log(`[${model}] ctx:${ctx}% ↑${fmt(inT)} ↓${fmt(outT)} $${cost}${timeStr}`);
} catch (e) {
  process.exit(1);
}
