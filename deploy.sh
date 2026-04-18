#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  سكريبت نشر واتساب بوت على Hostinger VPS (Ubuntu 22.04)
#  تشغيل على السيرفر: bash deploy.sh
# ═══════════════════════════════════════════════════════════════

set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()  { echo -e "${GREEN}✅ $1${NC}"; }
warn(){ echo -e "${YELLOW}⚠️  $1${NC}"; }
err() { echo -e "${RED}❌ $1${NC}"; exit 1; }

echo -e "\n${GREEN}══════════════════════════════════════════${NC}"
echo -e "${GREEN}   🤖  نشر واتساب بوت — Hostinger VPS     ${NC}"
echo -e "${GREEN}══════════════════════════════════════════${NC}\n"

# ── 1. تحديث النظام ──────────────────────────────────────────
echo "📦 تحديث النظام..."
apt-get update -qq && apt-get upgrade -y -qq
ok "النظام محدّث"

# ── 2. Node.js 20 ─────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "⚙️  تثبيت Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - -q
  apt-get install -y nodejs -qq
fi
ok "Node.js $(node -v)"

# ── 3. PM2 ───────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2 -q
fi
ok "PM2 $(pm2 -v)"

# ── 4. MySQL ─────────────────────────────────────────────────
if ! command -v mysql &>/dev/null; then
  echo "⚙️  تثبيت MySQL..."
  apt-get install -y mysql-server -qq
  systemctl start mysql && systemctl enable mysql
fi
ok "MySQL جاهز"

# ── 5. مكتبات Chromium (لـ whatsapp-web.js) ──────────────────
echo "⚙️  تثبيت Chromium + مكتباته..."
apt-get install -y -qq chromium-browser \
  gconf-service libasound2 libatk1.0-0 libcairo2 libcups2 \
  libdbus-1-3 libexpat1 libfontconfig1 libgdk-pixbuf2.0-0 \
  libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libstdc++6 \
  libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
  libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 \
  libxss1 libxtst6 ca-certificates fonts-liberation libnss3 \
  libgbm1 wget xdg-utils 2>/dev/null || warn "بعض مكتبات Chromium غير متوفرة — قد يعمل بدونها"
ok "Chromium جاهز"

# ── 6. Nginx ─────────────────────────────────────────────────
if ! command -v nginx &>/dev/null; then
  apt-get install -y nginx -qq
  systemctl enable nginx
fi
ok "Nginx جاهز"

# ── 7. مجلد المشروع ──────────────────────────────────────────
APP_DIR="/var/www/whatsapp-bot"
mkdir -p "$APP_DIR"

echo "📂 نسخ ملفات المشروع..."
rsync -a --exclude='node_modules' --exclude='.git' \
  --exclude='sessions' --exclude='logs' --exclude='.env' \
  --exclude='data/.tokens.json' \
  ./ "$APP_DIR/"
ok "الملفات منسوخة → $APP_DIR"

# ── 8. npm install ────────────────────────────────────────────
cd "$APP_DIR"
echo "📦 تثبيت packages..."
npm install --omit=dev -q
ok "packages جاهزة"

# ── 9. مجلدات الرفع والجلسات ─────────────────────────────────
mkdir -p logs sessions data \
  public/uploads/{images,voices,videos,photos,ids,files}
ok "المجلدات جاهزة"

# ── 10. قاعدة البيانات ───────────────────────────────────────
echo ""
echo -e "${YELLOW}═══ إعداد MySQL ═══${NC}"
read -sp "🔑 كلمة مرور MySQL root (Enter إذا فارغة): " MYSQL_ROOT_PASS
echo ""

DB_NAME="whatsapp_bot"
DB_USER="wabot_user"
DB_PASS=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c20)

MYSQL_CMD="mysql -u root"
[ -n "$MYSQL_ROOT_PASS" ] && MYSQL_CMD="mysql -u root -p${MYSQL_ROOT_PASS}"

$MYSQL_CMD <<SQLEOF 2>/dev/null && ok "قاعدة البيانات جاهزة: $DB_NAME" || warn "مشكلة DB — راجع يدوياً"
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQLEOF

# ── 11. ملف .env ─────────────────────────────────────────────
if [ ! -f "$APP_DIR/.env" ]; then
  echo ""
  echo -e "${YELLOW}═══ إعداد .env ═══${NC}"
  read -p  "🤖 GROQ_API_KEY: " GROQ_KEY
  read -p  "🌐 الدومين (مثل: mybiz.com): " DOMAIN
  read -sp "🔒 كلمة مرور لوحة التحكم: " DASH_PASS
  echo ""

  cat > "$APP_DIR/.env" <<EOF
# ── AI ────────────────────────────────────────
AI_PROVIDER=groq
GROQ_API_KEY=${GROQ_KEY}
GROQ_MODEL=llama-3.3-70b-versatile

# ── شخصية البوت ──────────────────────────────
BOT_NAME=Assistant
BOT_PERSONALITY=مساعد ذكي للرد على العملاء
BOT_LANGUAGE=الدارجة المغربية

# ── الردود ───────────────────────────────────
RESPONSE_DELAY_MIN=1000
RESPONSE_DELAY_MAX=3000
RESPOND_TO_PRIVATE=true
RESPOND_TO_GROUPS=false

# ── MySQL ─────────────────────────────────────
DB_HOST=localhost
DB_PORT=3306
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASS}
DB_NAME=${DB_NAME}

# ── لوحة التحكم ──────────────────────────────
DASHBOARD_PASSWORD=${DASH_PASS:-admin123}
PORT=3000

# ── SSL — فعّل بعد certbot ────────────────────
# SSL_CERT=/etc/letsencrypt/live/${DOMAIN}/fullchain.pem
# SSL_KEY=/etc/letsencrypt/live/${DOMAIN}/privkey.pem
EOF
  chmod 600 "$APP_DIR/.env"
  ok "ملف .env تم إنشاؤه"
  echo -e "  ${YELLOW}DB_USER: $DB_USER${NC}"
  echo -e "  ${YELLOW}DB_PASS: $DB_PASS  ← احتفظ بها!${NC}"
else
  ok ".env موجود"
fi

DOMAIN=${DOMAIN:-$(grep -o 'letsencrypt/live/[^/]*' "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d/ -f3 || echo "localhost")}

# ── 12. Nginx config ─────────────────────────────────────────
cat > /etc/nginx/sites-available/whatsapp-bot <<EOF
server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN};
    client_max_body_size 70M;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }

    location /uploads/ {
        alias /var/www/whatsapp-bot/public/uploads/;
        expires 7d;
    }
}
EOF
ln -sf /etc/nginx/sites-available/whatsapp-bot /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
ok "Nginx مُعدّ"

# ── 13. SSL مع Certbot ────────────────────────────────────────
if [[ "$DOMAIN" != "localhost" && "$DOMAIN" != "" ]]; then
  apt-get install -y certbot python3-certbot-nginx -qq 2>/dev/null
  read -p "📧 البريد الإلكتروني لـ SSL (Enter للتخطي): " SSL_EMAIL
  if [ -n "$SSL_EMAIL" ]; then
    certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" \
      --non-interactive --agree-tos --email "$SSL_EMAIL" 2>/dev/null \
      && ok "SSL مفعَّل ✨" \
      || warn "SSL فشل — تأكد أن DNS يشير لهذا IP ثم شغّل: certbot --nginx -d $DOMAIN"
    # فعّل SSL في .env
    sed -i "s|# SSL_CERT=|SSL_CERT=|" "$APP_DIR/.env"
    sed -i "s|# SSL_KEY=|SSL_KEY=|"   "$APP_DIR/.env"
  fi
fi

# ── 14. PM2 ──────────────────────────────────────────────────
cd "$APP_DIR"
pm2 delete whatsapp-bot 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null | grep "^sudo" | bash 2>/dev/null || true
ok "البوت يعمل مع PM2"

# ── النتيجة ───────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo -e "${GREEN}   🎉  تم النشر بنجاح!                      ${NC}"
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo ""
[ "$DOMAIN" != "localhost" ] && PROTO="https" || PROTO="http"
echo "  🌐  الموقع:       $PROTO://$DOMAIN"
echo "  📊  لوحة التحكم:  $PROTO://$DOMAIN/dashboard"
echo "  📱  QR Code:      $PROTO://$DOMAIN/qr"
echo "  💬  user-reply:   $PROTO://$DOMAIN/user-reply"
echo ""
echo "  📋  أوامر مفيدة:"
echo "      pm2 logs whatsapp-bot     ← متابعة السجل"
echo "      pm2 restart whatsapp-bot  ← إعادة تشغيل"
echo "      pm2 status                ← حالة البوت"
echo "      pm2 monit                 ← مراقبة الموارد"
echo ""
