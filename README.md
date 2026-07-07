# ai-home

Orquestador multi-agente por Telegram sobre el **Claude Agent SDK**. Un solo bot de
Telegram recibe tus mensajes; el orquestador los enruta al asistente correcto y cada
asistente corre como una sesión resumible de Claude con su propia carpeta, memoria en
archivos markdown y autonomía total (`bypassPermissions`).

```
Telegram ──► telegram.ts (long-poll) ──► router.ts ──► orchestrator.ts (cola por agente)
                                                            │
                              ┌─────────────┬───────────────┼───────────────┐
                              ▼             ▼               ▼               ▼
                        💼 work        🥗 nutrition     💰 financial    📚 education
                        (Agent SDK query() con resume, cwd=memory/<agente>, CLAUDE.md)
                              ▲
                        scheduler.ts (cron sobre state/schedules.json → turnos proactivos)
```

## Agentes

| Comando | Agente | Memoria |
|---|---|---|
| `/work` | 💼 work-assistant | BRAIN.md, REPOS.md · repos en `work/` |
| `/food` | 🥗 nutrition-assistant | NUTRITION_PLAN.md, TRAINING_PLAN.md, ROUTINE.md |
| `/money` | 💰 financial-assistant | BRAIN.md, INVESTMENTS.md, INVESTMENTS_CHECK_SCHEDULE.md · análisis en `investments/` |
| `/study` | 📚 education-assistant | BRAIN.md, EDUCATION_PLAN.md, CERTIFICATIONS.md · material en `courses/` |

Meta-comandos: `/status`, `/agents`, `/new <agente>` (nueva sesión, la memoria md
persiste), `/stop <agente>`, `/help`. El texto libre se enruta por keywords y, si no
alcanza, con un clasificador one-shot (haiku). Di **"usa opus"** dentro de un mensaje
para correr ese turno con otro modelo.

## Cómo funciona la memoria

- **Sesión** (`state/sessions.json`): cada agente mantiene una conversación resumible
  del SDK; `/new` la reinicia.
- **Memoria durable** (`<data>/memory/<agente>/*.md`): el `CLAUDE.md` de cada agente
  (cargado nativamente vía `settingSources: ['project']`) le ordena leer y actualizar
  sus archivos ante "recuérdalo", correcciones o decisiones. El `INSTRUCTIONS.md` del
  diseño original es el `CLAUDE.md` de cada carpeta.

## Proactividad

`state/schedules.json` define jobs cron por agente (hay 3 semilla, deshabilitados).
El scheduler los recarga al detectar cambios — **los propios agentes pueden editarlo**
("recuérdame estudiar L-M-V a las 7pm"). El resultado de cada job llega por Telegram.

## Tokens (suscripción Pro)

Pool `default` → `fallback` (`claude setup-token`). Ante límite de uso: cooldown
calculado del mensaje de reset, aviso por Telegram y reintento automático con la otra
cuenta. Con todas agotadas, el turno queda en cola y se reintenta al liberarse.

## Instalación

```bash
git clone <este repo> && cd ai-home
sudo AI_HOME_DATA=/ai-home bash deploy/setup.sh   # idempotente
```

Requisitos: Node ≥22 y un usuario de servicio **no root** (claude rechaza
`bypassPermissions` como root) con el claude CLI instalado y `gh` autenticado.
El código vive en el repo; los datos personales en `AI_HOME_DATA` (por defecto
`/ai-home`), fuera de git.

## Variables de entorno (secretos)

Ningún secreto vive en el repo. `setup.sh` crea `/etc/ai-home.env` (root:root, 600)
desde el ejemplo y **se niega a arrancar el servicio hasta que pongas valores reales**:

| Variable | Obligatoria | Cómo obtenerla |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | sí | Crea un bot con [@BotFather](https://t.me/BotFather) (`/newbot`) |
| `TELEGRAM_CHAT_ID` | sí | Escríbele al bot y consulta `https://api.telegram.org/bot<token>/getUpdates` → `message.chat.id` |
| `CLAUDE_CODE_OAUTH_TOKEN` | sí | `claude setup-token` con tu cuenta Pro/Max (token de ~1 año) |
| `CLAUDE_CODE_OAUTH_TOKEN_FALLBACK` | no | Igual, con una segunda cuenta; rota automáticamente al agotarse el cupo |
| `AI_HOME_DATA` | no | Directorio de datos (por defecto `/ai-home`) |

En producción systemd las inyecta vía `EnvironmentFile=/etc/ai-home.env`. Para
desarrollo local copia `.env.example` a `.env` y usa `npm run dev` (Node las carga
con `--env-file`); `.env` está en `.gitignore`.

## Agregar el agente #5

1. Nueva entrada en `src/agents.ts` (id, emoji, comando, aliases, modelo, descripción).
2. Carpeta `templates/memory/<id>/` con su `CLAUDE.md` (instrucciones + qué archivos
   de memoria mantiene).
3. `sudo bash deploy/setup.sh` (siembra la carpeta nueva y reinicia el servicio).

## Operación

```bash
systemctl status ai-home        # estado
journalctl -u ai-home -f        # salida en vivo
cat <data>/state/logs/error.log # solo errores
```
