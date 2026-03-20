#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  إصلاح وضبط المشروع على VPS Hostinger
#  الاستخدام: bash fix-vps.sh
# ═══════════════════════════════════════════════════════════════
set -e

APP_DIR="/root/whatsapp-bot"
REPO="https://github.com/mahbobb/birou_.git"
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
err()  { echo -e "${RED}❌ $1${NC}"; }

echo "══════════════════════════════════════════"
echo "  إصلاح WhatsApp Bot — Hostinger VPS"
echo "══════════════════════════════════════════"

# ── 1. تحديث الكود من GitHub ────────────────────────────────
echo ""
echo "[1/6] تحديث الكود من GitHub..."
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR"
  git fetch origin
  git reset --hard origin/main
  ok "تم تحديث الكود (git reset --hard origin/main)"
else
  warn "المشروع غير موجود — جاري الاستنساخ..."
  git clone "$REPO" "$APP_DIR"
  cd "$APP_DIR"
  ok "تم استنساخ المشروع"
fi

cd "$APP_DIR"

# ── 2. إنشاء مجلدات ضرورية ──────────────────────────────────
echo ""
echo "[2/6] إنشاء المجلدات..."
mkdir -p public/uploads/images \
         public/uploads/voices \
         public/uploads/videos \
         logs \
         sessions \
         data
ok "المجلدات جاهزة"

# ── 3. فحص ملف .env ─────────────────────────────────────────
echo ""
echo "[3/6] فحص ملف .env..."
if [ ! -f "$APP_DIR/.env" ]; then
  warn ".env غير موجود — جاري الإنشاء..."

  echo ""
  echo "── أدخل بيانات الإعداد ──"

  read -p "🔑 GROQ_API_KEY (من console.groq.com): " GROQ_KEY
  read -p "🔐 كلمة مرور لوحة التحكم (DASHBOARD_PASSWORD): " DASH_PASS
  read -p "📞 رقم واتساب المالك لاستلام رسائل الموقع (OWNER_PHONE مثال: 212XXXXXXXXX): " OWNER_PH
  read -p "🗄️  كلمة مرور MySQL (DB_PASSWORD): " DB_PASS

  cat > "$APP_DIR/.env" << ENVEOF
AI_PROVIDER=groq
GROQ_API_KEY=${GROQ_KEY}
GROQ_MODEL=llama-3.3-70b-versatile

BOT_NAME=Assistant
BOT_PERSONALITY=نت مساعد سمير، صاحب شقق مفروشة للكراء اليومي فمراكش. الأثمنة من 200 لـ 600 درهم للليلة. للتواصل: 0680040002.
BOT_LANGUAGE=الدارجة المغربية

RESPONSE_DELAY_MIN=1000
RESPONSE_DELAY_MAX=3000
RESPOND_TO_PRIVATE=true
RESPOND_TO_GROUPS=false
IGNORED_NUMBERS=
PAUSE_KEYWORD=!pause
RESUME_KEYWORD=!resume

DB_HOST=localhost
DB_PORT=3306
DB_USER=whatsapp_user
DB_PASSWORD=${DB_PASS}
DB_NAME=whatsapp_bot

DASHBOARD_PASSWORD=${DASH_PASS}
PORT=3000

OWNER_PHONE=${OWNER_PH}
ENVEOF
  ok ".env تم إنشاؤه"
else
  ok ".env موجود"
  # تأكد من وجود OWNER_PHONE
  if ! grep -q "OWNER_PHONE" "$APP_DIR/.env"; then
    read -p "📞 أضف رقم واتساب المالك (OWNER_PHONE مثال: 212XXXXXXXXX): " OWNER_PH
    echo "OWNER_PHONE=${OWNER_PH}" >> "$APP_DIR/.env"
    ok "تم إضافة OWNER_PHONE"
  fi
fi

# ── 4. تثبيت الحزم ──────────────────────────────────────────
echo ""
echo "[4/6] تثبيت حزم npm..."
npm install --omit=dev --silent
ok "npm install تم"

# ── 5. إعداد MySQL ──────────────────────────────────────────
echo ""
echo "[5/6] إعداد قاعدة البيانات..."
source "$APP_DIR/.env" 2>/dev/null || true
DB_USER="${DB_USER:-whatsapp_user}"
DB_PASSWORD="${DB_PASSWORD:-password123}"
DB_NAME="${DB_NAME:-whatsapp_bot}"

if command -v mysql &>/dev/null; then
  mysql -u root --connect-timeout=5 << SQLEOF 2>/dev/null || warn "MySQL: تحقق من كلمة المرور يدوياً"
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQLEOF

  # تشغيل سكريبت إنشاء الجداول
  if [ -f "setup-db.js" ]; then
    node setup-db.js && ok "الجداول جاهزة" || warn "تحقق من setup-db.js يدوياً"
  fi
  ok "MySQL جاهز"
else
  warn "MySQL غير مثبت — شغّل: apt-get install -y mysql-server"
fi

# ── 6. إعادة تشغيل PM2 ──────────────────────────────────────
echo ""
echo "[6/6] إعادة تشغيل PM2..."
if ! command -v pm2 &>/dev/null; then
  warn "PM2 غير مثبت — جاري التثبيت..."
  npm install -g pm2
  pm2 startup systemd -u root --hp /root 2>/dev/null || true
fi

if pm2 list 2>/dev/null | grep -q "whatsapp-bot"; then
  pm2 restart whatsapp-bot
  ok "PM2 تم إعادة التشغيل"
else
  pm2 start ecosystem.config.js
  ok "PM2 تم التشغيل"
fi

pm2 save --force
ok "PM2 save تم"

# ── ملخص ────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════"
echo "  ✅ الإصلاح اكتمل!"
echo "══════════════════════════════════════════"
echo ""
pm2 status
echo ""
echo "📋 الأوامر المفيدة:"
echo "  pm2 logs whatsapp-bot     ← عرض الـ logs"
echo "  pm2 restart whatsapp-bot  ← إعادة التشغيل"
echo "  cat /root/whatsapp-bot/.env ← عرض الإعدادات"
echo ""
PORT_VAL=$(grep "^PORT=" "$APP_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "3000")
IP_ADDR=$(hostname -I | awk '{print $1}')
echo "🌐 الرابط: http://${IP_ADDR}:${PORT_VAL}"
echo ""
