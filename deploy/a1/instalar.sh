#!/usr/bin/env bash
# Instala o LiveKit próprio (voz, câmera e tela do Concord) numa máquina Oracle A1 com Ubuntu 24.04 ARM.
# Uso (na A1, como usuário normal com sudo):   bash instalar.sh <dominio> <ip-publico>
#   ex.:  bash instalar.sh concord-voz.duckdns.org 129.151.0.10
# Pode rodar de novo sem estragar nada (idempotente): não troca as chaves se elas já existem.
# Tudo grátis: LiveKit e Caddy são software livre; nada aqui cria recurso pago.
set -euo pipefail

LIVEKIT_VERSION="1.13.11"   # a mesma versão do README principal
DOMINIO="${1:-}"
IP_PUBLICO="${2:-}"
AQUI="$(cd "$(dirname "$0")" && pwd)"

[ -n "$DOMINIO" ] && [ -n "$IP_PUBLICO" ] || { echo "Uso: bash instalar.sh <dominio> <ip-publico>"; exit 1; }
[[ "$DOMINIO" =~ ^[a-zA-Z0-9.-]+$ ]] || { echo "Domínio inválido: $DOMINIO"; exit 1; }
[[ "$IP_PUBLICO" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "IP inválido: $IP_PUBLICO"; exit 1; }
[ "$(uname -m)" = "aarch64" ] || { echo "Esta máquina não é ARM64 (aarch64). Os arquivos baixados seriam os errados."; exit 1; }
for f in Caddyfile livekit.yaml livekit.service; do [ -f "$AQUI/$f" ] || { echo "Falta $AQUI/$f"; exit 1; }; done

echo "==> 1/5  Firewall do Ubuntu (a 7880 NÃO é aberta: só o Caddy fala com ela)"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent curl openssl >/dev/null
abrir() { # abrir <tcp|udp> <porta>: insere antes das regras de recusa, sem repetir
  sudo iptables -C INPUT -p "$1" --dport "$2" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p "$1" --dport "$2" -j ACCEPT
}
abrir tcp 80; abrir tcp 443; abrir tcp 7881; abrir udp 7882; abrir udp 3478
sudo netfilter-persistent save >/dev/null
echo "    Abertas: TCP 80, 443, 7881 e UDP 7882, 3478."
echo "    LEMBRE: libere as MESMAS portas na lista de segurança da sub-rede, no console da Oracle."

echo "==> 2/5  LiveKit $LIVEKIT_VERSION (linux_arm64)"
if [ ! -x /opt/livekit/livekit-server ] || ! /opt/livekit/livekit-server --version 2>/dev/null | grep -q "$LIVEKIT_VERSION"; then
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  BASE="https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}"
  ARQ="livekit_${LIVEKIT_VERSION}_linux_arm64.tar.gz"
  curl -fsSL -o "$TMP/$ARQ" "$BASE/$ARQ"
  if curl -fsSL -o "$TMP/checksums.txt" "$BASE/checksums.txt"; then
    ESPERADO="$(grep " $ARQ\$" "$TMP/checksums.txt" | awk '{print $1}')"
    REAL="$(sha256sum "$TMP/$ARQ" | awk '{print $1}')"
    [ -n "$ESPERADO" ] && [ "$ESPERADO" = "$REAL" ] || { echo "ERRO: o arquivo baixado não bate com o checksum oficial. Parei."; exit 1; }
    echo "    Checksum conferido."
  else
    echo "ERRO: não consegui o checksums.txt oficial; não instalo binário sem conferir. Tente de novo em alguns minutos."; exit 1
  fi
  tar tzf "$TMP/$ARQ" | grep -qx "livekit-server" || { echo "ERRO: o pacote não contém o livekit-server."; exit 1; }
  sudo mkdir -p /opt/livekit
  sudo tar xzf "$TMP/$ARQ" -C /opt/livekit livekit-server
  sudo chmod 755 /opt/livekit/livekit-server
fi
id livekit >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin livekit

echo "==> 3/5  Chaves (novas só na primeira vez)"
sudo mkdir -p /etc/livekit
if [ ! -f /etc/livekit/livekit.env ]; then
  CHAVE="API$(openssl rand -hex 6)"
  SEGREDO="$(openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-40)"
  sudo install -d -m 755 /etc/livekit
  sudo install -m 600 -o root -g root /dev/null /etc/livekit/livekit.env
  printf 'LIVEKIT_KEYS=%s: %s\n' "$CHAVE" "$SEGREDO" | sudo tee /etc/livekit/livekit.env >/dev/null
  sudo chmod 600 /etc/livekit/livekit.env
  sudo chown root:root /etc/livekit/livekit.env
  echo "    ===== ANOTE AGORA (o segredo só aparece desta vez) ====="
  echo "    MEDIA_PRIMARY_URL=wss://$DOMINIO"
  echo "    MEDIA_PRIMARY_KEY=$CHAVE"
  echo "    MEDIA_PRIMARY_SECRET=$SEGREDO"
  echo "    ========================================================"
else
  echo "    Já existem em /etc/livekit/livekit.env (não troquei). Chave de API: $(sudo cut -d= -f2 /etc/livekit/livekit.env | cut -d: -f1)"
fi

echo "==> 4/5  Caddy (HTTPS automático de $DOMINIO)"
if ! command -v caddy >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gpg >/dev/null
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y caddy >/dev/null
fi
RESOLVIDO="$(getent hosts "$DOMINIO" | awk '{print $1}' | head -1 || true)"
if [ "$RESOLVIDO" != "$IP_PUBLICO" ]; then
  echo "    AVISO: $DOMINIO aponta para '${RESOLVIDO:-nada}', não para $IP_PUBLICO. Acerte o nome no DuckDNS; sem isso o HTTPS não sai."
fi
sed "s/__DOMINIO__/$DOMINIO/g" "$AQUI/Caddyfile" | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl enable caddy >/dev/null 2>&1
sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy

echo "==> 5/5  Serviço do LiveKit"
sed "s/__DOMINIO__/$DOMINIO/g" "$AQUI/livekit.yaml" | sudo tee /etc/livekit/livekit.yaml >/dev/null
sudo cp "$AQUI/livekit.service" /etc/systemd/system/livekit.service
sudo systemctl daemon-reload
sudo systemctl enable livekit >/dev/null 2>&1
sudo systemctl restart livekit
sleep 2
if systemctl is-active --quiet livekit; then
  echo "    livekit: rodando."
else
  echo "    ERRO: o livekit não subiu. Veja: sudo journalctl -u livekit -n 30"; exit 1
fi
echo
echo "Pronto. Teste:  curl -s https://$DOMINIO/   (deve responder OK)"
echo "Depois siga o LEIAME.md (teste de voz) antes de ligar no Concord."
