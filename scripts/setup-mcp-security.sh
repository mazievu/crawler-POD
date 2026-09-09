#!/usr/bin/env bash
# ==============================================================================
# Setup Script: MCP Security Lock & Dedicated Read-Only OS User for OpenClaw
# ==============================================================================
# Resolves all OpenClaw pre-flight audit requirements:
# 1. Creates dedicated `crawler_mcp_ro` system user.
# 2. Grants passwordless sudo (NOPASSWD) for OpenClaw to run MCP as `crawler_mcp_ro`.
# 3. Ensures directory traversal permissions on Node binary path.
# 4. Sets read-only permissions for `crawler_mcp_ro` on data/ and collector.db.
# ==============================================================================

set -euo pipefail

MCP_USER="crawler_mcp_ro"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${PROJECT_ROOT}/data"
DB_FILE="${DATA_DIR}/collector.db"
NODE_BIN="/home/server/.nvm/versions/node/v24.18.0/bin/node"

echo "=== [1/5] Checking/Creating dedicated OS user: ${MCP_USER} ==="
if id "${MCP_USER}" &>/dev/null; then
  echo "User ${MCP_USER} already exists."
else
  echo "Creating system user ${MCP_USER} (no login, no sudo)..."
  useradd --system --no-create-home --shell /sbin/nologin "${MCP_USER}"
  echo "User ${MCP_USER} created."
fi

echo "=== [2/5] Configuring Passwordless Sudo for OpenClaw ==="
SUDOERS_FILE="/etc/sudoers.d/crawler_mcp_ro"
cat << EOF > "${SUDOERS_FILE}"
# Allow user running OpenClaw/MCP to switch to crawler_mcp_ro without interactive password
ALL ALL=(crawler_mcp_ro) NOPASSWD: ${NODE_BIN} ${PROJECT_ROOT}/src/mcp/index.js
EOF
chmod 0440 "${SUDOERS_FILE}"
echo "Configured sudoers: ${SUDOERS_FILE}"

echo "=== [3/5] Setting up Node.js Binary Traversal Permissions ==="
# Ensure crawler_mcp_ro can execute Node from nvm
chmod o+x /home/server || true
chmod o+rx /home/server/.nvm /home/server/.nvm/versions /home/server/.nvm/versions/node /home/server/.nvm/versions/node/v24.18.0 /home/server/.nvm/versions/node/v24.18.0/bin || true
chmod o+rx "${NODE_BIN}" || true

echo "=== [4/5] Setting up Read-Only Filesystem Permissions ==="
# Ensure data directory has 755 (Collector has write; crawler_mcp_ro has read-only)
chmod 755 "${DATA_DIR}"
if [ -f "${DB_FILE}" ]; then
  chmod 644 "${DB_FILE}"
fi
if [ -f "${DB_FILE}-wal" ]; then
  chmod 644 "${DB_FILE}-wal"
fi
if [ -f "${DB_FILE}-shm" ]; then
  chmod 644 "${DB_FILE}-shm"
fi

echo "=== [5/5] Verification ==="
echo "Testing non-interactive sudo execution under ${MCP_USER}..."
sudo -n -u "${MCP_USER}" "${NODE_BIN}" -e "console.log('Node executed successfully as user:', process.getuid ? process.getuid() : 'ok')"

echo "=== Security lock setup complete! ==="
