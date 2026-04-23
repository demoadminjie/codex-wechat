const qrcodeTerminal = require("qrcode-terminal");

const { apiGetFetch } = require("./api");
const {
  deleteWeixinAccount,
  listWeixinAccounts,
  saveWeixinAccount,
} = require("./account-store");
const { clearPersistedContextTokens } = require("./context-token-store");
const { redactSensitiveText } = require("./redact");
const { clearSyncBuffer } = require("./sync-buffer-store");

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH_COUNT = 3;
const FIXED_QR_API_BASE_URL = "https://ilinkai.weixin.qq.com";

async function fetchQrCode(apiBaseUrl, botType) {
  const rawText = await apiGetFetch({
    baseUrl: apiBaseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    label: "fetchQrCode",
  });
  return JSON.parse(rawText);
}

async function pollQrStatus(apiBaseUrl, qrcode) {
  try {
    const rawText = await apiGetFetch({
      baseUrl: apiBaseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: "pollQrStatus",
    });
    return JSON.parse(rawText);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "wait" };
    }
    return { status: "wait", error: redactSensitiveText(error?.message || String(error || "")) };
  }
}

function printQrCode(url) {
  try {
    qrcodeTerminal.generate(url, { small: true });
    console.log("如果二维码未能成功展示，请用浏览器打开以下链接扫码：");
    console.log(url);
  } catch {
    console.log(url);
  }
}

function cleanupStaleAccountsForUserId(config, activeAccount) {
  const activeUserId = typeof activeAccount?.userId === "string" ? activeAccount.userId.trim() : "";
  if (!activeUserId) {
    return [];
  }

  const staleAccounts = listWeixinAccounts(config).filter((account) => (
    account.accountId !== activeAccount.accountId
    && typeof account.userId === "string"
    && account.userId.trim() === activeUserId
  ));

  for (const staleAccount of staleAccounts) {
    deleteWeixinAccount(config, staleAccount.accountId);
    clearSyncBuffer(config, staleAccount.accountId);
    clearPersistedContextTokens(config, staleAccount.accountId);
    console.log(`[codex-wechat] removed stale account ${staleAccount.accountId} for userId ${activeUserId}`);
  }

  return staleAccounts;
}

async function waitForWeixinLogin({ apiBaseUrl, botType, timeoutMs }) {
  let qrResponse = await fetchQrCode(FIXED_QR_API_BASE_URL, botType);
  let currentApiBaseUrl = FIXED_QR_API_BASE_URL;
  let startedAt = Date.now();
  let scannedPrinted = false;
  let refreshCount = 1;

  console.log("使用微信扫描以下二维码，以完成连接：\n");
  printQrCode(qrResponse.qrcode_img_content);
  console.log("\n等待连接结果...\n");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (Date.now() - startedAt > ACTIVE_LOGIN_TTL_MS) {
      qrResponse = await fetchQrCode(FIXED_QR_API_BASE_URL, botType);
      currentApiBaseUrl = FIXED_QR_API_BASE_URL;
      startedAt = Date.now();
      scannedPrinted = false;
      refreshCount += 1;
      if (refreshCount > MAX_QR_REFRESH_COUNT) {
        throw new Error("二维码多次过期，请重新执行 login");
      }
      console.log(`二维码已过期，正在刷新...(${refreshCount}/${MAX_QR_REFRESH_COUNT})\n`);
      printQrCode(qrResponse.qrcode_img_content);
    }

    const statusResponse = await pollQrStatus(currentApiBaseUrl, qrResponse.qrcode);
    switch (statusResponse.status) {
      case "wait":
        process.stdout.write(".");
        break;
      case "scaned":
        if (!scannedPrinted) {
          process.stdout.write("\n已扫码，请在微信中确认授权...\n");
          scannedPrinted = true;
        }
        break;
      case "scaned_but_redirect":
        if (typeof statusResponse.redirect_host === "string" && statusResponse.redirect_host.trim()) {
          currentApiBaseUrl = `https://${statusResponse.redirect_host.trim()}`;
        }
        break;
      case "expired":
        qrResponse = await fetchQrCode(FIXED_QR_API_BASE_URL, botType);
        currentApiBaseUrl = FIXED_QR_API_BASE_URL;
        startedAt = Date.now();
        scannedPrinted = false;
        refreshCount += 1;
        if (refreshCount > MAX_QR_REFRESH_COUNT) {
          throw new Error("二维码多次过期，请重新执行 login");
        }
        console.log(`二维码已过期，正在刷新...(${refreshCount}/${MAX_QR_REFRESH_COUNT})\n`);
        printQrCode(qrResponse.qrcode_img_content);
        break;
      case "confirmed":
        if (!statusResponse.bot_token || !statusResponse.ilink_bot_id) {
          throw new Error("登录成功但缺少 bot token 或账号 ID");
        }
        return {
          accountId: statusResponse.ilink_bot_id,
          token: statusResponse.bot_token,
          baseUrl: statusResponse.baseurl || currentApiBaseUrl || apiBaseUrl || FIXED_QR_API_BASE_URL,
          userId: statusResponse.ilink_user_id || "",
        };
      default:
        break;
    }
  }

  throw new Error("登录超时，请重新执行 login");
}

async function runLoginFlow(config) {
  console.log("[codex-wechat] 正在启动微信扫码登录...");
  const result = await waitForWeixinLogin({
    apiBaseUrl: config.baseUrl,
    botType: config.qrBotType,
    timeoutMs: 480_000,
  });
  const account = saveWeixinAccount(config, result.accountId, result);
  cleanupStaleAccountsForUserId(config, account);
  console.log("\n✅ 与微信连接成功！");
  console.log(`accountId: ${account.accountId}`);
  console.log(`userId: ${account.userId || "(unknown)"}`);
  console.log(`baseUrl: ${account.baseUrl}`);
}

module.exports = {
  runLoginFlow,
};
