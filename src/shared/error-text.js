function extractErrorMessage(error, fallback = "未知错误") {
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error && typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  return fallback;
}

function formatFailureText(prefix, error, fallback = "未知错误") {
  return `${prefix}：${extractErrorMessage(error, fallback)}`;
}

module.exports = {
  extractErrorMessage,
  formatFailureText,
};
