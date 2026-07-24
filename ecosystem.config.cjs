module.exports = {
  apps: [
    {
      name: 'claudemd',
      script: 'server.js',
      cwd: __dirname,
      // 崩溃后自动重启
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      // 内存超 200MB 重启（防内存泄漏）
      max_memory_restart: '200M',
      // 日志
      out_file: './logs/out.log',
      error_file: './logs/err.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 8091,
      },
    },
  ],
};
