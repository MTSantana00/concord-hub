#!/usr/bin/env bash
# Backup do banco e dos áudios. Uso:  deploy/backup.sh [pasta-de-destino]
# O banco é copiado com o próprio SQLite (seguro com o app rodando), os áudios com tar.
set -euo pipefail

DEST="${1:-$HOME/backups}"
DATA_DIR="${DATA_DIR:-/var/lib/concord}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"

node -e '
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("VACUUM INTO \x27" + process.argv[2].replace(/\x27/g, "") + "\x27");
' "$DATA_DIR/concord.db" "$DEST/concord-$STAMP.db"

tar -czf "$DEST/audio-$STAMP.tar.gz" -C "$DATA_DIR" audio images 2>/dev/null || true

# guarda só os 14 backups mais recentes de cada tipo
ls -1t "$DEST"/concord-*.db 2>/dev/null | tail -n +15 | xargs -r rm --
ls -1t "$DEST"/audio-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm --
echo "Backup em $DEST (concord-$STAMP.db e audio-$STAMP.tar.gz)"
