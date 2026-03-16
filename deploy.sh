#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  نشر المشروع على Hostinger VPS عبر Git
#  الاستخدام: bash deploy.sh YOUR_SERVER_IP
# ═══════════════════════════════════════════════════════════════

SERVER_IP="${1:-YOUR_SERVER_IP}"
SERVER_USER="root"
APP_DIR="/root/whatsapp-bot"
REPO="https://github.com/mahbobb/birou_.git"

if [ "$SERVER_IP" = "YOUR_SERVER_IP" ]; then
  echo "❌ مثال الاستخدام: bash deploy.sh 123.456.789.0"
  exit 1
fi

echo "🚀 نشر إلى $SERVER_USER@$SERVER_IP..."

ssh "$SERVER_USER@$SERVER_IP" bash << REMOTE
  set -e
  echo "─── git pull ───"
  if [ -d "$APP_DIR/.git" ]; then
    cd "$APP_DIR"
    git pull origin main
  else
    git clone "$REPO" "$APP_DIR"
    cd "$APP_DIR"
  fi

  echo "─── npm install ───"
  npm install --omit=dev --silent

  echo "─── إنشاء مجلدات الـ uploads ───"
  mkdir -p public/uploads/images public/uploads/voices public/uploads/videos logs sessions

  echo "─── إعادة تشغيل PM2 ───"
  if pm2 list | grep -q "whatsapp-bot"; then
    pm2 restart whatsapp-bot
  else
    pm2 start ecosystem.config.js
  fi
  pm2 save

  echo ""
  pm2 status
  echo "✅ تم النشر!"
REMOTE
