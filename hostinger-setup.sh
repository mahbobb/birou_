#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Hostinger VPS — إعداد تلقائي كامل
#  الاستخدام: bash hostinger-setup.sh
# ═══════════════════════════════════════════════════════════════
set -e

APP_DIR="/root/whatsapp-bot"
NODE_VERSION="20"

echo "═══════════════════════════════════════"
echo "  إعداد WhatsApp Bot — Hostinger VPS"
echo "═══════════════════════════════════════"

# ── 1. تحديث النظام ────────────────────────────────────────────
echo "[1/8] تحديث النظام..."
apt-get update -qq && apt-get upgrade -y -qq

# ── 2. تثبيت Node.js ───────────────────────────────────────────
echo "[2/8] تثبيت Node.js $NODE_VERSION..."
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
apt-get install -y nodejs
node --version && npm --version

# ── 3. تثبيت Chromium + مكتبات Puppeteer ──────────────────────
echo "[3/8] تثبيت Chromium..."
apt-get install -y -qq \
  chromium-browser \
  ca-certificates \
  fonts-liberation \
  libappindicator3-1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libc6 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libexpat1 \
  libfontconfig1 \
  libgbm1 \
  libgcc1 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  libstdc++6 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxi6 \
  libxrandr2 \
  libxrender1 \
  libxss1 \
  libxtst6 \
  lsb-release \
  wget \
  xdg-utils 2>/dev/null || true

# ── 4. تثبيت MySQL ─────────────────────────────────────────────
echo "[4/8] تثبيت MySQL..."
apt-get install -y mysql-server
systemctl enable mysql
systemctl start mysql

# ── 5. تثبيت PM2 ───────────────────────────────────────────────
echo "[5/8] تثبيت PM2..."
npm install -g pm2
pm2 startup systemd -u root --hp /root
systemctl enable pm2-root 2>/dev/null || true

# ── 6. استنساخ المشروع من GitHub ──────────────────────────────
echo "[6/8] استنساخ المشروع من GitHub..."
apt-get install -y git 2>/dev/null || true

REPO="https://github.com/mahbobb/birou_.git"

if [ -d "$APP_DIR/.git" ]; then
  echo "  → المشروع موجود — git pull..."
  cd "$APP_DIR" && git pull origin main
else
  git clone "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

mkdir -p "$APP_DIR/logs"
mkdir -p "$APP_DIR/public/uploads/images"
mkdir -p "$APP_DIR/public/uploads/voices"
mkdir -p "$APP_DIR/public/uploads/videos"
mkdir -p "$APP_DIR/sessions"

npm install --omit=dev --silent
echo "  → node_modules مثبّتة"

# ── 7. إعداد MySQL ─────────────────────────────────────────────
echo "[7/8] إعداد قاعدة البيانات..."

# اقرأ بيانات .env إذا موجودة
if [ -f "$APP_DIR/.env" ]; then
  DB_USER=$(grep "^DB_USER=" "$APP_DIR/.env" | cut -d= -f2)
  DB_PASSWORD=$(grep "^DB_PASSWORD=" "$APP_DIR/.env" | cut -d= -f2)
  DB_NAME=$(grep "^DB_NAME=" "$APP_DIR/.env" | cut -d= -f2)
else
  DB_USER="whatsapp_user"
  DB_PASSWORD="$(openssl rand -base64 16)"
  DB_NAME="whatsapp_bot"
  echo "⚠️  لم يوجد .env — استخدام قيم افتراضية"
  echo "    DB_USER=$DB_USER"
  echo "    DB_PASSWORD=$DB_PASSWORD"
  echo "    DB_NAME=$DB_NAME"
fi

mysql -u root << MYSQL_EOF
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
MYSQL_EOF

echo "✅ قاعدة البيانات جاهزة"

# ── 8. تشغيل التطبيق ───────────────────────────────────────────
echo "[8/8] تشغيل التطبيق..."
cd "$APP_DIR"
if [ -f "package.json" ]; then
  npm install --omit=dev
  pm2 start ecosystem.config.js
  pm2 save
  echo ""
  echo "✅ التطبيق يعمل!"
  pm2 status
else
  echo "⚠️  ارفع ملفات المشروع إلى $APP_DIR أولاً ثم شغّل:"
  echo "    cd $APP_DIR && npm install --omit=dev && pm2 start ecosystem.config.js && pm2 save"
fi

echo ""
echo "═══════════════════════════════════════"
echo "  الإعداد اكتمل!"
echo "  الخطوات التالية:"
echo "  1. أنشئ .env:    nano $APP_DIR/.env"
echo "  2. شغّل البوت:   pm2 restart whatsapp-bot"
echo "  3. اعرض الـLogs:  pm2 logs whatsapp-bot"
echo "  4. نشر التحديثات: bash deploy.sh SERVER_IP"
echo "═══════════════════════════════════════"
