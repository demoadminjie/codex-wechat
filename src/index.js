const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

const { readConfig } = require("./infra/config/config");
const { WechatRuntime } = require("./app/wechat-runtime");
const { runLoginFlow } = require("./infra/weixin/login");
const { listWeixinAccounts } = require("./infra/weixin/account-store");

function ensureDefaultConfigDirectory() {
  const defaultConfigDir = path.join(os.homedir(), ".codex-wechat");
  fs.mkdirSync(defaultConfigDir, { recursive: true });
}

function loadEnv() {
  ensureDefaultConfigDirectory();

  const envCandidates = [
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), ".codex-wechat", ".env"),
  ];

  for (const envPath of envCandidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    dotenv.config({ path: envPath });
    return;
  }

  dotenv.config();
}

function printHelp() {
  console.log(`
用法: codex-wechat <命令>

命令:
  login      扫码登录微信并保存 bot token
  start      启动微信 <-> 本地 Codex 桥接
  accounts   查看本地已保存的微信账号
  help       显示帮助
`);
}

function printAccounts(config) {
  const accounts = listWeixinAccounts(config);
  if (!accounts.length) {
    console.log("当前没有已保存的微信账号。先执行 `codex-wechat login`。");
    return;
  }

  console.log("已保存账号：");
  for (const account of accounts) {
    console.log(`- ${account.accountId}`);
    console.log(`  userId: ${account.userId || "(unknown)"}`);
    console.log(`  baseUrl: ${account.baseUrl || config.baseUrl}`);
    console.log(`  savedAt: ${account.savedAt || "(unknown)"}`);
  }
}

async function main() {
  loadEnv();
  const config = readConfig();
  const command = config.mode || "";

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "login") {
    await runLoginFlow(config);
    return;
  }

  if (command === "accounts") {
    printAccounts(config);
    return;
  }

  if (command === "start") {
    const runtime = new WechatRuntime(config);
    await runtime.start();
    return;
  }

  throw new Error(`未知命令: ${command}`);
}

module.exports = { main };
