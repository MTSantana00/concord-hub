#!/usr/bin/env bash
# Backup semanal dos arquivos (anexos, áudios, fotos) do volume Docker do Concord. Roda no HOST da VM, pelo cron.
# O banco já tem backup automático dentro do app (/data/backups); aqui só vão os arquivos.
set -euo pipefail

VOLUME="${VOLUME:-/var/lib/docker/volumes/concord_concord-data/_data}"
DEST="${1:-$HOME/concord/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"

tar -czf "$DEST/arquivos-$STAMP.tar.gz" -C "$VOLUME" audio images 2>/dev/null || true

# guarda só as 4 mais recentes
ls -1t "$DEST"/arquivos-*.tar.gz 2>/dev/null | tail -n +5 | xargs -r rm --
echo "Backup dos arquivos em $DEST/arquivos-$STAMP.tar.gz"
