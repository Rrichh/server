#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# WattLab — setup VPS production (Ubuntu 22.04/24.04)
# Esegui UNA VOLTA sul VPS appena creato, come root:
#   curl -fsSL <url> | bash     oppure     bash setup-vps.sh
#
# Cosa fa:
#  1. Aggiorna il sistema
#  2. Firewall (ufw): solo SSH, HTTP, HTTPS
#  3. fail2ban: blocca brute-force SSH
#  4. Aggiornamenti di sicurezza automatici
#  5. Docker + Docker Compose
#  6. Crea /opt/wattlab con la struttura per il deploy
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Esegui come root (o con sudo)"; exit 1
fi

echo "▸ [1/8] Aggiornamento sistema…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get upgrade -y -qq

echo "▸ [2/8] Firewall (ufw)…"
apt-get install -y -qq ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp   # HTTP/3
ufw --force enable

echo "▸ [3/8] fail2ban (anti brute-force SSH)…"
apt-get install -y -qq fail2ban
cat > /etc/fail2ban/jail.local <<'EOF'
[sshd]
enabled = true
maxretry = 5
bantime = 1h
findtime = 10m
EOF
systemctl enable --now fail2ban

echo "▸ [4/8] Aggiornamenti di sicurezza automatici…"
apt-get install -y -qq unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "▸ [5/8] Hardening SSH…"
# Key-only: niente password auth (immune al brute-force), niente root con password
cat > /etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
LoginGraceTime 20
X11Forwarding no
AllowTcpForwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
systemctl restart ssh || systemctl restart sshd

echo "▸ [6/8] Hardening kernel (sysctl)…"
cat > /etc/sysctl.d/99-wattlab-hardening.conf <<'EOF'
# Anti IP-spoofing
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
# Ignora ICMP redirect (MITM)
net.ipv4.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
# No source-routed packets
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
# SYN-flood protection
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 2048
# Log pacchetti marziani
net.ipv4.conf.all.log_martians = 1
# ASLR completo
kernel.randomize_va_space = 2
# Restrizione accesso dmesg/kptr
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2
EOF
sysctl --system >/dev/null

echo "▸ [7/8] Docker…"
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "▸ [8/8] Struttura /opt/wattlab…"
mkdir -p /opt/wattlab/{site,backups,scripts}
chmod 750 /opt/wattlab

echo ""
echo "══════════════════════════════════════════════════"
echo "  ✓ VPS pronto."
echo ""
echo "  Prossimi passi (dal TUO PC):"
echo "   1. Copia i file di deploy sul VPS:"
echo "      scp -r deploy/* root@IP_DEL_VPS:/opt/wattlab/"
echo "      scp -r ../wattlab-server root@IP_DEL_VPS:/opt/wattlab/server"
echo "      scp index.html root@IP_DEL_VPS:/opt/wattlab/site/"
echo "   2. Sul VPS: cd /opt/wattlab && cp .env.production.example .env"
echo "      poi compila .env (nano .env)"
echo "   3. Sul VPS: docker compose up -d --build"
echo "══════════════════════════════════════════════════"
