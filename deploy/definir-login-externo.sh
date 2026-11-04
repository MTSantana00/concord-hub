#!/usr/bin/env bash
# Grava as credenciais do login com Google/GitHub em ~/concord/concord.env e reinicia o Concord.
# Rode NA VM:  bash ~/concord/definir-login-externo.sh
# Os valores são digitados com o campo oculto: não ficam no histórico do terminal nem passam pelo chat.
set -euo pipefail

ENV_FILE="${ENV_FILE:-$HOME/concord/concord.env}"
URL_PADRAO="https://concord-hub.duckdns.org"

[ -f "$ENV_FILE" ] || { echo "Não achei $ENV_FILE"; exit 1; }

pergunta() { # pergunta <nome> <oculto:0|1> <padrão>
  local nome="$1" oculto="$2" padrao="${3:-}" valor
  if [ "$oculto" = "1" ]; then read -r -s -p "$nome (em branco = não ligar): " valor; echo
  else read -r -p "$nome [$padrao]: " valor; valor="${valor:-$padrao}"; fi
  printf '%s' "$valor"
}

grava() { # grava <NOME> <valor>: troca a linha se existir, senão acrescenta; nunca mostra o valor
  local nome="$1" valor="$2"
  # tira qualquer quebra de linha ou aspas que atrapalhariam o arquivo
  valor="${valor//$'\n'/}"; valor="${valor//\"/}"
  grep -v "^${nome}=" "$ENV_FILE" > "$ENV_FILE.novo" || true
  printf '%s=%s\n' "$nome" "$valor" >> "$ENV_FILE.novo"
  mv "$ENV_FILE.novo" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

PUBLIC_URL="$(pergunta "Endereço público do Concord" 0 "$URL_PADRAO")"
grava PUBLIC_URL "${PUBLIC_URL%/}"

for P in GOOGLE GITHUB; do
  ID="$(pergunta "$P: ID do cliente" 1)"
  if [ -n "$ID" ]; then
    SEGREDO="$(pergunta "$P: segredo do cliente" 1)"
    if [ -z "$SEGREDO" ]; then echo "$P: sem segredo, não liguei."; continue; fi
    grava "${P}_CLIENT_ID" "$ID"
    grava "${P}_CLIENT_SECRET" "$SEGREDO"
    echo "$P: gravado."
  else
    echo "$P: pulado."
  fi
done

cd "$HOME/concord" && sudo docker compose up -d >/dev/null 2>&1 && echo "Concord reiniciado. Abra o site: os botões já devem aparecer."
