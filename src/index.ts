/**
 * 包入口。
 *
 * 分层导出，调用方按需取用：
 * - 想直接用内核：`AgentRuntime`；
 * - 想一次调用拿到结果：`query()`（与 `mod --print` 同一内核，ADR-10）；
 * - 想嵌到自己的程序里跑 CLI：`runCli()`（可注入假 I/O，见 `createMemoryIo`）。
 */

/* 运行时内核 */
export { AgentRuntime } from "./runtime/runtime.js"
export type {
  CreateTaskInput,
  DoctorReport,
  RunOptions,
  RuntimeOptions,
} from "./runtime/runtime.js"
export { driveTask, exitCodeFor, EXIT_OK, EXIT_ERROR, EXIT_BLOCKED } from "./runtime/driver.js"
export type {
  ApprovalResolution,
  ApprovalResolver,
  DriveOptions,
  DriveResult,
  PendingApproval,
} from "./runtime/driver.js"
export { runTask } from "./runtime/loop.js"
export type { LoopDeps, LoopOptions, LoopOutcome } from "./runtime/loop.js"
export { ProgressGuard } from "./runtime/progress.js"
export { checkBudget, assertWithinBudget, budgetPressure } from "./runtime/budget.js"
export { canTransition, assertTransition, IllegalTransitionError } from "./runtime/state-machine.js"

/* Agent SDK */
export { query } from "./sdk/index.js"
export type { QueryOptions, QueryResult } from "./sdk/index.js"

/* CLI（可复用、可测） */
export { runCli, CREDENTIAL_ENV } from "./cli/index.js"
export type { CliContext } from "./cli/index.js"
export { CliSession } from "./cli/session.js"
export { createProcessIo, createMemoryIo } from "./cli/io.js"
export type { CliIo } from "./cli/io.js"
export { createInteractivePrompter, createDenyResolver } from "./cli/approval.js"
export { parseOutputFormat, renderEventText, buildJsonResult } from "./cli/render.js"

/* 模型层 */
export { ModelGateway, backoffDelay } from "./model/gateway.js"
export type { GatewayOptions, UsageTotals, ModelStreamEvent } from "./model/gateway.js"
export { AnthropicProvider } from "./model/anthropic.js"
export { OpenAICompatProvider } from "./model/openai-compat.js"
export { ScriptedProvider, ScriptExhaustedError, toolUse, final, ask } from "./model/scripted.js"
export type { ScriptStep } from "./model/scripted.js"
export { estimateCost, DEFAULT_PRICING } from "./model/types.js"
export {
  resolveModelProfile,
  resolveContextWindowTokens,
  DEFAULT_MODEL_PROFILE,
} from "./model/catalog.js"
export type { ModelProfile } from "./model/catalog.js"
export type {
  ModelProvider,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelDelta,
  ModelStreamChunk,
  ToolSpec,
} from "./model/types.js"

/* 工具层 */
export { ToolRegistry, DuplicateToolError } from "./tools/registry.js"
export { ToolExecutor } from "./tools/executor.js"
export {
  createListFilesTool,
  createReadFileTool,
  createSearchTextTool,
  createGitStatusTool,
  createReadDiffTool,
} from "./tools/builtin/repo.js"
export { createEditFileTool, createWriteFileTool } from "./tools/builtin/edit.js"
export { createCommandRunTool, createTestRunTool, discoverChecks } from "./tools/builtin/command.js"
export {
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createToolSearchTool,
} from "./tools/builtin/plan.js"

/* 安全与编辑 */
export { PolicyEngine } from "./policy/engine.js"
export { PathGuard, CODE_LIKE_PATHS } from "./policy/pathguard.js"
export {
  parseCommandLine,
  splitCommandLine,
  stripWrappers,
  isUnresolvableShape,
} from "./policy/command.js"
export { EditEngine } from "./patch/edit.js"
export { diffText, formatUnifiedDiff, summarize } from "./patch/diff.js"
export { selectSandbox, RestrictedSubprocessBackend, DockerBackend } from "./sandbox/index.js"
export { runProcess, killTree } from "./sandbox/process-runner.js"

/* 上下文与验证 */
export {
  buildStaticSystemPrompt,
  buildDynamicContext,
  buildUserRequest,
} from "./context/system-prompt.js"
export { bundleRules, collectRuleFiles, RULE_FILE_NAMES } from "./context/rules.js"
export { compact, dedupeMessages, shouldCompact } from "./context/compaction.js"
export { runChecks, mapAcceptance, summarizeReport } from "./validation/runner.js"

/* 存储与可观测 */
export { createStore, SqliteStore } from "./store/sqlite.js"
export { MemoryStore } from "./store/memory.js"
export { VersionConflictError } from "./store/types.js"
export type {
  Store,
  TaskState,
  Checkpoint,
  ApprovalRecord,
  ToolCallRecord,
  ArtifactRecord,
} from "./store/types.js"
export { Logger, Metrics, noopLogger } from "./observability/logger.js"

/* 配置与契约 */
export { DEFAULT_SETTINGS, loadSettings, mergeSettings, SettingsSchema } from "./config/settings.js"
export type { Settings, SettingsLayer, LoadedSettings } from "./config/settings.js"
export * from "./shared/contracts.js"
export { AppError, ERROR_CODES, toAppError, RETRYABLE } from "./shared/errors.js"
export { parameterHash, sha256, stableStringify } from "./shared/hash.js"
export { stripInvisibleCharacters, redactSecrets, filterEnv } from "./shared/sanitize.js"
export { estimateTokens, clipByTokens } from "./shared/tokens.js"
