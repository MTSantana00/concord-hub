#!/usr/bin/env bash
# Grava o envio de e-mail (Gmail com senha de app) em ~/concord/concord.env e reinicia o Concord.
# Rode NA VM:  bash ~/concord/definir-email.sh
# A senha de app é digitada com o campo oculto: não fica no histórico do terminal nem passa pelo chat.
set -euo pipefail

ENV_FILE="${ENV_FILE:-$HOME/concord/concord.env}"
[ -f "$ENV_FILE" ] || { echo "Não achei $ENV_FILE"; exit 1; }

grava() { # grava <NOME> <valor>: troca a linha se existir, senão acrescenta; nunca mostra o valor
  local nome="$1" valor="$2"
  valor="${valor//$'\n'/}"; valor="${valor//\"/}"
  grep -v "^${nome}=" "$ENV_FILE" > "$ENV_FILE.novo" || true
  printf '%s=%s\n' "$nome" "$valor" >> "$ENV_FILE.novo"
  mv "$ENV_FILE.novo" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

read -r -p "Seu Gmail (o que vai enviar os e-mails): " USUARIO
USUARIO="${USUARIO//[[:space:]]/}"
case "$USUARIO" in *@*.*) ;; *) echo "Isso não parece um e-mail."; exit 1 ;; esac
read -r -s -p "Senha de app de 16 letras (não aparece na tela): " SENHA; echo
SENHA="${SENHA//[[:space:]]/}"   # o Google mostra com espaços; sem eles também vale
[ "${#SENHA}" -ge 12 ] || { echo "Senha de app curta demais; nada foi gravado."; exit 1; }

grava SMTP_HOST smtp.gmail.com
grava SMTP_PORT 465
grava SMTP_USER "$USUARIO"
grava SMTP_PASS "$SENHA"
grava MAIL_FROM "Concord Hub <$USUARIO>"
echo "Gravado."

cd "$HOME/concord" && sudo docker compose up -d --force-recreate concord >/dev/null 2>&1 && echo "Concord reiniciado. O envio de e-mail já está ligado."
