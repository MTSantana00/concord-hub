#!/usr/bin/env bash
# Tenta criar a máquina A1 (Oracle, Always Free) até conseguir. Feito para rodar a cada 10 min no cron da VM atual
# e PARAR SOZINHO (tira a própria linha do cron) quando criar.
#   bash tentar-a1.sh            tenta de verdade
#   bash tentar-a1.sh --dry-run  só mostra o comando que rodaria
# Configuração: arquivo tentar-a1.env ao lado deste script (modelo: tentar-a1.env.exemplo). Nada de segredo nele:
# a autenticação é a chave de API em ~/.oci (permissão 600), que só você coloca lá.
# Só cria recurso GRÁTIS: recusa mais de 2 OCPU, 12 GB de memória ou 200 GB de disco (limites do Always Free).
set -euo pipefail

# O cron roda com PATH mínimo: inclui onde a CLI da Oracle costuma ficar (symlink em /usr/local/bin)
export PATH="/usr/local/bin:$HOME/bin:$HOME/.local/bin:$HOME/oci-cli/bin:$PATH"
# Trava: nunca duas tentativas ao mesmo tempo (poderia criar duas máquinas)
exec 9>"$HOME/.tentar-a1.lock"
flock -n 9 || exit 0

AQUI="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${ENV_FILE:-$AQUI/tentar-a1.env}"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
LOG="${LOG:-$HOME/tentar-a1.log}"

say() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }

[ -f "$ENV_FILE" ] || { echo "Não achei $ENV_FILE (copie o tentar-a1.env.exemplo e preencha)"; exit 2; }
# shellcheck disable=SC1090
. "$ENV_FILE"

: "${COMPARTMENT_OCID:?preencha COMPARTMENT_OCID}"
: "${SUBNET_OCID:?preencha SUBNET_OCID}"
: "${IMAGE_OCID:?preencha IMAGE_OCID (Ubuntu 24.04 aarch64)}"
: "${AVAILABILITY_DOMAIN:?preencha AVAILABILITY_DOMAIN}"
OCPUS="${OCPUS:-2}"; MEM_GB="${MEM_GB:-12}"; DISK_GB="${DISK_GB:-50}"
SSH_PUB="${SSH_PUB_FILE:-$HOME/.ssh/chave_oracle.pub}"
NOME="${NOME:-concord-voz}"

# Limites do plano grátis: qualquer valor acima disso pode gerar cobrança, então nem tenta
[ "$OCPUS" -le 2 ] || { echo "RECUSADO: $OCPUS OCPU passa do limite grátis (2)."; exit 3; }
[ "$MEM_GB" -le 12 ] || { echo "RECUSADO: ${MEM_GB} GB passa do limite grátis (12)."; exit 3; }
[ "$DISK_GB" -le 200 ] || { echo "RECUSADO: disco de ${DISK_GB} GB passa do limite grátis (200)."; exit 3; }
[ -f "$SSH_PUB" ] || { echo "Não achei a chave pública SSH: $SSH_PUB"; exit 2; }

CMD=(oci compute instance launch
  --compartment-id "$COMPARTMENT_OCID"
  --availability-domain "$AVAILABILITY_DOMAIN"
  --shape VM.Standard.A1.Flex
  --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEM_GB}"
  --image-id "$IMAGE_OCID"
  --subnet-id "$SUBNET_OCID"
  --assign-public-ip true
  --boot-volume-size-in-gbs "$DISK_GB"
  --ssh-authorized-keys-file "$SSH_PUB"
  --display-name "$NOME")

if [ "$DRY" = 1 ]; then
  echo "Teste a seco: rodaria isto (nada foi criado):"
  printf '  %q' "${CMD[@]}"; echo
  exit 0
fi

command -v oci >/dev/null || { echo "A CLI da Oracle (oci) não está instalada."; exit 2; }

# Se já existe uma máquina com esse nome (viva), não cria outra: para de tentar
EXISTE="$(oci compute instance list --compartment-id "$COMPARTMENT_OCID" --display-name "$NOME" --query 'data[?"lifecycle-state"!=`TERMINATED`] | length(@)' --raw-output 2>/dev/null || echo 0)"
if [ "${EXISTE:-0}" != "0" ]; then
  say "Já existe uma máquina '$NOME'. Parando as tentativas."
  crontab -l 2>/dev/null | grep -v "tentar-a1.sh" | crontab - || true
  exit 0
fi

if SAIDA="$("${CMD[@]}" 2>&1)"; then
  say "CRIADA! $NOME"
  echo "$SAIDA" >> "$LOG"
  crontab -l 2>/dev/null | grep -v "tentar-a1.sh" | crontab - || true
  say "Cron removido. Pegue o IP público no console da Oracle e siga o LEIAME.md."
  exit 0
fi

if grep -qiE "Out of host capacity|OutOfHostCapacity|Out of capacity" <<<"$SAIDA"; then
  say "Sem capacidade agora (normal); tento de novo na próxima."
  exit 0
fi
say "ERRO diferente de falta de capacidade (veja abaixo):"
echo "$SAIDA" | tee -a "$LOG" | tail -15
exit 1
