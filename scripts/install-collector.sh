#!/usr/bin/env bash
# Installe le collecteur du Bureau des agents comme LaunchAgent macOS : il démarre avec ta session,
# redémarre s'il s'arrête, et pousse les résumés de tes sessions Claude Code vers le bureau en ligne.
#
#   bash scripts/install-collector.sh https://bureau-des-agents.xxx.workers.dev [libellé de la source]
#   bash scripts/install-collector.sh --uninstall
#
# Le jeton d'ingestion est lu dans ~/.config/bureau-collector/secrets.env (INGEST_TOKEN=…), jamais dans le plist.
set -euo pipefail

LABEL="com.bureau-des-agents.collector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CONF_DIR="$HOME/.config/bureau-collector"
LOG_DIR="$HOME/Library/Logs/bureau-collector"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Collecteur désinstallé."
  exit 0
fi

URL="${1:-}"
SOURCE_LABEL="${2:-$(scutil --get ComputerName 2>/dev/null || hostname -s)}"
if [[ -z "$URL" ]]; then echo "Usage : bash scripts/install-collector.sh <url du bureau> [libellé]"; exit 1; fi
if [[ ! -f "$CONF_DIR/secrets.env" ]] || ! grep -q '^INGEST_TOKEN=' "$CONF_DIR/secrets.env"; then
  echo "Il manque $CONF_DIR/secrets.env avec INGEST_TOKEN=… (le même jeton que le secret du Worker)."; exit 1
fi

NODE="$(command -v node)"
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<18)) { console.error("Node 22.18 ou plus récent requis"); process.exit(1) }'

mkdir -p "$CONF_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"
chmod 700 "$CONF_DIR"
# la config non secrète (l'adresse et le libellé) ; le jeton reste dans secrets.env
cat > "$CONF_DIR/config.json" <<EOF
{ "url": "$URL", "sourceLabel": "$SOURCE_LABEL" }
EOF

# petit lanceur : charge le jeton depuis secrets.env, puis démarre le collecteur
RUNNER="$CONF_DIR/run.sh"
cat > "$RUNNER" <<EOF
#!/usr/bin/env bash
set -a; source "$CONF_DIR/secrets.env"; set +a
export BUREAU_URL="$URL" BUREAU_TOKEN="\$INGEST_TOKEN" BUREAU_SOURCE_LABEL="$SOURCE_LABEL"
exec "$NODE" "$ROOT/collector/index.ts"
EOF
chmod 700 "$RUNNER"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$RUNNER</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/collector.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/collector.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
echo "Collecteur installé et démarré ($SOURCE_LABEL → $URL)."
echo "Journal : $LOG_DIR/collector.log"
