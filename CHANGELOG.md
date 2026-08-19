# Changelog

## [2.1.0] - ReAct Loop Integration

### Added
- **ReActLoopAgent** now runs as default behavior for complex queries in the chat
- **Heuristic detection** (`shouldUseReAct`) triggers ReAct on:
  - Calculate, search, compare, analyze, code, data queries
  - Current info (dates, weather, population)
  - Multi-part questions (2+ conjunctions)
  - Long questions (>100 chars)
- **Expanded tool suite** in ReAct loop:
  - `get_weather[location]` — weather via wttr.in
  - `get_time[timezone]` — current date/time
  - `mcp_call[server.method]` — LNCC-SDumont MCP tools
  - Custom tool registration via `registerTool()`
- **Robust parser** with retry logic (3 attempts) and fallback to direct answer
- **Context summarization** when context exceeds 8000 chars
- **Streaming support** via `executeStreaming()` for real-time UI updates
- **Automatic MCP tool integration** — all `customMCPTools` registered as ReAct tools

### Changed
- `api-router.ts`: ReAct loop integrated into `/v1/chat/completions` endpoint
- `agents/index.ts`: `registerAllAgents()` now returns `ReActLoopAgent` instance
- `react-loop-agent.ts`: Major refactor with full tool registry and error resilience

### Fixed
- Parser no longer fails on accent variations ("Ação" vs "Acao" vs "Action")
- Graceful fallback when Docker is unavailable for code execution
- Context truncation with intelligent summarization instead of hard cut

## [2.0.0] - Otimizado

### Added
- LoopEngineering (plan → execute → evaluate → adapt)
- AgentEngine with dynamic registration
- CodeLoopAgent, PromptEngineerAgent, TaskPlannerAgent
- ReActLoopAgent (specialized agent only)
- SandboxService with Docker + local fallback
- SearchService (DuckDuckGo + Wikipedia)
- MemoryService / MetricsService (JSONL persistence)
- MCP tools bridge
- OpenAI/Ollama-compatible API proxy
- Playwright-based LNCC authentication
- IndexedDB conversation persistence
- Streaming SSE with optimized chunks
- Continue generation (up to 5 attempts)
- Rate limiting, compression, helmet security
- Docker Compose deployment
