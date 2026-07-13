#!/bin/bash
# Run this script once on the server to set up fp.cyberlink.co.in
# Usage: bash server-setup.sh
set -e

DOMAIN="fp.cyberlink.co.in"
REPO_DIR="/opt/fieldpulse"  # change if different

echo "=== Step 1: Pull latest code ==="
cd "$REPO_DIR"
git pull origin main

echo "=== Step 2: Restart Docker containers ==="
docker compose down
docker compose up -d --build

echo "=== Step 3: Install/configure nginx ==="
if ! command -v nginx &>/dev/null; then
    apt-get update -y
    apt-get install -y nginx
fi

cp nginx/fieldpulse.conf /etc/nginx/sites-available/fieldpulse
ln -sf /etc/nginx/sites-available/fieldpulse /etc/nginx/sites-enabled/fieldpulse

# Temp HTTP-only block to allow certbot challenge
cat > /etc/nginx/sites-available/fieldpulse-temp <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    root /var/www/html;
}
EOF
ln -sf /etc/nginx/sites-available/fieldpulse-temp /etc/nginx/sites-enabled/fieldpulse-temp
nginx -t && systemctl reload nginx

echo "=== Step 4: Get SSL certificate ==="
if ! command -v certbot &>/dev/null; then
    apt-get install -y certbot python3-certbot-nginx
fi
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m admin@cyberlink.co.in --redirect

echo "=== Step 5: Remove temp config, install real config ==="
rm /etc/nginx/sites-enabled/fieldpulse-temp
cp nginx/fieldpulse.conf /etc/nginx/sites-available/fieldpulse
nginx -t && systemctl reload nginx

echo ""
echo "=== Done! Test at: https://$DOMAIN ==="
echo "API health: https://$DOMAIN/api/"
