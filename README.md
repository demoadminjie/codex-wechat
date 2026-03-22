# codex-wechat

`codex-wechat` 直接复用微信插件背后的微信 HTTP 协议，把链路改成：

`微信 App -> codex-wechat -> 本地 codex app-server -> 微信 App`

OpenClaw 不再作为运行时参与；这里只借用了 `@tencent-weixin/openclaw-weixin` 所用的登录和消息协议。

## 能力

- 微信扫码登录，保存本地 `bot_token`
- `getupdates` 长轮询收消息
- 本地启动或连接 `codex app-server`
- 按微信用户维度维护工作区与 Codex 线程绑定
- 支持常用命令：
  - `/codex bind /绝对路径`
  - `/codex where`
  - `/codex workspace`
  - `/codex new`
  - `/codex switch <threadId>`
  - `/codex message`
  - `/codex stop`
  - `/codex model`
  - `/codex model update`
  - `/codex model <modelId>`
  - `/codex effort`
  - `/codex effort <low|medium|high|xhigh>`
  - `/codex approve`
  - `/codex approve workspace`
  - `/codex reject`
  - `/codex help`

## 安装

```bash
npm install
```

## 配置

复制 `.env.example` 到 `.env`，常用项：

- `CODEX_WECHAT_DEFAULT_WORKSPACE`
  - 设置后，微信里可以直接发自然语言，不必先 `/codex bind`
- `CODEX_WECHAT_ALLOWED_USER_IDS`
  - 只允许指定微信用户控制本机 Codex
- `CODEX_WECHAT_DEFAULT_CODEX_ACCESS_MODE`
  - `default`：工作区写入 + 需要审批
  - `full-access`：全权限，不需要审批

## 登录微信

```bash
npm run login
```

终端会打印二维码。扫码确认后，会把账号信息保存在：

```text
~/.codex-wechat/accounts/<account-id>.json
```

如果你登录了多个微信账号，可以通过 `CODEX_WECHAT_ACCOUNT_ID` 指定启动哪一个。

也可以查看已保存账号：

```bash
npm run accounts
```

## 启动

```bash
npm run start
```

或：

```bash
node ./bin/codex-wechat.js start
```

## 工作方式

1. 微信收到文本消息
2. `codex-wechat` 解析命令或普通对话
3. 普通对话进入本地 Codex 线程
4. 运行过程中发送 typing 指示
5. Codex 完成后，结果回发到微信
6. 如果 Codex 请求授权，微信里用 `/codex approve` 或 `/codex reject` 处理

## 实现说明

- 本项目参考了：
- - 复用`@tencent-weixin/openclaw-weixin`是微信扫码和消息 HTTP 协议。
  - 通过 JSON-RPC over stdio / websocket 控制 Codex
  - 维护工作区、线程、模型、审批状态

## 备注

- 当前只支持文本控制链路；微信端富媒体入站不会自动送进 Codex。
- 微信出站默认把 Markdown 压成纯文本后发送。


** Code by GPT-5.4 **
