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
      // 内存超 1G 重启（chokidar 全盘 watch 知识库/课程 roots，常驻 400MB+；200M 阈值会误杀导致重启循环）
      max_memory_restart: '1G',
      // 日志
      out_file: './logs/out.log',
      error_file: './logs/err.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 30142,
      },
    },
  ],
};
