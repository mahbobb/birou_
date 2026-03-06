#!/bin/bash
# ══════════════════════════════════════════════════════════════════
#  إعداد Nginx + SSL (Let's Encrypt) للداشبورد
#  الاستخدام: bash nginx-setup.sh yourdomain.com
# ══════════════════════════════════════════════════════════════════
set -e

DOMAIN=$1
[ -z "$DOMAIN" ] && { echo "الاستخدام: bash nginx-setup.sh yourdomain.com"; exit 1; }

GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}[✔]${NC} $1"; }

# ── تثبيت Nginx و Certbot ─────────────────────────────────────────
info "تثبيت Nginx و Certbot..."
apt-get install -y nginx certbot python3-certbot-nginx

# ── إعداد Nginx ───────────────────────────────────────────────────
info "إعداد Nginx للدومين: $DOMAIN"
cat > /etc/nginx/sites-available/whatsapp-bot <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    # حد رفع الملفات (للصور والفيديوهات)
    client_max_body_size 50M;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/whatsapp-bot /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
info "Nginx يعمل"

# ── SSL مجاني من Let's Encrypt ────────────────────────────────────
info "إصدار شهادة SSL لـ $DOMAIN ..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@${DOMAIN}" --redirect

info "✅ الداشبورد متاح الآن على: https://${DOMAIN}"
info "🎤 تسجيل الصوت سيعمل من أي جهاز (HTTPS)"
