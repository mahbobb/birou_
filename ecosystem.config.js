module.exports = {
  apps: [{
    name: "whatsapp-bot",
    script: "index.js",
    watch: false,
    autorestart: true,
    max_restarts: 20,
    restart_delay: 8000,
    min_uptime: "30s",
    exp_backoff_restart_delay: 100,
    env: {
      NODE_ENV: "production",
      UV_THREADPOOL_SIZE: "8",
    },
    node_args: "--max-old-space-size=768 --optimize-for-size",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "logs/error.log",
    out_file:   "logs/out.log",
    merge_logs: true,
    max_memory_restart: "1200M",
    kill_timeout: 5000,
    listen_timeout: 10000,

    // ─── Hostinger VPS: تجاهل SIGINT ──────────────────
    kill_retry_time: 3000,
    shutdown_with_message: false,
  }],
};
