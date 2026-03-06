#!/bin/bash
# ══════════════════════════════════════════════════════════════════
#  سكريبت تثبيت WhatsApp Bot على Hostinger VPS (Ubuntu 22.04)
# ══════════════════════════════════════════════════════════════════
set -e

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✔]${NC} $1"; }
warn()  { echo -e "${YELLOW}[⚠]${NC} $1"; }
error() { echo -e "${RED}[✘]${NC} $1"; exit 1; }

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     WhatsApp Bot — VPS Setup Script      ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. تحديث النظام ──────────────────────────────────────────────
info "تحديث النظام..."
apt-get update -qq && apt-get upgrade -y -qq

# ── 2. تثبيت Node.js 20 ──────────────────────────────────────────
if ! command -v node &>/dev/null; then
  info "تثبيت Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  info "Node.js موجود: $(node -v)"
fi

# ── 3. تثبيت PM2 ─────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  info "تثبيت PM2..."
  npm install -g pm2
else
  info "PM2 موجود: $(pm2 -v)"
fi

# ── 4. تثبيت MySQL ───────────────────────────────────────────────
if ! command -v mysql &>/dev/null; then
  info "تثبيت MySQL..."
  apt-get install -y mysql-server
  systemctl enable mysql
  systemctl start mysql
else
  info "MySQL موجود"
fi

# ── 5. تثبيت مكتبات Chromium (لـ whatsapp-web.js) ───────────────
info "تثبيت مكتبات Chromium..."
apt-get install -y -qq \
  gconf-service libgbm-dev libasound2 libatk1.0-0 libatk-bridge2.0-0 \
  libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 \
  libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 \
  libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 \
  libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
  libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
  ca-certificates fonts-liberation libnss3 lsb-release xdg-utils wget \
  chromium-browser 2>/dev/null || true

# ── 6. إعداد MySQL ───────────────────────────────────────────────
info "إعداد قاعدة بيانات MySQL..."
read -p "كلمة مرور MySQL الجذر (root): " -s MYSQL_ROOT_PASS; echo ""
read -p "كلمة مرور مستخدم whatsapp_user: " -s DB_PASS; echo ""

mysql -uroot -p"$MYSQL_ROOT_PASS" <<SQL 2>/dev/null || warn "قاعدة البيانات موجودة مسبقاً"
CREATE DATABASE IF NOT EXISTS whatsapp_bot CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'whatsapp_user'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON whatsapp_bot.* TO 'whatsapp_user'@'localhost';
FLUSH PRIVILEGES;
SQL
info "قاعدة البيانات جاهزة"

# ── 7. تثبيت packages Node ───────────────────────────────────────
info "تثبيت packages..."
npm install --production

# ── 8. إنشاء مجلدات ──────────────────────────────────────────────
info "إنشاء المجلدات..."
mkdir -p logs public/uploads/{images,videos,voices,files} session

# ── 9. إنشاء ملف .env ────────────────────────────────────────────
if [ ! -f .env ]; then
  info "إنشاء ملف .env..."
  cp .env.example .env
  # تعبئة كلمة المرور تلقائياً
  sed -i "s/your_strong_password_here/${DB_PASS}/" .env
  warn "⚠️  افتح .env وعدّل: GROQ_API_KEY و DASHBOARD_PASSWORD"
else
  warn ".env موجود مسبقاً — لم يُعدَّل"
fi

# ── 10. إضافة PM2 لبدء التشغيل التلقائي ─────────────────────────
info "إعداد PM2 للبدء التلقائي..."
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║          التثبيت اكتمل بنجاح!           ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  الخطوات التالية:"
echo "  1. عدّل .env: nano .env"
echo "     - GROQ_API_KEY"
echo "     - DASHBOARD_PASSWORD"
echo ""
echo "  2. شغّل البوت:"
echo "     pm2 start ecosystem.config.js"
echo "     pm2 save"
echo ""
echo "  3. امسح QR code بواتساب ثم اكتب:"
echo "     pm2 logs whatsapp-bot"
echo ""
echo "  4. افتح الداشبورد على:"
echo "     http://YOUR_VPS_IP:3000"
echo ""
echo "  5. للـ HTTPS (تسجيل صوتي من الإنترنت):"
echo "     bash nginx-setup.sh yourdomain.com"
echo ""
