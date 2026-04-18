#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  إعداد واتساب بوت على Hostinger VPS (OpenLiteSpeed)
#  تشغيل: bash vps-setup.sh
# ═══════════════════════════════════════════════════════════════

set -e
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()  { echo -e "${GREEN}✅ $1${NC}"; }
warn(){ echo -e "${YELLOW}⚠️  $1${NC}"; }

APP_DIR="/root/whatsapp-bot"
DOMAIN="abraje.uno"
PORT=3000

echo -e "\n${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  🤖  إعداد واتساب بوت — abraje.uno        ${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}\n"

cd "$APP_DIR"

# ── 1. Node.js ───────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "⚙️  تثبيت Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs -qq
fi
ok "Node.js $(node -v)"

# ── 2. PM2 ───────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2 -q
fi
ok "PM2 $(pm2 -v)"

# ── 3. مكتبات Chromium ───────────────────────────────────────
echo "⚙️  تثبيت مكتبات Chromium..."
apt-get update -qq
apt-get install -y -qq chromium-browser \
  libasound2 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 \
  libfontconfig1 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 \
  libnspr4 libpango-1.0-0 libstdc++6 libx11-6 libx11-xcb1 \
  libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 \
  libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
  libnss3 libgbm1 xdg-utils fonts-liberation 2>/dev/null \
  || warn "بعض مكتبات Chromium غير متوفرة"
ok "Chromium جاهز"

# ── 4. MySQL / MariaDB ───────────────────────────────────────
if ! command -v mysql &>/dev/null; then
  echo "⚙️  تثبيت MariaDB..."
  apt-get install -y mariadb-server mariadb-client -qq
  systemctl start mariadb && systemctl enable mariadb
fi
ok "MySQL/MariaDB جاهز"

# ── 5. إنشاء قاعدة البيانات ──────────────────────────────────
DB_NAME="whatsapp_bot"
DB_USER="wabot"
DB_PASS="Wabot@2026Secure"

mysql -u root <<SQLEOF 2>/dev/null || warn "DB ربما موجودة مسبقاً"
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQLEOF
ok "قاعدة البيانات: $DB_NAME"

# ── 6. ملف .env ───────────────────────────────────────────────
cat > "$APP_DIR/.env" <<'EOF'
# ── AI ────────────────────────────────────────
AI_PROVIDER=groq
GROQ_API_KEY=YOUR_GROQ_API_KEY_HERE
GROQ_MODEL=llama-3.3-70b-versatile

# ── البوتات ───────────────────────────────────
BOTS_ENABLED=bot1,bot2,bot3
ALLOWED_ORIGINS=https://abraje.uno,https://www.abraje.uno

# ── شخصية البوت ──────────────────────────────
BOT_NAME=Assistant
BOT_PERSONALITY=نت مساعد سمير، صاحب شقق مفروشة للكراء اليومي فمراكش (محاميد، جليز، علال الفاسي، باب دكالة). الأثمنة من 200 لـ 600 درهم للليلة. للتواصل: 0680040002.
BOT_LANGUAGE=الدارجة المغربية

# ── إعدادات الردود ───────────────────────────
RESPONSE_DELAY_MIN=1000
RESPONSE_DELAY_MAX=3000
RESPOND_TO_PRIVATE=true
RESPOND_TO_GROUPS=false
IGNORED_NUMBERS=

# ── MySQL ─────────────────────────────────────
DB_HOST=localhost
DB_PORT=3306
DB_USER=wabot
DB_PASSWORD=Wabot@2026Secure
DB_NAME=whatsapp_bot

# ── لوحة التحكم ──────────────────────────────
DASHBOARD_PASSWORD=admin2026
PORT=3000

# ── SSL — Let's Encrypt ───────────────────────
SSL_CERT=/etc/letsencrypt/live/abraje.uno/fullchain.pem
SSL_KEY=/etc/letsencrypt/live/abraje.uno/privkey.pem
EOF
chmod 600 "$APP_DIR/.env"
ok "ملف .env جاهز"

# ── 7. npm install ────────────────────────────────────────────
echo "📦 تثبيت packages..."
npm install --omit=dev -q
ok "packages جاهزة"

# ── 8. مجلدات الرفع ─────────────────────────────────────────
mkdir -p logs sessions data \
  public/uploads/{images,voices,videos,photos,ids,files}
ok "مجلدات جاهزة"

# ── 9. إعداد OpenLiteSpeed Reverse Proxy ─────────────────────
OLS_VHOST_DIR="/usr/local/lsws/conf/vhosts/$DOMAIN"
OLS_CONF="$OLS_VHOST_DIR/vhconf.conf"

if [ -d "/usr/local/lsws" ]; then
  mkdir -p "$OLS_VHOST_DIR"

  cat > "$OLS_CONF" <<OLSEOF
docRoot                   \$VH_ROOT/html/
vhDomain                  $DOMAIN
adminEmails               root@localhost
enableGzip                1
enableBr                  1

extProcessor wabot {
  type                    proxy
  address                 127.0.0.1:$PORT
  maxConns                100
  pcKeepAliveTimeout      60
  initTimeout             60
  retryTimeout            0
  respBuffer              0
}

context / {
  type                    proxy
  handler                 wabot
  addDefaultCharset       off
}

rewrite  {
  enable                  1
  logLevel                0
}
OLSEOF

  # إضافة Virtual Host للـ listener إذا لم يكن موجوداً
  OLS_MAIN_CONF="/usr/local/lsws/conf/httpd_config.conf"
  if [ -f "$OLS_MAIN_CONF" ] && ! grep -q "$DOMAIN" "$OLS_MAIN_CONF"; then
    cat >> "$OLS_MAIN_CONF" <<MAINEOF

virtualhost $DOMAIN {
  vhRoot                  /usr/local/lsws/conf/vhosts/$DOMAIN/
  configFile              \$SERVER_ROOT/conf/vhosts/$DOMAIN/vhconf.conf
  allowSymbolLink         1
  enableScript            1
  restrained              0
}
MAINEOF
  fi

  # إعادة تشغيل OLS
  /usr/local/lsws/bin/lswsctrl restart 2>/dev/null \
    && ok "OpenLiteSpeed أعيد تشغيله" \
    || warn "أعد تشغيل OLS يدوياً: /usr/local/lsws/bin/lswsctrl restart"
else
  warn "OpenLiteSpeed غير موجود — تخطي إعداد OLS"
fi

# ── 10. SSL ───────────────────────────────────────────────────
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  apt-get install -y certbot -qq 2>/dev/null
  systemctl stop lsws 2>/dev/null || true
  certbot certonly --standalone -d "$DOMAIN" -d "www.$DOMAIN" \
    --non-interactive --agree-tos --email "abrajeimmo.web@gmail.com" \
    --preferred-challenges http 2>/dev/null \
    && ok "SSL جاهز ✨" \
    || warn "SSL فشل — DNS قد لا يكون جاهزاً بعد. شغّل: certbot certonly --standalone -d $DOMAIN"
  systemctl start lsws 2>/dev/null || /usr/local/lsws/bin/lswsctrl start 2>/dev/null || true
else
  ok "SSL موجود مسبقاً"
fi

# ── 11. PM2 start ─────────────────────────────────────────────
pm2 delete whatsapp-bot 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null | grep "^sudo\|^env" | bash 2>/dev/null || true
ok "البوت يعمل مع PM2"

# ── النتيجة ───────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  🎉  تم الإعداد!                           ${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""
echo "  📱  QR Code:       https://abraje.uno/qr"
echo "  📊  لوحة التحكم:   https://abraje.uno/dashboard"
echo "  💬  ردود اليوزر:   https://abraje.uno/user-reply"
echo ""
echo "  كلمة مرور لوحة التحكم: admin2026"
echo "  DB Password: Wabot@2026Secure"
echo ""
echo "  pm2 logs whatsapp-bot   ← لمشاهدة QR Code"
echo ""
