#!/usr/bin/env node
// 从 statusline stdin 数据更新缓存文件
const fs = require('fs');
const cacheFile = process.argv[2];

let raw = '';
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw);
    const cost = data.cost || {};
    const ctx = data.context_window || {};
    const model = data.model || {};

    const cache = {
      model: model.display_name || model.id || 'unknown',
      ctx_pct: ctx.used_percentage || 0,
      cost_usd: cost.total_cost_usd || 0,
      in_tokens: ctx.total_input_tokens || 0,
      out_tokens: ctx.total_output_tokens || 0,
      session_id: (data.session_id || '').slice(0, 8),
      ts: Math.floor(Date.now() / 1000),
    };

    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  } catch (e) {
    process.exit(1);
  }
});
