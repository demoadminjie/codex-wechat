const os = require("os");
const path = require("path");

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);
const ALLOWED_ACCESS_MODES = new Set(["default", "full-access"]);

function readConfig() {
  const mode = process.argv[2] || "";
  const defaultStateDir = path.join(os.homedir(), ".codex-wechat");
  const stateDir = process.env.CODEX_WECHAT_STATE_DIR || defaultStateDir;

  return {
    mode,
    stateDir,
    baseUrl: process.env.CODEX_WECHAT_BASE_URL || "https://ilinkai.weixin.qq.com",
    accountId: process.env.CODEX_WECHAT_ACCOUNT_ID || "",
    allowedUserIds: readListEnv("CODEX_WECHAT_ALLOWED_USER_IDS"),
    workspaceAllowlist: readListEnv("CODEX_WECHAT_WORKSPACE_ALLOWLIST"),
    defaultWorkspaceRoot: readTextEnv("CODEX_WECHAT_DEFAULT_WORKSPACE"),
    defaultWorkspaceId: process.env.CODEX_WECHAT_DEFAULT_WORKSPACE_ID || "default",
    defaultCodexModel: readTextEnv("CODEX_WECHAT_DEFAULT_CODEX_MODEL"),
    defaultCodexEffort: readTextEnv("CODEX_WECHAT_DEFAULT_CODEX_EFFORT"),
    defaultCodexAccessMode: readAccessModeEnv("CODEX_WECHAT_DEFAULT_CODEX_ACCESS_MODE", "default"),
    codexEndpoint: process.env.CODEX_WECHAT_CODEX_ENDPOINT || "",
    codexCommand: process.env.CODEX_WECHAT_CODEX_COMMAND || "",
    enableTyping: readBooleanEnv("CODEX_WECHAT_ENABLE_TYPING", true),
    sessionsFile: process.env.CODEX_WECHAT_SESSIONS_FILE
      || path.join(stateDir, "sessions.json"),
    syncBufferDir: process.env.CODEX_WECHAT_SYNC_BUFFER_DIR
      || path.join(stateDir, "sync-buf"),
    accountsDir: path.join(stateDir, "accounts"),
    qrBotType: readTextEnv("CODEX_WECHAT_QR_BOT_TYPE") || "3",
  };
}

function readListEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readBooleanEnv(name, defaultValue) {
  const rawValue = process.env[name];
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return defaultValue;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (TRUE_ENV_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_ENV_VALUES.has(normalized)) {
    return false;
  }
  return defaultValue;
}

function readTextEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readAccessModeEnv(name, fallback) {
  const value = readTextEnv(name).toLowerCase();
  if (ALLOWED_ACCESS_MODES.has(value)) {
    return value;
  }
  return fallback;
}

module.exports = { readConfig };
