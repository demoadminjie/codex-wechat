const crypto = require("crypto");
const fs = require("fs");

const { SessionStore } = require("../infra/storage/session-store");
const { CodexRpcClient } = require("../infra/codex/rpc-client");
const codexMessageUtils = require("../infra/codex/message-utils");
const { getUpdates, sendMessage, getConfig, sendTyping } = require("../infra/weixin/api");
const { resolveSelectedAccount } = require("../infra/weixin/account-store");
const { loadSyncBuffer, saveSyncBuffer } = require("../infra/weixin/sync-buffer-store");
const {
  chunkReplyText,
  markdownToPlainText,
  normalizeWeixinIncomingMessage,
} = require("../infra/weixin/message-utils");
const {
  extractBindPath,
  extractEffortValue,
  extractModelValue,
  extractRemoveWorkspacePath,
  extractSwitchThreadId,
} = require("../shared/command-parsing");
const {
  filterThreadsByWorkspaceRoot,
  isAbsoluteWorkspacePath,
  isWorkspaceAllowed,
  normalizeWorkspacePath,
} = require("../shared/workspace-paths");
const {
  extractModelCatalogFromListResponse,
  findModelByQuery,
  resolveEffectiveModelForEffort,
} = require("../shared/model-catalog");
const { formatFailureText } = require("../shared/error-text");

const SESSION_EXPIRED_ERRCODE = -14;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const TYPING_KEEPALIVE_MS = 5_000;
const THREAD_SOURCE_KINDS = new Set([
  "app",
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
]);

class WechatRuntime {
  constructor(config) {
    this.config = config;
    this.sessionStore = new SessionStore({ filePath: config.sessionsFile });
    this.account = null;
    this.codex = new CodexRpcClient({
      endpoint: config.codexEndpoint,
      env: process.env,
      codexCommand: config.codexCommand,
    });
    this.contextTokenByUserId = new Map();
    this.pendingChatContextByThreadId = new Map();
    this.activeTurnIdByThreadId = new Map();
    this.pendingApprovalByThreadId = new Map();
    this.currentRunKeyByThreadId = new Map();
    this.replyBufferByRunKey = new Map();
    this.typingStopByThreadId = new Map();
    this.bindingKeyByThreadId = new Map();
    this.workspaceRootByThreadId = new Map();
    this.approvalAllowlistByWorkspaceRoot = new Map();
    this.resumedThreadIds = new Set();
    this.inFlightApprovalRequestKeys = new Set();
    this.codex.onMessage((message) => {
      this.handleCodexMessage(message).catch((error) => {
        console.error(`[codex-wechat] failed to handle Codex message: ${error.message}`);
      });
    });
  }

  async start() {
    this.account = resolveSelectedAccount(this.config);
    this.validateConfig();
    await this.codex.connect();
    await this.codex.initialize();
    await this.refreshAvailableModelCatalogAtStartup();
    console.log(`[codex-wechat] runtime ready account=${this.account.accountId} userId=${this.account.userId || "(unknown)"}`);
    await this.monitorLoop();
  }

  validateConfig() {
    if (!this.account || !this.account.token) {
      throw new Error("缺少已登录的微信账号，请先执行 `codex-wechat login`");
    }
    const defaultWorkspaceRoot = normalizeWorkspacePath(this.config.defaultWorkspaceRoot);
    if (defaultWorkspaceRoot) {
      if (!isAbsoluteWorkspacePath(defaultWorkspaceRoot)) {
        throw new Error("CODEX_WECHAT_DEFAULT_WORKSPACE 必须是绝对路径");
      }
      if (!isWorkspaceAllowed(defaultWorkspaceRoot, this.config.workspaceAllowlist)) {
        throw new Error("CODEX_WECHAT_DEFAULT_WORKSPACE 不在允许绑定的白名单中");
      }
    }
  }

  async refreshAvailableModelCatalogAtStartup() {
    const response = await this.codex.listModels();
    const models = extractModelCatalogFromListResponse(response);
    if (!models.length) {
      console.warn("[codex-wechat] model/list returned no models at startup");
      return;
    }
    this.sessionStore.setAvailableModelCatalog(models);
    this.validateDefaultModelConfig(models);
    console.log(`[codex-wechat] model catalog refreshed: ${models.length} entries`);
  }

  validateDefaultModelConfig(models) {
    if (this.config.defaultCodexModel) {
      const matched = findModelByQuery(models, this.config.defaultCodexModel);
      if (!matched) {
        throw new Error(`Invalid CODEX_WECHAT_DEFAULT_CODEX_MODEL: ${this.config.defaultCodexModel}`);
      }
      if (this.config.defaultCodexEffort) {
        const supported = matched.supportedReasoningEfforts || [];
        if (supported.length && !supported.includes(this.config.defaultCodexEffort)) {
          throw new Error(
            `Invalid CODEX_WECHAT_DEFAULT_CODEX_EFFORT: ${this.config.defaultCodexEffort} for model ${matched.model}`
          );
        }
      }
      return;
    }

    if (this.config.defaultCodexEffort) {
      const effectiveModel = resolveEffectiveModelForEffort(models, "");
      const supported = effectiveModel?.supportedReasoningEfforts || [];
      if (effectiveModel && supported.length && !supported.includes(this.config.defaultCodexEffort)) {
        throw new Error(
          `Invalid CODEX_WECHAT_DEFAULT_CODEX_EFFORT: ${this.config.defaultCodexEffort} for model ${effectiveModel.model}`
        );
      }
    }
  }

  async monitorLoop() {
    let getUpdatesBuf = loadSyncBuffer(this.config, this.account.accountId);
    let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
    let consecutiveFailures = 0;

    while (true) {
      try {
        const response = await getUpdates({
          baseUrl: this.account.baseUrl,
          token: this.account.token,
          get_updates_buf: getUpdatesBuf,
          timeoutMs: nextTimeoutMs,
        });

        if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
          nextTimeoutMs = response.longpolling_timeout_ms;
        }

        const isApiError =
          (response.ret !== undefined && response.ret !== 0)
          || (response.errcode !== undefined && response.errcode !== 0);
        if (isApiError) {
          if (response.errcode === SESSION_EXPIRED_ERRCODE || response.ret === SESSION_EXPIRED_ERRCODE) {
            throw new Error("微信会话已失效，请重新执行 `codex-wechat login`");
          }
          consecutiveFailures += 1;
          console.error(`[codex-wechat] getUpdates failed ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg || ""}`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            consecutiveFailures = 0;
            await sleep(BACKOFF_DELAY_MS);
          } else {
            await sleep(RETRY_DELAY_MS);
          }
          continue;
        }

        consecutiveFailures = 0;
        if (typeof response.get_updates_buf === "string" && response.get_updates_buf) {
          getUpdatesBuf = response.get_updates_buf;
          saveSyncBuffer(this.config, this.account.accountId, getUpdatesBuf);
        }

        const messages = Array.isArray(response.msgs) ? response.msgs : [];
        for (const message of messages) {
          await this.handleIncomingMessage(message);
        }
      } catch (error) {
        consecutiveFailures += 1;
        console.error(`[codex-wechat] monitor error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${error.message}`);
        if (String(error.message || "").includes("重新执行 `codex-wechat login`")) {
          throw error;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS);
        } else {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
  }

  async handleIncomingMessage(message) {
    const senderId = typeof message?.from_user_id === "string" ? message.from_user_id.trim() : "";
    const contextToken = typeof message?.context_token === "string" ? message.context_token.trim() : "";
    if (senderId && contextToken) {
      this.contextTokenByUserId.set(senderId, contextToken);
    }

    const normalized = normalizeWeixinIncomingMessage(message, this.config, this.account.accountId);
    if (!normalized) {
      return;
    }

    if (!this.isUserAllowed(normalized.senderId)) {
      await this.sendReplyToUser(normalized.senderId, "当前账号未允许该微信号控制本机 Codex。", normalized.contextToken);
      return;
    }

    try {
      if (await this.dispatchTextCommand(normalized)) {
        return;
      }

      const workspaceContext = await this.resolveWorkspaceContext(normalized);
      if (!workspaceContext) {
        return;
      }

      const { bindingKey, workspaceRoot } = workspaceContext;
      const { threadId } = await this.resolveWorkspaceThreadState({
        bindingKey,
        workspaceRoot,
        normalized,
        autoSelectThread: true,
      });

      if (threadId) {
        this.pendingChatContextByThreadId.set(threadId, normalized);
      }
      const resolvedThreadId = await this.ensureThreadAndSendMessage({
        bindingKey,
        workspaceRoot,
        normalized,
        threadId,
      });
      this.pendingChatContextByThreadId.set(resolvedThreadId, normalized);
      this.bindingKeyByThreadId.set(resolvedThreadId, bindingKey);
      this.workspaceRootByThreadId.set(resolvedThreadId, workspaceRoot);
      await this.startTypingForThread(resolvedThreadId, normalized);
    } catch (error) {
      await this.sendReplyToUser(
        normalized.senderId,
        formatFailureText("处理失败", error),
        normalized.contextToken
      );
      throw error;
    }
  }

  isUserAllowed(senderId) {
    if (!Array.isArray(this.config.allowedUserIds) || !this.config.allowedUserIds.length) {
      return true;
    }
    return this.config.allowedUserIds.includes(senderId);
  }

  async dispatchTextCommand(normalized) {
    switch (normalized.command) {
      case "bind":
        await this.handleBindCommand(normalized);
        return true;
      case "where":
        await this.handleWhereCommand(normalized);
        return true;
      case "workspace":
        await this.handleWorkspaceCommand(normalized);
        return true;
      case "new":
        await this.handleNewCommand(normalized);
        return true;
      case "switch":
        await this.handleSwitchCommand(normalized);
        return true;
      case "message":
        await this.handleMessageCommand(normalized);
        return true;
      case "stop":
        await this.handleStopCommand(normalized);
        return true;
      case "model":
        await this.handleModelCommand(normalized);
        return true;
      case "effort":
        await this.handleEffortCommand(normalized);
        return true;
      case "approve":
      case "reject":
        await this.handleApprovalCommand(normalized);
        return true;
      case "remove":
        await this.handleRemoveCommand(normalized);
        return true;
      case "help":
        await this.handleHelpCommand(normalized);
        return true;
      case "unknown_command":
        await this.sendReplyToNormalized(normalized, `未知命令。\n\n${this.buildHelpText()}`);
        return true;
      default:
        return false;
    }
  }

  async handleBindCommand(normalized) {
    const rawWorkspaceRoot = extractBindPath(normalized.text);
    if (!rawWorkspaceRoot) {
      await this.sendReplyToNormalized(normalized, "用法: `/codex bind /绝对路径`");
      return;
    }

    const workspaceRoot = normalizeWorkspacePath(rawWorkspaceRoot);
    if (!isAbsoluteWorkspacePath(workspaceRoot)) {
      await this.sendReplyToNormalized(normalized, "只支持绝对路径绑定。");
      return;
    }
    if (!isWorkspaceAllowed(workspaceRoot, this.config.workspaceAllowlist)) {
      await this.sendReplyToNormalized(normalized, "该项目不在允许绑定的白名单中。");
      return;
    }

    const workspaceStats = await this.resolveWorkspaceStats(workspaceRoot);
    if (!workspaceStats.exists) {
      await this.sendReplyToNormalized(normalized, `项目不存在: ${workspaceRoot}`);
      return;
    }
    if (!workspaceStats.isDirectory) {
      await this.sendReplyToNormalized(normalized, `路径非法: ${workspaceRoot}`);
      return;
    }

    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    this.applyDefaultCodexParamsOnBind(bindingKey, workspaceRoot);
    this.sessionStore.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
    await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const threadId = this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const text = threadId
      ? `已切换到项目，并恢复原线程。\n\nworkspace: ${workspaceRoot}\nthread: ${threadId}`
      : `已绑定项目。\n\nworkspace: ${workspaceRoot}`;
    await this.sendReplyToNormalized(normalized, text);
  }

  async handleWhereCommand(normalized) {
    const workspaceContext = await this.resolveWorkspaceContext(normalized, false);
    if (!workspaceContext) {
      await this.sendReplyToNormalized(
        normalized,
        this.config.defaultWorkspaceRoot
          ? `默认项目可用，但当前会话尚未持久化绑定。\n\nworkspace: ${normalizeWorkspacePath(this.config.defaultWorkspaceRoot)}`
          : "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。"
      );
      return;
    }

    const { bindingKey, workspaceRoot } = workspaceContext;
    const { threads, threadId } = await this.resolveWorkspaceThreadState({
      bindingKey,
      workspaceRoot,
      normalized,
      autoSelectThread: true,
    });
    const codexParams = this.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    const status = this.describeWorkspaceStatus(threadId);
    await this.sendReplyToNormalized(normalized, [
      `workspace: ${workspaceRoot}`,
      `thread: ${threadId || "(none)"}`,
      `status: ${status.label}`,
      `model: ${codexParams.model || "(default)"}`,
      `effort: ${codexParams.effort || "(default)"}`,
      `threads: ${threads.length}`,
    ].join("\n"));
  }

  async handleWorkspaceCommand(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoots = this.sessionStore.listWorkspaceRoots(bindingKey);
    if (!workspaceRoots.length) {
      if (this.config.defaultWorkspaceRoot) {
        await this.sendReplyToNormalized(
          normalized,
          `当前没有显式绑定项目。\n默认项目: ${normalizeWorkspacePath(this.config.defaultWorkspaceRoot)}`
        );
        return;
      }
      await this.sendReplyToNormalized(normalized, "当前会话还没有绑定任何项目。");
      return;
    }

    const activeWorkspaceRoot = this.sessionStore.getActiveWorkspaceRoot(bindingKey);
    const lines = workspaceRoots.map((workspaceRoot) => {
      const threadId = this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      const prefix = workspaceRoot === activeWorkspaceRoot ? "* " : "- ";
      return `${prefix}${workspaceRoot}${threadId ? `\n  thread: ${threadId}` : ""}`;
    });
    await this.sendReplyToNormalized(normalized, lines.join("\n"));
  }

  async handleNewCommand(normalized) {
    const workspaceContext = await this.resolveWorkspaceContext(normalized);
    if (!workspaceContext) {
      return;
    }
    const { bindingKey, workspaceRoot } = workspaceContext;
    const threadId = await this.createWorkspaceThread({
      bindingKey,
      workspaceRoot,
      normalized,
    });
    await this.sendReplyToNormalized(
      normalized,
      `已创建新线程并切换到它。\n\nworkspace: ${workspaceRoot}\nthread: ${threadId}`
    );
  }

  async handleSwitchCommand(normalized) {
    const targetThreadId = extractSwitchThreadId(normalized.text);
    if (!targetThreadId) {
      await this.sendReplyToNormalized(normalized, "用法: `/codex switch <threadId>`");
      return;
    }

    const workspaceContext = await this.resolveWorkspaceContext(normalized);
    if (!workspaceContext) {
      return;
    }
    const { bindingKey, workspaceRoot } = workspaceContext;
    const threads = await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const selectedThread = threads.find((thread) => thread.id === targetThreadId);
    if (!selectedThread) {
      await this.sendReplyToNormalized(normalized, "指定线程当前不可用，请刷新后重试。");
      return;
    }

    const resolvedWorkspaceRoot = selectedThread.cwd || workspaceRoot;
    this.sessionStore.setActiveWorkspaceRoot(bindingKey, resolvedWorkspaceRoot);
    this.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      resolvedWorkspaceRoot,
      targetThreadId,
      codexMessageUtils.buildBindingMetadata(normalized)
    );
    this.resumedThreadIds.delete(targetThreadId);
    await this.ensureThreadResumed(targetThreadId);
    await this.sendReplyToNormalized(
      normalized,
      `已切换线程。\n\nworkspace: ${resolvedWorkspaceRoot}\nthread: ${targetThreadId}`
    );
  }

  async handleMessageCommand(normalized) {
    const workspaceContext = await this.resolveWorkspaceContext(normalized);
    if (!workspaceContext) {
      return;
    }
    const { bindingKey, workspaceRoot } = workspaceContext;
    const { threads, threadId } = await this.resolveWorkspaceThreadState({
      bindingKey,
      workspaceRoot,
      normalized,
      autoSelectThread: true,
    });
    if (!threadId) {
      await this.sendReplyToNormalized(normalized, "当前项目还没有可查看的线程消息。");
      return;
    }

    this.resumedThreadIds.delete(threadId);
    const resumeResponse = await this.ensureThreadResumed(threadId);
    const recentMessages = codexMessageUtils.extractRecentConversationFromResumeResponse(resumeResponse);
    const currentThread = threads.find((thread) => thread.id === threadId) || { id: threadId };
    const lines = [
      `workspace: ${workspaceRoot}`,
      `thread: ${currentThread.id}`,
      "",
    ];
    if (!recentMessages.length) {
      lines.push("暂无最近消息。");
    } else {
      for (const message of recentMessages) {
        lines.push(`${message.role === "assistant" ? "assistant" : "user"}: ${message.text}`);
      }
    }
    await this.sendReplyToNormalized(normalized, lines.join("\n"));
  }

  async handleStopCommand(normalized) {
    const { threadId } = this.getCurrentThreadContext(normalized);
    const turnId = threadId ? this.activeTurnIdByThreadId.get(threadId) || null : null;
    if (!threadId) {
      await this.sendReplyToNormalized(normalized, "当前会话还没有可停止的运行任务。");
      return;
    }

    await this.codex.sendRequest("turn/cancel", {
      threadId,
      turnId,
    });
    await this.stopTypingForThread(threadId);
    await this.sendReplyToNormalized(normalized, "已发送停止请求。");
  }

  async handleModelCommand(normalized) {
    const requested = extractModelValue(normalized.text);
    if (requested.toLowerCase() === "update") {
      const response = await this.codex.listModels();
      const models = extractModelCatalogFromListResponse(response);
      if (!models.length) {
        await this.sendReplyToNormalized(normalized, "model/list 返回空结果。");
        return;
      }
      this.sessionStore.setAvailableModelCatalog(models);
      await this.sendReplyToNormalized(normalized, `已刷新模型列表，共 ${models.length} 个。`);
      return;
    }

    const workspaceContext = await this.resolveWorkspaceContext(normalized, false);
    const catalog = this.sessionStore.getAvailableModelCatalog();
    const models = Array.isArray(catalog?.models) ? catalog.models : [];
    if (!requested) {
      const currentModel = workspaceContext
        ? this.getCodexParamsForWorkspace(workspaceContext.bindingKey, workspaceContext.workspaceRoot).model
        : "";
      const lines = [
        `当前模型: ${currentModel || "(default)"}`,
        "",
        "可用模型：",
      ];
      for (const model of models) {
        lines.push(`- ${model.model}${model.isDefault ? " (default)" : ""}`);
      }
      await this.sendReplyToNormalized(normalized, lines.join("\n"));
      return;
    }

    if (!workspaceContext) {
      await this.sendReplyToNormalized(normalized, "当前会话还未绑定项目，无法设置模型。");
      return;
    }

    const matched = findModelByQuery(models, requested);
    if (!matched) {
      await this.sendReplyToNormalized(normalized, `未找到模型: ${requested}`);
      return;
    }

    const currentParams = this.getCodexParamsForWorkspace(workspaceContext.bindingKey, workspaceContext.workspaceRoot);
    const currentEffort = currentParams.effort;
    const supported = matched.supportedReasoningEfforts || [];
    const nextEffort = supported.length && currentEffort && supported.includes(currentEffort)
      ? currentEffort
      : matched.defaultReasoningEffort || "";
    this.sessionStore.setCodexParamsForWorkspace(
      workspaceContext.bindingKey,
      workspaceContext.workspaceRoot,
      { model: matched.model, effort: nextEffort }
    );
    await this.sendReplyToNormalized(
      normalized,
      `已设置模型。\n\nworkspace: ${workspaceContext.workspaceRoot}\nmodel: ${matched.model}\neffort: ${nextEffort || "(default)"}`
    );
  }

  async handleEffortCommand(normalized) {
    const requested = extractEffortValue(normalized.text);
    const workspaceContext = await this.resolveWorkspaceContext(normalized, false);
    if (!workspaceContext) {
      await this.sendReplyToNormalized(normalized, "当前会话还未绑定项目，无法设置推理强度。");
      return;
    }

    const catalog = this.sessionStore.getAvailableModelCatalog();
    const models = Array.isArray(catalog?.models) ? catalog.models : [];
    const currentParams = this.getCodexParamsForWorkspace(workspaceContext.bindingKey, workspaceContext.workspaceRoot);
    const effectiveModel = resolveEffectiveModelForEffort(models, currentParams.model);
    const supported = effectiveModel?.supportedReasoningEfforts || [];
    if (!requested) {
      const lines = [
        `当前模型: ${effectiveModel?.model || currentParams.model || "(default)"}`,
        `当前推理强度: ${currentParams.effort || "(default)"}`,
      ];
      if (supported.length) {
        lines.push("", `可用推理强度: ${supported.join(", ")}`);
      }
      await this.sendReplyToNormalized(normalized, lines.join("\n"));
      return;
    }

    if (supported.length && !supported.includes(requested)) {
      await this.sendReplyToNormalized(
        normalized,
        `当前模型不支持该推理强度: ${requested}\n支持: ${supported.join(", ")}`
      );
      return;
    }

    this.sessionStore.setCodexParamsForWorkspace(
      workspaceContext.bindingKey,
      workspaceContext.workspaceRoot,
      { model: effectiveModel?.model || currentParams.model || "", effort: requested }
    );
    await this.sendReplyToNormalized(
      normalized,
      `已设置推理强度。\n\nworkspace: ${workspaceContext.workspaceRoot}\neffort: ${requested}`
    );
  }

  async handleApprovalCommand(normalized) {
    const { workspaceRoot, threadId } = this.getCurrentThreadContext(normalized);
    const approval = threadId ? this.pendingApprovalByThreadId.get(threadId) || null : null;
    if (!threadId || !approval) {
      await this.sendReplyToNormalized(normalized, "当前没有待处理的授权请求。");
      return;
    }

    const outcome = await this.applyApprovalDecision({
      threadId,
      approval,
      command: normalized.command,
      workspaceRoot,
      scope: codexMessageUtils.isWorkspaceApprovalCommand(normalized.text) ? "workspace" : "once",
    });
    if (outcome.error) {
      throw outcome.error;
    }
    if (outcome.ignoredAsDuplicate) {
      await this.sendReplyToNormalized(normalized, "该授权请求正在处理中，请稍后。");
      return;
    }
    const text = outcome.decision === "accept"
      ? (outcome.scope === "workspace" && codexMessageUtils.isCommandApprovalMethod(outcome.method)
        ? "已自动允许该命令，后续同工作区下相同前缀命令将自动放行。"
        : "已允许本次请求。")
      : "已拒绝本次请求。";
    await this.sendReplyToNormalized(normalized, text);
  }

  async handleRemoveCommand(normalized) {
    const target = extractRemoveWorkspacePath(normalized.text);
    if (!target) {
      await this.sendReplyToNormalized(normalized, "用法: `/codex remove /绝对路径`");
      return;
    }
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = normalizeWorkspacePath(target);
    this.sessionStore.removeWorkspace(bindingKey, workspaceRoot);
    await this.sendReplyToNormalized(normalized, `已移除项目绑定: ${workspaceRoot}`);
  }

  async handleHelpCommand(normalized) {
    await this.sendReplyToNormalized(normalized, this.buildHelpText());
  }

  buildHelpText() {
    return [
      "可用命令：",
      "/codex bind /绝对路径",
      "/codex where",
      "/codex workspace",
      "/codex new",
      "/codex switch <threadId>",
      "/codex message",
      "/codex stop",
      "/codex model",
      "/codex model update",
      "/codex model <modelId>",
      "/codex effort",
      "/codex effort <low|medium|high|xhigh>",
      "/codex approve",
      "/codex approve workspace",
      "/codex reject",
      "/codex remove /绝对路径",
      "/codex help",
      "",
      "普通文本消息会直接发送给当前项目对应的 Codex 线程。",
    ].join("\n");
  }

  async resolveWorkspaceContext(normalized, sendMissingMessage = true) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    let workspaceRoot = this.sessionStore.getActiveWorkspaceRoot(bindingKey);
    if (!workspaceRoot && this.config.defaultWorkspaceRoot) {
      workspaceRoot = normalizeWorkspacePath(this.config.defaultWorkspaceRoot);
      this.applyDefaultCodexParamsOnBind(bindingKey, workspaceRoot);
      this.sessionStore.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
    }

    if (!workspaceRoot) {
      if (sendMissingMessage) {
        await this.sendReplyToNormalized(
          normalized,
          "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`，或配置 CODEX_WECHAT_DEFAULT_WORKSPACE。"
        );
      }
      return null;
    }
    return { bindingKey, workspaceRoot };
  }

  getBindingContext(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = this.sessionStore.getActiveWorkspaceRoot(bindingKey);
    return { bindingKey, workspaceRoot };
  }

  getCurrentThreadContext(normalized) {
    const { bindingKey, workspaceRoot } = this.getBindingContext(normalized);
    const threadId = workspaceRoot ? this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot) : "";
    return { bindingKey, workspaceRoot, threadId };
  }

  applyDefaultCodexParamsOnBind(bindingKey, workspaceRoot) {
    const current = this.sessionStore.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    if (current.model || current.effort) {
      return;
    }

    const catalog = this.sessionStore.getAvailableModelCatalog();
    const models = Array.isArray(catalog?.models) ? catalog.models : [];
    const defaultModel = this.config.defaultCodexModel
      ? findModelByQuery(models, this.config.defaultCodexModel)
      : (models.find((item) => item.isDefault) || models[0] || null);
    const defaultEffort = this.config.defaultCodexEffort
      || defaultModel?.defaultReasoningEffort
      || "";

    this.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
      model: defaultModel?.model || this.config.defaultCodexModel || "",
      effort: defaultEffort,
    });
  }

  getCodexParamsForWorkspace(bindingKey, workspaceRoot) {
    const current = this.sessionStore.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    if (current.model || current.effort) {
      return current;
    }
    return {
      model: this.config.defaultCodexModel || "",
      effort: this.config.defaultCodexEffort || "",
    };
  }

  async resolveWorkspaceStats(workspaceRoot) {
    try {
      const stats = await fs.promises.stat(workspaceRoot);
      return {
        exists: true,
        isDirectory: stats.isDirectory(),
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { exists: false, isDirectory: false };
      }
      throw error;
    }
  }

  async resolveWorkspaceThreadState({ bindingKey, workspaceRoot, normalized, autoSelectThread = true }) {
    const threads = await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const selectedThreadId = this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadId = selectedThreadId || (autoSelectThread ? (threads[0]?.id || "") : "");
    if (!selectedThreadId && threadId) {
      this.sessionStore.setThreadIdForWorkspace(
        bindingKey,
        workspaceRoot,
        threadId,
        codexMessageUtils.buildBindingMetadata(normalized)
      );
    }
    if (threadId) {
      this.bindingKeyByThreadId.set(threadId, bindingKey);
      this.workspaceRootByThreadId.set(threadId, workspaceRoot);
    }
    return { threads, threadId, selectedThreadId };
  }

  async refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized) {
    try {
      const threads = await this.listCodexThreadsForWorkspace(workspaceRoot);
      const currentThreadId = this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      const shouldKeepCurrentThread = currentThreadId && this.resumedThreadIds.has(currentThreadId);
      if (currentThreadId && !shouldKeepCurrentThread && !threads.some((thread) => thread.id === currentThreadId)) {
        this.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      }
      return threads;
    } catch (error) {
      console.warn(`[codex-wechat] thread/list failed for workspace=${workspaceRoot}: ${error.message}`);
      return [];
    }
  }

  async listCodexThreadsForWorkspace(workspaceRoot) {
    const allThreads = [];
    const seenThreadIds = new Set();
    let cursor = null;

    for (let page = 0; page < 10; page += 1) {
      const response = await this.codex.listThreads({
        cursor,
        limit: 200,
        sortKey: "updated_at",
      });
      const pageThreads = codexMessageUtils.extractThreadsFromListResponse(response);
      for (const thread of pageThreads) {
        if (!THREAD_SOURCE_KINDS.has(thread.sourceKind)) {
          continue;
        }
        if (seenThreadIds.has(thread.id)) {
          continue;
        }
        seenThreadIds.add(thread.id);
        allThreads.push(thread);
      }

      const nextCursor = codexMessageUtils.extractThreadListCursor(response);
      if (!nextCursor || nextCursor === cursor) {
        break;
      }
      cursor = nextCursor;
      if (pageThreads.length === 0) {
        break;
      }
    }

    return filterThreadsByWorkspaceRoot(allThreads, workspaceRoot);
  }

  async ensureThreadAndSendMessage({ bindingKey, workspaceRoot, normalized, threadId }) {
    const codexParams = this.getCodexParamsForWorkspace(bindingKey, workspaceRoot);

    if (!threadId) {
      const createdThreadId = await this.createWorkspaceThread({
        bindingKey,
        workspaceRoot,
        normalized,
      });
      this.pendingChatContextByThreadId.set(createdThreadId, normalized);
      await this.codex.sendUserMessage({
        threadId: createdThreadId,
        text: normalized.text,
        model: codexParams.model || null,
        effort: codexParams.effort || null,
        accessMode: this.config.defaultCodexAccessMode,
        workspaceRoot,
      });
      this.bindingKeyByThreadId.set(createdThreadId, bindingKey);
      this.workspaceRootByThreadId.set(createdThreadId, workspaceRoot);
      return createdThreadId;
    }

    try {
      this.pendingChatContextByThreadId.set(threadId, normalized);
      await this.ensureThreadResumed(threadId);
      await this.codex.sendUserMessage({
        threadId,
        text: normalized.text,
        model: codexParams.model || null,
        effort: codexParams.effort || null,
        accessMode: this.config.defaultCodexAccessMode,
        workspaceRoot,
      });
      this.bindingKeyByThreadId.set(threadId, bindingKey);
      this.workspaceRootByThreadId.set(threadId, workspaceRoot);
      return threadId;
    } catch (error) {
      if (!shouldRecreateThread(error)) {
        throw error;
      }
      this.resumedThreadIds.delete(threadId);
      this.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      const recreatedThreadId = await this.createWorkspaceThread({
        bindingKey,
        workspaceRoot,
        normalized,
      });
      await this.codex.sendUserMessage({
        threadId: recreatedThreadId,
        text: normalized.text,
        model: codexParams.model || null,
        effort: codexParams.effort || null,
        accessMode: this.config.defaultCodexAccessMode,
        workspaceRoot,
      });
      this.bindingKeyByThreadId.set(recreatedThreadId, bindingKey);
      this.workspaceRootByThreadId.set(recreatedThreadId, workspaceRoot);
      return recreatedThreadId;
    }
  }

  async createWorkspaceThread({ bindingKey, workspaceRoot, normalized }) {
    const response = await this.codex.startThread({ cwd: workspaceRoot });
    const threadId = codexMessageUtils.extractThreadId(response);
    if (!threadId) {
      throw new Error("thread/start did not return a thread id");
    }
    this.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      threadId,
      codexMessageUtils.buildBindingMetadata(normalized)
    );
    this.resumedThreadIds.add(threadId);
    this.pendingChatContextByThreadId.set(threadId, normalized);
    this.bindingKeyByThreadId.set(threadId, bindingKey);
    this.workspaceRootByThreadId.set(threadId, workspaceRoot);
    return threadId;
  }

  async ensureThreadResumed(threadId) {
    const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    if (!normalizedThreadId || this.resumedThreadIds.has(normalizedThreadId)) {
      return null;
    }

    const response = await this.codex.resumeThread({ threadId: normalizedThreadId });
    this.resumedThreadIds.add(normalizedThreadId);
    return response;
  }

  describeWorkspaceStatus(threadId) {
    if (!threadId) {
      return { code: "idle", label: "空闲" };
    }
    if (this.pendingApprovalByThreadId.has(threadId)) {
      return { code: "approval", label: "等待授权" };
    }
    if (this.activeTurnIdByThreadId.has(threadId)) {
      return { code: "running", label: "运行中" };
    }
    return { code: "idle", label: "空闲" };
  }

  async sendReplyToNormalized(normalized, text) {
    return this.sendReplyToUser(normalized.senderId, text, normalized.contextToken);
  }

  async sendReplyToUser(userId, text, contextToken = "") {
    const resolvedToken = contextToken || this.contextTokenByUserId.get(userId) || "";
    if (!resolvedToken) {
      throw new Error(`缺少 context_token，无法回复用户 ${userId}`);
    }

    const plainText = markdownToPlainText(text) || "已完成。";
    const chunks = chunkReplyText(plainText);
    for (const chunk of chunks.length ? chunks : ["已完成。"]) {
      await sendMessage({
        baseUrl: this.account.baseUrl,
        token: this.account.token,
        body: {
          msg: {
            client_id: crypto.randomUUID(),
            from_user_id: "",
            to_user_id: userId,
            message_type: 2,
            message_state: 2,
            item_list: [
              {
                type: 1,
                text_item: { text: chunk },
              },
            ],
            context_token: resolvedToken,
          },
        },
      });
    }
  }

  async startTypingForThread(threadId, normalized) {
    if (!this.config.enableTyping || !threadId) {
      return;
    }

    await this.stopTypingForThread(threadId);
    const contextToken = normalized.contextToken || this.contextTokenByUserId.get(normalized.senderId) || "";
    if (!contextToken) {
      return;
    }

    const configResponse = await getConfig({
      baseUrl: this.account.baseUrl,
      token: this.account.token,
      ilinkUserId: normalized.senderId,
      contextToken,
    }).catch(() => null);
    const typingTicket = typeof configResponse?.typing_ticket === "string"
      ? configResponse.typing_ticket.trim()
      : "";
    if (!typingTicket) {
      return;
    }

    const sendStatus = async (status) => {
      await sendTyping({
        baseUrl: this.account.baseUrl,
        token: this.account.token,
        body: {
          ilink_user_id: normalized.senderId,
          typing_ticket: typingTicket,
          status,
        },
      });
    };

    await sendStatus(1).catch(() => {});
    const timer = setInterval(() => {
      sendStatus(1).catch(() => {});
    }, TYPING_KEEPALIVE_MS);

    this.typingStopByThreadId.set(threadId, async () => {
      clearInterval(timer);
      await sendStatus(2).catch(() => {});
    });
  }

  async stopTypingForThread(threadId) {
    const stop = this.typingStopByThreadId.get(threadId);
    if (!stop) {
      return;
    }
    this.typingStopByThreadId.delete(threadId);
    await stop();
  }

  async handleCodexMessage(message) {
    codexMessageUtils.trackRunningTurn(this.activeTurnIdByThreadId, message);
    codexMessageUtils.trackPendingApproval(this.pendingApprovalByThreadId, message);
    codexMessageUtils.trackRunKeyState(this.currentRunKeyByThreadId, this.activeTurnIdByThreadId, message);

    const outbound = codexMessageUtils.mapCodexMessageToImEvent(message);
    if (!outbound) {
      return;
    }

    const threadId = outbound.payload?.threadId || "";
    if (outbound.type === "im.agent_reply") {
      this.appendAssistantReplyBuffer(message, outbound);
      return;
    }

    if (outbound.type === "im.approval_request") {
      await this.handleApprovalRequest(threadId);
      return;
    }

    if (outbound.type === "im.run_state") {
      await this.handleRunState(outbound);
    }
  }

  appendAssistantReplyBuffer(message, outbound) {
    const threadId = outbound.payload.threadId || "";
    const turnId = outbound.payload.turnId || this.activeTurnIdByThreadId.get(threadId) || "";
    if (!threadId) {
      return;
    }
    const runKey = this.currentRunKeyByThreadId.get(threadId) || codexMessageUtils.buildRunKey(threadId, turnId);
    const current = this.replyBufferByRunKey.get(runKey) || "";
    const text = outbound.payload.text || "";
    if (!text) {
      return;
    }

    if (message?.method === "item/agentMessage/delta") {
      this.replyBufferByRunKey.set(runKey, `${current}${text}`);
      return;
    }

    if (!current) {
      this.replyBufferByRunKey.set(runKey, text);
    }
  }

  async handleApprovalRequest(threadId) {
    if (!threadId) {
      return;
    }
    const approval = this.pendingApprovalByThreadId.get(threadId);
    if (!approval) {
      return;
    }

    const workspaceRoot = this.workspaceRootByThreadId.get(threadId) || "";
    if (this.shouldAutoApproveRequest(workspaceRoot, approval)) {
      const outcome = await this.applyApprovalDecision({
        threadId,
        approval,
        command: "approve",
        workspaceRoot,
        scope: "once",
      });
      if (!outcome.error) {
        return;
      }
    }

    await this.stopTypingForThread(threadId);
    const context = this.pendingChatContextByThreadId.get(threadId);
    if (!context) {
      return;
    }
    const commandText = approval.command || approval.reason || "(unknown)";
    const text = [
      "Codex 请求授权：",
      commandText,
      "",
      "回复以下命令继续：",
      "/codex approve",
      "/codex approve workspace",
      "/codex reject",
    ].join("\n");
    await this.sendReplyToUser(context.senderId, text, context.contextToken);
  }

  shouldAutoApproveRequest(workspaceRoot, approval) {
    if (!workspaceRoot || !approval) {
      return false;
    }
    const cachedAllowlist = this.approvalAllowlistByWorkspaceRoot.get(workspaceRoot) || [];
    const allowlist = cachedAllowlist.length
      ? cachedAllowlist
      : this.sessionStore.getApprovalCommandAllowlistForWorkspace(workspaceRoot);
    if (allowlist.length && !cachedAllowlist.length) {
      this.approvalAllowlistByWorkspaceRoot.set(workspaceRoot, allowlist);
    }
    if (!allowlist.length) {
      return false;
    }
    return codexMessageUtils.matchesCommandPrefix(approval.commandTokens, allowlist);
  }

  rememberApprovalPrefixForWorkspace(workspaceRoot, commandTokens) {
    if (!workspaceRoot) {
      return;
    }
    this.sessionStore.rememberApprovalCommandPrefixForWorkspace(workspaceRoot, commandTokens);
    this.approvalAllowlistByWorkspaceRoot.set(
      workspaceRoot,
      this.sessionStore.getApprovalCommandAllowlistForWorkspace(workspaceRoot)
    );
  }

  async applyApprovalDecision({ threadId, approval, command, workspaceRoot = "", scope = "once" }) {
    const decision = command === "approve" ? "accept" : "decline";
    const isWorkspaceScope = scope === "workspace";
    const requestKey = `${threadId}:${String(approval.requestId || "").trim()}`;
    if (!requestKey || this.inFlightApprovalRequestKeys.has(requestKey)) {
      return {
        error: null,
        ignoredAsDuplicate: true,
        decision,
        scope: isWorkspaceScope ? "workspace" : "once",
        method: approval.method,
      };
    }
    this.inFlightApprovalRequestKeys.add(requestKey);

    try {
      if (
        decision === "accept"
        && isWorkspaceScope
        && codexMessageUtils.isCommandApprovalMethod(approval.method)
      ) {
        this.rememberApprovalPrefixForWorkspace(workspaceRoot, approval.commandTokens);
      }

      await this.codex.sendResponse(
        approval.requestId,
        codexMessageUtils.buildApprovalResponsePayload(decision)
      );
      this.pendingApprovalByThreadId.delete(threadId);
      return {
        error: null,
        ignoredAsDuplicate: false,
        decision,
        scope: isWorkspaceScope ? "workspace" : "once",
        method: approval.method,
      };
    } catch (error) {
      return {
        error,
        ignoredAsDuplicate: false,
        decision,
        scope: isWorkspaceScope ? "workspace" : "once",
        method: approval.method,
      };
    } finally {
      this.inFlightApprovalRequestKeys.delete(requestKey);
    }
  }

  async handleRunState(outbound) {
    const threadId = outbound.payload.threadId || "";
    const turnId = outbound.payload.turnId || this.activeTurnIdByThreadId.get(threadId) || "";
    const runKey = this.currentRunKeyByThreadId.get(threadId) || codexMessageUtils.buildRunKey(threadId, turnId);
    const bufferedText = this.replyBufferByRunKey.get(runKey) || "";
    const context = this.pendingChatContextByThreadId.get(threadId);

    if (outbound.payload.state === "streaming") {
      return;
    }

    await this.stopTypingForThread(threadId);

    if (context) {
      if (outbound.payload.state === "completed") {
        await this.sendReplyToUser(context.senderId, bufferedText || "已完成。", context.contextToken);
      } else if (outbound.payload.state === "failed") {
        const text = bufferedText
          ? `${bufferedText}\n\n${outbound.payload.text || "执行失败"}`
          : (outbound.payload.text || "执行失败");
        await this.sendReplyToUser(context.senderId, text, context.contextToken);
      }
    }

    this.replyBufferByRunKey.delete(runKey);
    this.activeTurnIdByThreadId.delete(threadId);
    this.pendingApprovalByThreadId.delete(threadId);
  }
}

function shouldRecreateThread(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("thread not found") || message.includes("unknown thread");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { WechatRuntime };
