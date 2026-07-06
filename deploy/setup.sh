#!/usr/bin/env bash
# Setup idempotente de ai-home. Ejecutar como root desde la raíz del repo.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_USER="${AI_HOME_USER:-aihome}"
DATA_DIR="${AI_HOME_DATA:-/ai-home}"
ENV_FILE=/etc/ai-home.env

# ① usuario de servicio (claude rechaza bypassPermissions como root)
if ! id "$SERVICE_USER" &>/dev/null; then
  useradd -m -s /bin/bash "$SERVICE_USER"
  echo "Usuario $SERVICE_USER creado. Provisiona a mano:"
  echo "  - claude CLI:   sudo -u $SERVICE_USER bash -c 'curl -fsSL https://claude.ai/install.sh | bash'"
  echo "  - gh + git:     copia ~/.config/gh y ~/.gitconfig de un usuario ya autenticado"
fi

# ② archivo de credenciales
if [ ! -f "$ENV_FILE" ]; then
  install -m 600 "$REPO_DIR/deploy/ai-home.env.example" "$ENV_FILE"
  echo "⚠️  Edita $ENV_FILE con tus credenciales reales antes de arrancar."
fi

# ③ data dir: crea estructura y siembra plantillas SOLO si el archivo no existe
mkdir -p "$DATA_DIR"/{work,courses,investments,state/logs}
(cd "$REPO_DIR/templates" && find . -type f | while read -r f; do
  dest="$DATA_DIR/${f#./}"
  mkdir -p "$(dirname "$dest")"
  [ -f "$dest" ] || cp "$f" "$dest"
done)
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

# ④ build
cd "$REPO_DIR"
sudo -u "$SERVICE_USER" env HOME="/home/$SERVICE_USER" npm ci
sudo -u "$SERVICE_USER" env HOME="/home/$SERVICE_USER" npx tsc
chown -R "$SERVICE_USER:$SERVICE_USER" "$REPO_DIR"

# ⑤ servicios: apaga el v1 (chocaría en getUpdates con el mismo bot token) y arranca v2
systemctl disable --now code-assistant.service 2>/dev/null || true
install -m 644 "$REPO_DIR/deploy/ai-home.service" /etc/systemd/system/ai-home.service
systemctl daemon-reload
systemctl enable --now ai-home.service
systemctl --no-pager status ai-home.service
