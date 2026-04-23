# codex-wechat

**Code by Codex**

`codex-wechat` 直接复用微信插件背后的微信 HTTP 协议，把链路改成：

`微信 App -> codex-wechat -> 本地 codex app-server -> 微信 App`

OpenClaw 不再作为运行时参与；这里只借用了 `@tencent-weixin/openclaw-weixin` 所用的登录和消息协议。

## 能力

- 微信扫码登录，保存本地 `bot_token`
- `getupdates` 长轮询收消息
- 本地启动或连接 `codex app-server`
- 按微信用户维度维护工作区与 Codex 线程绑定
- `/codex new` 会切到新会话
- 支持微信内 `/codex ...` 控制命令

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

## 命令说明

### 终端命令

- `codex-wechat login`
  - 发起微信扫码登录，保存当前微信账号的 `bot_token`
- `codex-wechat start`
  - 启动微信长轮询和本地 Codex 桥接服务
- `codex-wechat accounts`
  - 查看本地已经保存的微信账号
- `codex-wechat help`
  - 查看 CLI 帮助

### 微信内命令

- `/codex bind /绝对路径`
  - 绑定当前微信用户会话到指定本地项目目录，后续普通消息都会发到这个项目对应的 Codex 线程
- `/codex where`
  - 查看当前会话绑定的项目、线程、运行状态、模型和推理强度
- `/codex workspace`
  - 查看当前会话记录过的所有项目绑定，以及每个项目当前选中的线程
- `/codex new`
  - 切换到新会话；不会立刻创建空线程，下一条普通消息才会真正开始一个新线程
- `/codex switch <threadId>`
  - 切换当前项目对应的 Codex 线程
- `/codex message`
  - 查看当前线程最近几轮用户和助手消息；如果当前还是新会话，会提示先发送普通消息开始
- `/codex stop`
  - 停止当前线程里正在执行的 Codex 任务
- `/codex model`
  - 查看当前项目正在使用的模型，以及当前已缓存的可用模型列表
- `/codex model update`
  - 重新向 Codex 拉取一次可用模型列表，并刷新本地缓存
- `/codex model <modelId>`
  - 为当前项目设置模型；如果当前推理强度不兼容，会切换到该模型默认推理强度
- `/codex effort`
  - 查看当前项目的推理强度，以及当前模型支持的推理强度列表
- `/codex effort <low|medium|high|xhigh>`
  - 为当前项目设置推理强度
- `/codex approve`
  - 允许当前线程正在等待的这一次授权请求
- `/codex approve workspace`
  - 允许当前授权请求，并把当前命令前缀加入该工作区的自动放行名单
- `/codex reject`
  - 拒绝当前线程正在等待的授权请求
- `/codex remove /绝对路径`
  - 从当前微信会话中移除某个项目绑定
- `/codex send <相对文件路径>`
  - 把当前项目里的文件发送到当前微信聊天窗口；图片按图片发送，视频按视频发送，其他文件按附件发送
- `/codex help`
  - 查看微信内命令帮助

### 普通消息

- 非 `/codex ...` 开头的普通文本消息
  - 会直接发送到当前项目对应的 Codex 线程
- 如果当前会话还没绑定项目
  - 需要先执行 `/codex bind /绝对路径`

## 工作方式

1. 微信收到文本消息
2. `codex-wechat` 解析命令或普通对话
3. 普通对话进入本地 Codex 线程
4. 运行过程中发送 typing 指示
5. Codex 完成后，结果回发到微信
6. 如果 Codex 请求授权，微信里用 `/codex approve` 或 `/codex reject` 处理

## 实现说明

- 本项目参考了：
  - `@tencent-weixin/openclaw-weixin` 的微信扫码和消息 HTTP 协议
  - `codex-im` 的本地 Codex JSON-RPC 接入方式
- `@tencent-weixin/openclaw-weixin-cli/cli.mjs` 本身只是安装器
- 本项目直接复用了微信协议和 Codex RPC 思路，但不依赖 OpenClaw 作为运行时

## 备注

- 微信端富媒体入站会先落盘到当前工作区，再以文件路径形式交给 Codex。
- 微信出站会做兼容性过滤，尽量保留代码块、表格和常见 Markdown 结构。

## 后续计划：
- [ ] codex在执行长一点的任务时，只会在执行完成后输出消息，优化提示，告诉用户任务执行中

- [ ] codex执行完任务后输出信息可能超过单条消息上限导致截断，优化消息提示

- [ ] 支持Plan模式

## 实验性的功能：
- 微信上产生的任务可以在本机的codex上看到（feat/historyShare分支实现）
