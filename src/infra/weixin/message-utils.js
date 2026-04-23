const { filterWeixinOutboundMarkdown } = require("./markdown-filter");

const TEXT_ITEM_TYPE = 1;
const IMAGE_ITEM_TYPE = 2;
const VOICE_ITEM_TYPE = 3;
const FILE_ITEM_TYPE = 4;
const VIDEO_ITEM_TYPE = 5;
const BOT_MESSAGE_TYPE = 2;

function normalizeWeixinIncomingMessage(message, config, accountId) {
  if (!message || typeof message !== "object") {
    return null;
  }
  if (Number(message.message_type) === BOT_MESSAGE_TYPE) {
    return null;
  }

  const senderId = normalizeText(message.from_user_id);
  if (!senderId) {
    return null;
  }

  const text = extractTextBody(message.item_list);
  const attachments = extractAttachmentItems(message.item_list);
  if (!text && !attachments.length) {
    return null;
  }

  return {
    provider: "weixin",
    workspaceId: config.defaultWorkspaceId,
    accountId,
    chatId: senderId,
    threadKey: normalizeText(message.session_id),
    senderId,
    messageId: String(message.message_id || "").trim(),
    text,
    attachments,
    command: parseCommand(text),
    contextToken: normalizeText(message.context_token),
    receivedAt: new Date().toISOString(),
  };
}

function extractTextBody(itemList) {
  if (!Array.isArray(itemList) || !itemList.length) {
    return "";
  }

  for (const item of itemList) {
    if (Number(item?.type) === TEXT_ITEM_TYPE && typeof item?.text_item?.text === "string") {
      return item.text_item.text.trim();
    }
    if (Number(item?.type) === VOICE_ITEM_TYPE && typeof item?.voice_item?.text === "string") {
      return item.voice_item.text.trim();
    }
  }

  return "";
}

function extractAttachmentItems(itemList) {
  if (!Array.isArray(itemList) || !itemList.length) {
    return [];
  }

  const attachments = [];
  for (let index = 0; index < itemList.length; index += 1) {
    const normalized = normalizeAttachmentItem(itemList[index], index);
    if (normalized) {
      attachments.push(normalized);
    }
  }

  return attachments;
}

function normalizeAttachmentItem(item, index) {
  const itemType = Number(item?.type);
  const payload = resolveAttachmentPayload(itemType, item);
  if (!payload) {
    return null;
  }

  const media = payload.media && typeof payload.media === "object"
    ? payload.media
    : {};

  return {
    kind: payload.kind,
    itemType,
    index,
    fileName: normalizeText(
      payload.body?.file_name
      || payload.body?.filename
      || item?.file_name
      || item?.filename
    ),
    sizeBytes: parseOptionalInt(
      payload.body?.len
      || payload.body?.file_size
      || payload.body?.size
      || payload.body?.video_size
      || item?.len
    ),
    directUrls: collectStringValues([
      payload.body?.url,
      payload.body?.download_url,
      payload.body?.cdn_url,
      payload.body?.full_url,
      media?.url,
      media?.download_url,
      media?.cdn_url,
      media?.full_url,
    ]),
    mediaRef: {
      encryptQueryParam: normalizeText(
        media?.encrypt_query_param
        || media?.encrypted_query_param
        || payload.body?.encrypt_query_param
        || payload.body?.encrypted_query_param
        || item?.encrypt_query_param
        || item?.encrypted_query_param
      ),
      aesKey: normalizeText(
        media?.aes_key
        || payload.body?.aes_key
        || item?.aes_key
      ),
      aesKeyHex: normalizeText(
        payload.body?.aeskey
        || payload.body?.aes_key_hex
        || item?.aeskey
      ),
      encryptType: Number(
        media?.encrypt_type
        ?? payload.body?.encrypt_type
        ?? item?.encrypt_type
        ?? 1
      ),
      fileKey: normalizeText(
        media?.filekey
        || payload.body?.filekey
        || item?.filekey
      ),
      fullUrl: normalizeText(
        media?.full_url
        || payload.body?.full_url
        || item?.full_url
      ),
    },
    rawItem: item,
  };
}

function resolveAttachmentPayload(itemType, item) {
  if (itemType === IMAGE_ITEM_TYPE && item?.image_item && typeof item.image_item === "object") {
    return { kind: "image", body: item.image_item, media: item.image_item.media };
  }
  if (itemType === FILE_ITEM_TYPE && item?.file_item && typeof item.file_item === "object") {
    return { kind: "file", body: item.file_item, media: item.file_item.media };
  }
  if (itemType === VIDEO_ITEM_TYPE && item?.video_item && typeof item.video_item === "object") {
    return { kind: "video", body: item.video_item, media: item.video_item.media };
  }
  return null;
}

function collectStringValues(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseOptionalInt(value) {
  if (value == null || value === "") {
    return 0;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseCommand(text) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  const exactCommands = {
    stop: ["stop"],
    where: ["where"],
    inspect_message: ["message"],
    help: ["help"],
    workspace: ["workspace"],
    new: ["new"],
    model: ["model", "model update"],
    effort: ["effort"],
    approve: ["approve", "approve workspace"],
    reject: ["reject"],
  };

  for (const [command, suffixes] of Object.entries(exactCommands)) {
    if (suffixes.some((suffix) => normalized === `/codex ${suffix}`)) {
      return command;
    }
  }

  if (matchesPrefixCommand(normalized, "switch")) {
    return "switch";
  }
  if (matchesPrefixCommand(normalized, "bind")) {
    return "bind";
  }
  if (matchesPrefixCommand(normalized, "remove")) {
    return "remove";
  }
  if (matchesPrefixCommand(normalized, "send")) {
    return "send";
  }
  if (matchesPrefixCommand(normalized, "model")) {
    return "model";
  }
  if (matchesPrefixCommand(normalized, "effort")) {
    return "effort";
  }
  if (normalized === "/codex" || normalized.startsWith("/codex ")) {
    return "unknown_command";
  }
  return "message";
}

function matchesPrefixCommand(text, command) {
  return text.startsWith(`/codex ${command} `);
}

function markdownToPlainText(text) {
  return filterWeixinOutboundMarkdown(text).trim();
}

function chunkReplyText(text, limit = 3500) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return [];
  }

  const chunks = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit);
    const splitIndex = Math.max(
      candidate.lastIndexOf("\n\n"),
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf("。"),
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf(" ")
    );
    const cut = splitIndex > limit * 0.4 ? splitIndex + (candidate[splitIndex] === "\n" ? 0 : 1) : limit;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks.filter(Boolean);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  chunkReplyText,
  extractAttachmentItems,
  extractTextBody,
  markdownToPlainText,
  normalizeWeixinIncomingMessage,
  parseCommand,
};
