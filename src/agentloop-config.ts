import * as dotenv from "dotenv";
import { loadConfig } from "./config/load";
import type { AgentLoopConfig } from "./config/schema";

dotenv.config({ quiet: true });

// ---------------------------------------------------------------------------
// Load the structured layered configuration
// ---------------------------------------------------------------------------

let _resolvedConfig: AgentLoopConfig | undefined;
try {
  _resolvedConfig = loadConfig();
} catch (err) {
  // Surface config-load errors clearly and exit
  process.stderr.write(`Configuration error: ${(err as Error).message}\n`);
  process.exit(1);
}

// After the try/catch, _resolvedConfig is always assigned (process.exit on error).
// TypeScript can't prove this, so we assert.
const _config = _resolvedConfig!;

// ---------------------------------------------------------------------------
// Derive the flat appConfig from the structured config for backward compat.
// ---------------------------------------------------------------------------

const c = _config;

export const appConfig = {
  // No API keys needed - all requests go through Carcara Proxy (localhost:3030)
  // LLM / agent loop
  maxIterations: c.llm.maxIterations,
  maxTokensBudget: c.llm.maxTokensBudget,
  maxContextTokens: c.llm.maxContextTokens,
  llmRetryMax: c.llm.retryMax,
  llmRetryBaseDelayMs: c.llm.retryBaseDelayMs,
  toolTimeoutMs: c.tools.timeoutMs,
  llmProvider: c.llm.provider,
  llmModel: c.llm.model ?? "",
  llmTemperature: c.llm.temperature,
  systemPromptPath: c.paths.systemPromptPath ?? "",
  autoApproveAll: c.tools.autoApproveAll,
  toolAllowlist: c.tools.allowlist,
  toolBlocklist: c.tools.blocklist,
  shellCommandBlocklist: c.tools.shellCommandBlocklist,
  executionTimeoutMs: c.execution.timeoutMs,
  executionEnvironment: c.execution.environment,
  workspaceRoot: c.paths.workspaceRoot ?? process.cwd(),
  mcpServers: [],
  maxFileSizeBytes: c.security.maxFileSizeBytes,
  maxShellOutputBytes: c.security.maxShellOutputBytes,
  maxConcurrentTools: c.tools.maxConcurrent,
  networkAllowedDomains: c.security.networkAllowedDomains,
  sandboxMode: c.execution.sandboxMode,
  sandboxDockerImage: c.execution.dockerImage,
  streamingEnabled: c.llm.streamingEnabled,
  instructionsRoot:
    c.paths.instructionsRoot ??
    c.paths.workspaceRoot ??
    process.cwd(),
  promptTemplatesDir: c.paths.promptTemplatesDir ?? "",
  promptHistoryFile: c.paths.promptHistoryFile ?? "",
  promptContextRefreshMs: c.prompts.contextRefreshMs,
  recordLlmResponses:
    process.env.RECORD_LLM_RESPONSES?.toLowerCase() === "true"
      ? true
      : false,
  llmFixtureDir:
    process.env.LLM_FIXTURE_DIR ?? "tests/fixtures/llm-responses",
  webSearchProvider: c.search.provider as
    | "duckduckgo"
    | "tavily"
    | "langsearch"
    | "none",
  tavilyApiKey: "",
  tavilyMaxResults: c.search.tavilyMaxResults ?? 5,
  langsearchApiKey: "",
  langsearchMaxResults: c.search.langsearchMaxResults ?? 5,
  duckduckgoMaxResults: c.search.duckduckgoMaxResults ?? 5,
  duckduckgoMinDelayMs: c.search.duckduckgoMinDelayMs ?? 1000,
  duckduckgoRetryMax: c.search.duckduckgoRetryMax ?? 2,
  duckduckgoRetryBaseDelayMs: c.search.duckduckgoRetryBaseDelayMs ?? 400,
  duckduckgoRateLimitPenaltyMs:
    c.search.duckduckgoRateLimitPenaltyMs ?? 1000,
  duckduckgoCacheTtlMs: c.search.duckduckgoCacheTtlMs ?? 300000,
  duckduckgoCacheMaxEntries: c.search.duckduckgoCacheMaxEntries ?? 128,
  duckduckgoServeStaleOnError:
    c.search.duckduckgoServeStaleOnError ?? true,
  webDomainBlocklist: c.webFetch.domainBlocklist,
  webDomainAllowlist: c.webFetch.domainAllowlist,
  webAllowHttp: c.webFetch.allowHttp,
  webMaxResponseBytes: c.webFetch.maxResponseBytes,
  webMaxContentChars: c.webFetch.maxContentChars,
  webUserAgent: c.webFetch.userAgent,
  webFetchTimeoutMs: c.webFetch.fetchTimeoutMs,
  runtimeContextEnabled: c.prompts.runtimeContextEnabled,
  uiMode: (process.env.UI_MODE ?? "cli").toLowerCase(),
  skillsDir: c.paths.skillsDir ?? "",
  agentProfilesDir: c.paths.agentProfilesDir ?? "",
  orchestrator: (process.env.ORCHESTRATOR ?? "default").toLowerCase() as
    | "default"
    | "langgraph",
  planOnly:
    process.env.PLAN_ONLY?.toLowerCase() === "true" ? true : false,
  tracingEnabled: c.observability.tracingEnabled,
  traceOutputDir: c.observability.traceOutputDir,
  tracingCostPerInputTokenUsd:
    c.observability.tracingCostPerInputTokenUsd,
  tracingCostPerOutputTokenUsd:
    c.observability.tracingCostPerOutputTokenUsd,
  logger: {
    level: c.observability.logLevel,
    enabled: c.observability.logEnabled,
    destination: c.observability.logDestination,
    file: c.observability.logFile ?? "",
    name: c.observability.logName,
    timestamp: c.observability.logTimestamp,
  },
};

// ---------------------------------------------------------------------------
// Expose the structured config for new code that wants the full typed config
// ---------------------------------------------------------------------------

/** The fully resolved structured config (read-only). */
export const resolvedConfig: Readonly<AgentLoopConfig> = _config;
