#!/usr/bin/env node

const { main } = require("../src/index");

main().catch((error) => {
  console.error(`[codex-wechat] ${error.message}`);
  process.exit(1);
});
