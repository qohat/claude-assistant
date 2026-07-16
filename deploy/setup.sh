#!/usr/bin/env bash
# Setup idempotente de ai-home. Ejecutar como root desde la raíz del repo.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_USER="${AI_HOME_USER:-aihome}"
DATA_DIR="${AI_HOME_DATA:-/ai-home}"
ENV_FILE=/etc/ai-home.env
ENGRAM_VERSION="${ENGRAM_VERSION:-1.19.0}"

# ① usuario de servicio (claude rechaza bypassPermissions como root)
if ! id "$SERVICE_USER" &>/dev/null; then
  useradd -m -s /bin/bash "$SERVICE_USER"
  echo "Usuario $SERVICE_USER creado. Provisiona a mano:"
  echo "  - claude CLI:   sudo -u $SERVICE_USER bash -c 'curl -fsSL https://claude.ai/install.sh | bash'"
  echo "  - gh + git:     copia ~/.config/gh y ~/.gitconfig de un usuario ya autenticado"
fi

# ② archivo de credenciales — los secretos NUNCA van en el repo; el usuario
#    debe colocarlos aquí (ver README, sección "Variables de entorno").
if [ ! -f "$ENV_FILE" ]; then
  install -m 600 "$REPO_DIR/deploy/ai-home.env.example" "$ENV_FILE"
fi
if grep -qE '123456:ABC|sk-ant-oat01-\.\.\.|^TELEGRAM_BOT_TOKEN=$' "$ENV_FILE"; then
  echo "⛔ $ENV_FILE todavía tiene valores de ejemplo."
  echo "   Edítalo con tus credenciales reales y vuelve a correr este script:"
  echo "     TELEGRAM_BOT_TOKEN        → @BotFather en Telegram"
  echo "     TELEGRAM_CHAT_ID          → escribe al bot y mira getUpdates"
  echo "     CLAUDE_CODE_OAUTH_TOKEN   → 'claude setup-token' con tu cuenta Pro/Max"
  exit 1
fi

# ③ engram: memoria persistente de los agentes (binario pinneado de GitHub Releases)
if ! /usr/local/bin/engram --help 2>/dev/null | head -1 | grep -q "v$ENGRAM_VERSION"; then
  case "$(uname -m)" in
    x86_64) ENGRAM_ARCH=amd64 ;;
    aarch64) ENGRAM_ARCH=arm64 ;;
    *) echo "⛔ arquitectura no soportada por engram: $(uname -m)"; exit 1 ;;
  esac
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/engram.tgz" \
    "https://github.com/Gentleman-Programming/engram/releases/download/v${ENGRAM_VERSION}/engram_${ENGRAM_VERSION}_linux_${ENGRAM_ARCH}.tar.gz"
  tar -xzf "$tmp/engram.tgz" -C "$tmp" engram
  install -m 755 "$tmp/engram" /usr/local/bin/engram
  rm -rf "$tmp"
  echo "engram v$ENGRAM_VERSION instalado en /usr/local/bin/engram"
fi

# ④ data dir: crea estructura y siembra plantillas SOLO si el archivo no existe…
mkdir -p "$DATA_DIR"/{work,courses,investments,state/logs,engram}
(cd "$REPO_DIR/templates" && find . -type f | while read -r f; do
  dest="$DATA_DIR/${f#./}"
  mkdir -p "$(dirname "$dest")"
  [ -f "$dest" ] || cp "$f" "$dest"
done)
# …EXCEPTO los CLAUDE.md de los agentes: son código (prompts), no datos.
# Siempre se sobrescriben desde templates para que un deploy los actualice.
(cd "$REPO_DIR/templates" && find . -type f -name CLAUDE.md | while read -r f; do
  cp "$f" "$DATA_DIR/${f#./}"
done)
# La memoria .md legada (BRAIN.md, planes, etc.) se archiva: los agentes la
# consultan solo como referencia; la memoria viva es engram.
for dir in "$DATA_DIR"/memory/*/; do
  legacy=$(find "$dir" -maxdepth 1 -type f -name '*.md' ! -name CLAUDE.md)
  [ -z "$legacy" ] && continue
  mkdir -p "$dir/archive"
  echo "$legacy" | while read -r f; do mv "$f" "$dir/archive/"; done
  echo "memoria .md de $(basename "$dir") archivada en $(basename "$dir")/archive/"
done
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

# ⑤ build
cd "$REPO_DIR"
sudo -u "$SERVICE_USER" env HOME="/home/$SERVICE_USER" npm ci
sudo -u "$SERVICE_USER" env HOME="/home/$SERVICE_USER" npx tsc
chown -R "$SERVICE_USER:$SERVICE_USER" "$REPO_DIR"

# ⑥ servicios: apaga el v1 (chocaría en getUpdates con el mismo bot token) y arranca v2
systemctl disable --now code-assistant.service 2>/dev/null || true
install -m 644 "$REPO_DIR/deploy/ai-home.service" /etc/systemd/system/ai-home.service
systemctl daemon-reload
systemctl enable --now ai-home.service
systemctl --no-pager status ai-home.service
