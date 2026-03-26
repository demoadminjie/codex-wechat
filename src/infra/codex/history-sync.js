const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_CODEX_COMMAND = "codex";
const DEFAULT_CODEX_HOME_DIR = ".codex";
const SESSION_INDEX_FILE = "session_index.jsonl";
const STATE_DB_FILE = "state_5.sqlite";
const SQLITE_EXPERIMENTAL_WARNING = "SQLite is an experimental feature";

let cachedDatabaseSync = null;
let cachedDatabaseSyncError = null;

function inspectCodexHistorySync({ env = process.env, codexCommand = "" } = {}) {
  const codexHome = resolveCodexHome(env);
  const stateDbPath = path.join(codexHome, STATE_DB_FILE);
  const sessionIndexPath = path.join(codexHome, SESSION_INDEX_FILE);
  const warnings = [];

  if (!fs.existsSync(codexHome)) {
    warnings.push(`Codex home 不存在: ${codexHome}`);
  }
  if (!fs.existsSync(stateDbPath)) {
    warnings.push(`Codex 状态库不存在: ${stateDbPath}`);
  }

  const codexVersion = detectCodexVersion(codexCommand, env);
  if (!codexVersion) {
    warnings.push("无法读取 Codex 版本，history 同步将继续尝试本地文件同步。");
  }

  const databaseReady = canUseStateDatabase();
  if (!databaseReady) {
    warnings.push(`无法加载 node:sqlite: ${cachedDatabaseSyncError?.message || "unknown error"}`);
  }

  return {
    codexHome,
    stateDbPath,
    sessionIndexPath,
    codexVersion,
    databaseReady,
    canSync: fs.existsSync(stateDbPath) && databaseReady,
    warnings,
  };
}

function syncCodexThreadHistory({
  env = process.env,
  threadId,
  threadName = "",
  firstUserMessage = "",
  workspaceRoot = "",
  updatedAt = new Date(),
} = {}) {
  const normalizedThreadId = normalizeNonEmptyString(threadId);
  if (!normalizedThreadId) {
    return { ok: false, reason: "missing_thread_id" };
  }

  const codexHome = resolveCodexHome(env);
  const stateDbPath = path.join(codexHome, STATE_DB_FILE);
  const sessionIndexPath = path.join(codexHome, SESSION_INDEX_FILE);
  if (!fs.existsSync(stateDbPath)) {
    return { ok: false, reason: "missing_state_db", stateDbPath };
  }
  if (!canUseStateDatabase()) {
    return {
      ok: false,
      reason: "sqlite_unavailable",
      message: cachedDatabaseSyncError?.message || "node:sqlite unavailable",
    };
  }

  const threadRow = readThreadRow(stateDbPath, normalizedThreadId);
  if (!threadRow) {
    return { ok: false, reason: "thread_not_found", threadId: normalizedThreadId };
  }

  const timestamp = normalizeDate(updatedAt);
  const activation = ensureActiveRolloutFile({
    codexHome,
    rolloutPath: threadRow.rolloutPath,
    createdAtSeconds: threadRow.createdAt,
    touchedAt: timestamp,
  });
  if (!activation.ok) {
    return {
      ok: false,
      reason: activation.reason,
      threadId: normalizedThreadId,
      rolloutPath: threadRow.rolloutPath,
      activeRolloutPath: activation.activeRolloutPath,
    };
  }

  const rawFirstUserMessage = normalizeLongText(firstUserMessage)
    || normalizeLongText(threadRow.firstUserMessage)
    || normalizeLongText(threadRow.title)
    || "";
  const resolvedThreadName = normalizeSessionThreadName(
    threadName || rawFirstUserMessage || threadRow.title || normalizedThreadId
  );
  const resolvedWorkspaceRoot = normalizeNonEmptyString(workspaceRoot) || threadRow.cwd || "";
  const nextTitle = normalizeLongText(threadRow.title) || rawFirstUserMessage || resolvedThreadName;
  const nextFirstUserMessage = rawFirstUserMessage || nextTitle;

  updateThreadRow(stateDbPath, {
    threadId: normalizedThreadId,
    rolloutPath: activation.activeRolloutPath,
    cwd: resolvedWorkspaceRoot,
    title: nextTitle,
    firstUserMessage: nextFirstUserMessage,
  });

  upsertSessionIndexEntry(sessionIndexPath, {
    id: normalizedThreadId,
    thread_name: resolvedThreadName,
    updated_at: timestamp.toISOString(),
  });

  return {
    ok: true,
    threadId: normalizedThreadId,
    rolloutPath: activation.activeRolloutPath,
    threadName: resolvedThreadName,
    copiedRollout: activation.copied,
    touchedRollout: activation.touched,
  };
}

function resolveCodexHome(env = process.env) {
  const fromEnv = normalizeNonEmptyString(env.CODEX_HOME);
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(os.homedir(), DEFAULT_CODEX_HOME_DIR);
}

function detectCodexVersion(codexCommand, env = process.env) {
  const command = normalizeNonEmptyString(codexCommand)
    || normalizeNonEmptyString(env.CODEX_WECHAT_CODEX_COMMAND)
    || DEFAULT_CODEX_COMMAND;

  try {
    const result = spawnSync(command, ["--version"], {
      env: { ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) {
      return "";
    }
    return normalizeNonEmptyString(result.stdout) || normalizeNonEmptyString(result.stderr) || "";
  } catch {
    return "";
  }
}

function canUseStateDatabase() {
  return !!getDatabaseSync();
}

function getDatabaseSync() {
  if (cachedDatabaseSync) {
    return cachedDatabaseSync;
  }
  if (cachedDatabaseSyncError) {
    return null;
  }

  const originalEmitWarning = process.emitWarning;
  process.emitWarning = (warning, ...args) => {
    const text = typeof warning === "string" ? warning : warning?.message || "";
    if (text.includes(SQLITE_EXPERIMENTAL_WARNING)) {
      return;
    }
    return originalEmitWarning.call(process, warning, ...args);
  };

  try {
    ({ DatabaseSync: cachedDatabaseSync } = require("node:sqlite"));
    return cachedDatabaseSync;
  } catch (error) {
    cachedDatabaseSyncError = error;
    return null;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function readThreadRow(stateDbPath, threadId) {
  return withStateDatabase(stateDbPath, (database) => {
    const row = database.prepare(`
      SELECT
        id,
        rollout_path AS rolloutPath,
        created_at AS createdAt,
        cwd,
        title,
        first_user_message AS firstUserMessage
      FROM threads
      WHERE id = ?
    `).get(threadId);

    return row || null;
  });
}

function updateThreadRow(stateDbPath, { threadId, rolloutPath, cwd, title, firstUserMessage }) {
  return withStateDatabase(stateDbPath, (database) => {
    database.prepare(`
      UPDATE threads
      SET
        rollout_path = ?,
        archived = 0,
        archived_at = NULL,
        cwd = CASE WHEN trim(coalesce(cwd, '')) = '' THEN ? ELSE cwd END,
        title = CASE WHEN trim(coalesce(title, '')) = '' THEN ? ELSE title END,
        first_user_message = CASE
          WHEN trim(coalesce(first_user_message, '')) = '' THEN ?
          ELSE first_user_message
        END
      WHERE id = ?
    `).run(rolloutPath, cwd, title, firstUserMessage, threadId);
  });
}

function withStateDatabase(stateDbPath, callback) {
  const DatabaseSync = getDatabaseSync();
  if (!DatabaseSync) {
    throw cachedDatabaseSyncError || new Error("node:sqlite unavailable");
  }

  const database = new DatabaseSync(stateDbPath);
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

function ensureActiveRolloutFile({ codexHome, rolloutPath, createdAtSeconds = 0, touchedAt = new Date() }) {
  const normalizedRolloutPath = normalizeNonEmptyString(rolloutPath);
  if (!normalizedRolloutPath) {
    return { ok: false, reason: "missing_rollout_path", activeRolloutPath: "" };
  }

  const activeRolloutPath = resolveActiveRolloutPath({
    codexHome,
    rolloutPath: normalizedRolloutPath,
    createdAtSeconds,
  });
  if (!activeRolloutPath) {
    return {
      ok: false,
      reason: "invalid_rollout_path",
      activeRolloutPath: normalizedRolloutPath,
    };
  }

  let copied = false;
  const normalizedActivePath = path.normalize(activeRolloutPath);
  const normalizedSourcePath = path.normalize(normalizedRolloutPath);
  if (normalizedActivePath !== normalizedSourcePath) {
    if (!fs.existsSync(normalizedSourcePath) && !fs.existsSync(normalizedActivePath)) {
      return {
        ok: false,
        reason: "rollout_file_missing",
        activeRolloutPath: activeRolloutPath,
      };
    }
    if (fs.existsSync(normalizedSourcePath) && !fs.existsSync(normalizedActivePath)) {
      fs.mkdirSync(path.dirname(normalizedActivePath), { recursive: true });
      fs.copyFileSync(normalizedSourcePath, normalizedActivePath);
      copied = true;
    }
  }

  if (!fs.existsSync(normalizedActivePath)) {
    return {
      ok: false,
      reason: "active_rollout_missing",
      activeRolloutPath: activeRolloutPath,
    };
  }

  let touched = false;
  try {
    fs.utimesSync(normalizedActivePath, touchedAt, touchedAt);
    touched = true;
  } catch {
    touched = false;
  }

  return {
    ok: true,
    activeRolloutPath: normalizedActivePath,
    copied,
    touched,
  };
}

function resolveActiveRolloutPath({ codexHome, rolloutPath, createdAtSeconds = 0 }) {
  const normalizedRolloutPath = normalizeNonEmptyString(rolloutPath);
  if (!normalizedRolloutPath) {
    return "";
  }

  const sessionsSegment = `${path.sep}sessions${path.sep}`;
  if (normalizedRolloutPath.includes(sessionsSegment)) {
    return normalizedRolloutPath;
  }

  const fileName = path.basename(normalizedRolloutPath);
  if (!fileName) {
    return "";
  }

  const dateParts = extractRolloutDateParts(fileName) || extractDatePartsFromEpochSeconds(createdAtSeconds);
  if (!dateParts) {
    return path.join(codexHome, "sessions", fileName);
  }

  return path.join(codexHome, "sessions", dateParts.year, dateParts.month, dateParts.day, fileName);
}

function extractRolloutDateParts(fileName) {
  const match = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(String(fileName || ""));
  if (!match) {
    return null;
  }
  return {
    year: match[1],
    month: match[2],
    day: match[3],
  };
}

function extractDatePartsFromEpochSeconds(seconds) {
  const normalizedSeconds = Number(seconds);
  if (!Number.isFinite(normalizedSeconds) || normalizedSeconds <= 0) {
    return null;
  }
  const date = new Date(normalizedSeconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return {
    year: String(date.getUTCFullYear()),
    month: String(date.getUTCMonth() + 1).padStart(2, "0"),
    day: String(date.getUTCDate()).padStart(2, "0"),
  };
}

function upsertSessionIndexEntry(sessionIndexPath, entry) {
  const normalizedEntry = {
    id: normalizeNonEmptyString(entry?.id),
    thread_name: normalizeSessionThreadName(entry?.thread_name),
    updated_at: normalizeNonEmptyString(entry?.updated_at) || new Date().toISOString(),
  };
  if (!normalizedEntry.id || !normalizedEntry.thread_name) {
    return false;
  }

  const existingLines = readTextFileLines(sessionIndexPath);
  const nextLines = [];
  let replaced = false;

  for (const line of existingLines) {
    const parsed = tryParseJsonLine(line);
    if (!parsed || normalizeNonEmptyString(parsed.id) !== normalizedEntry.id) {
      nextLines.push(line);
      continue;
    }
    if (!replaced) {
      nextLines.push(JSON.stringify(normalizedEntry));
      replaced = true;
    }
  }

  if (!replaced) {
    nextLines.push(JSON.stringify(normalizedEntry));
  }

  fs.mkdirSync(path.dirname(sessionIndexPath), { recursive: true });
  writeTextFileAtomic(sessionIndexPath, `${nextLines.filter(Boolean).join("\n")}\n`);
  return true;
}

function readTextFileLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function writeTextFileAtomic(filePath, content) {
  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFilePath, content, "utf8");
  fs.renameSync(tempFilePath, filePath);
}

function tryParseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function normalizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  const nextDate = new Date(value || Date.now());
  return Number.isNaN(nextDate.getTime()) ? new Date() : nextDate;
}

function normalizeSessionThreadName(value) {
  const normalized = normalizeLongText(value).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function normalizeLongText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  inspectCodexHistorySync,
  resolveCodexHome,
  syncCodexThreadHistory,
};
