const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { redactSensitiveText } = require("./redact");

function readPackageMetadata() {
  try {
    const pkgPath = path.resolve(__dirname, "../../../package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return {};
  }
}

function buildClientVersion(version) {
  const parts = String(version || "0.0.0")
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const major = Number.isFinite(parts[0]) ? parts[0] : 0;
  const minor = Number.isFinite(parts[1]) ? parts[1] : 0;
  const patch = Number.isFinite(parts[2]) ? parts[2] : 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const PACKAGE_METADATA = readPackageMetadata();
const CHANNEL_VERSION = PACKAGE_METADATA.version || "unknown";
const ILINK_APP_ID = typeof PACKAGE_METADATA.ilink_appid === "string"
  ? PACKAGE_METADATA.ilink_appid.trim()
  : "";
const ILINK_APP_CLIENT_VERSION = String(buildClientVersion(CHANNEL_VERSION));
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function buildCommonHeaders() {
  const headers = {
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
  };
  if (ILINK_APP_ID) {
    headers["iLink-App-Id"] = ILINK_APP_ID;
  }
  return headers;
}

function buildHeaders(opts) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(opts.body, "utf8")),
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (opts.token && String(opts.token).trim()) {
    headers.Authorization = `Bearer ${String(opts.token).trim()}`;
  }
  return headers;
}

async function apiGetFetch(params) {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const timeoutMs = Number(params.timeoutMs) > 0 ? Number(params.timeoutMs) : 0;
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: buildCommonHeaders(),
      signal: controller ? controller.signal : undefined,
    });
    if (timer) {
      clearTimeout(timer);
    }
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`${params.label} ${response.status}: ${redactSensitiveText(rawText)}`);
    }
    return rawText;
  } catch (error) {
    if (timer) {
      clearTimeout(timer);
    }
    throw error;
  }
}

async function apiFetch(params) {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const headers = buildHeaders({ token: params.token, body: params.body });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`${params.label} ${response.status}: ${redactSensitiveText(rawText)}`);
    }
    return rawText;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

async function getUpdates(params) {
  const timeout = params.timeoutMs || DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf || "",
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
      label: "getUpdates",
    });
    return JSON.parse(rawText);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf || "" };
    }
    throw error;
  }
}

async function sendMessage(params) {
  await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs || DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
  });
}

async function getUploadUrl(params) {
  const rawText = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      filekey: params.filekey,
      media_type: params.media_type,
      to_user_id: params.to_user_id,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      thumb_rawsize: params.thumb_rawsize,
      thumb_rawfilemd5: params.thumb_rawfilemd5,
      thumb_filesize: params.thumb_filesize,
      no_need_thumb: params.no_need_thumb,
      aeskey: params.aeskey,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs || DEFAULT_API_TIMEOUT_MS,
    label: "getUploadUrl",
  });
  return JSON.parse(rawText);
}

async function getConfig(params) {
  const rawText = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs || DEFAULT_CONFIG_TIMEOUT_MS,
    label: "getConfig",
  });
  return JSON.parse(rawText);
}

async function sendTyping(params) {
  await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs || DEFAULT_CONFIG_TIMEOUT_MS,
    label: "sendTyping",
  });
}

module.exports = {
  apiGetFetch,
  buildBaseInfo,
  getConfig,
  getUploadUrl,
  getUpdates,
  sendMessage,
  sendTyping,
};
