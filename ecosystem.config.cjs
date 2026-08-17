// PM2 进程配置 —— 源码模式专用（npm 安装版直接 `pm2 start lanbook`，无需本文件）
// 详见 DEPLOY.md「源码模式」一节。
module.exports = {
  apps: [
    {
      name: 'lanbook',
      script: 'server.js',
      cwd: __dirname,
      // 崩溃后自动重启
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      // 内存超 1G 重启（chokidar 全盘 watch 知识库/课程 roots，常驻 400MB+；200M 阈值会误杀导致重启循环）
      max_memory_restart: '1G',
      // 重启间隔：给被杀进程的 TCP 端口留出释放时间，避免 EADDRINUSE 竞态
      restart_delay: 5000,
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
