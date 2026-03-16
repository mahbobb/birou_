module.exports = {
  apps: [{
    name: "whatsapp-bot",
    script: "index.js",
    watch: false,
    autorestart: true,
    max_restarts: 15,
    restart_delay: 8000,
    min_uptime: "30s",
    env: {
      NODE_ENV: "production",
    },
    node_args: "--max-old-space-size=512",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "logs/error.log",
    out_file:   "logs/out.log",
    merge_logs: true,
    max_memory_restart: "900M",
  }],
};
