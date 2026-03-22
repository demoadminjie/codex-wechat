const TEXT_ITEM_TYPE = 1;
const VOICE_ITEM_TYPE = 3;
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
  if (!text) {
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

function parseCommand(text) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  const exactCommands = {
    stop: ["stop"],
    where: ["where"],
    message: ["message"],
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
  let result = String(text || "");
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => String(code || "").trim());
  result = result.replace(/!\[[^\]]*]\([^)]*\)/g, "");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  result = result.replace(/`([^`]+)`/g, "$1");
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/\*([^*]+)\*/g, "$1");
  result = result.replace(/^>\s?/gm, "");
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner) =>
    String(inner || "").split("|").map((cell) => cell.trim()).join("  ")
  );
  return result.trim();
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
  extractTextBody,
  markdownToPlainText,
  normalizeWeixinIncomingMessage,
  parseCommand,
};
