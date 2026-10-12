# Friction log: Contest Coach (Amazon Developer Hackathon, Alexa+ track)

Each entry: task, steps, expected vs. actual, severity, workaround, suggestion.

## 1. Testing a self-hosted MCP server against real Alexa+
- **Task:** call my MCP server (spec 2025-11-25, Streamable HTTP) from Alexa+.
- **Steps:** looked for an Alexa+ developer console, simulator, or documented way to register a self-hosted MCP URL.
- **Expected:** a test path for builders, even without a published skill.
- **Actual:** none without Alexa+ preview access.
- **Severity:** high, because you can't verify tool selection or speech output on the real assistant.
- **Workaround:** simulated Alexa+ with GitHub Copilot CLI as the MCP client and an Echo Show-style page (`demo/`).
- **Suggestion:** a hosted "Alexa+ MCP inspector" that accepts a public HTTPS MCP URL and shows the tools Alexa+ picked, their arguments, and the spoken response.

## 2. Stateless Streamable HTTP in the MCP TypeScript SDK
- **Task:** serve MCP without sessions (one server and transport per request), which is simplest for a serverless or voice backend.
- **Steps:** followed the SDK README, which leads with the session-based example.
- **Expected:** a stateless example next to the stateful one.
- **Actual:** I had to infer `sessionIdGenerator: undefined` and per-request `McpServer` construction from the source and examples.
- **Severity:** low.
- **Workaround:** read `server/streamableHttp` and the examples.
- **Suggestion:** put a 15-line stateless Express example in the README.

## 3. Seeing exactly what the agent called
- **Task:** show the user (and the judges) which MCP tools the agent called, with which arguments.
- **Steps:** parsed the agent's (Copilot CLI) console output.
- **Expected:** full tool calls.
- **Actual:** the display truncates long arguments (`tag: "binary…`), which broke parsing and crashed the demo once.
- **Severity:** medium.
- **Workaround:** an opt-in call log in the server (`COACH_RECORD_CALLS=1`, `GET /recent-calls`).
- **Suggestion:** MCP clients could emit a machine-readable trace of tool calls; Alexa+ could expose one in a developer view.

## 4. Voice latency through a general-purpose agent
- **Task:** answer a spoken question quickly.
- **Actual:** 12–17 s per request through Copilot CLI (most of it model time; the MCP tools answer in under 1 s, with caching).
- **Severity:** medium for voice.
- **Workaround:** tools return a ready-to-speak sentence so the agent doesn't need extra reasoning, and API responses are cached for 10 minutes.
- **Suggestion:** document Alexa+ latency budgets for MCP tools, and a "speakable" result field the assistant can read directly.

## 5. Large public datasets
- **Task:** recommend unsolved problems near the user's rating.
- **Actual:** Codeforces `problemset.problems` returns about 10,000 problems per call.
- **Severity:** low.
- **Workaround:** a 10-minute in-memory cache.
- **Suggestion:** none for Amazon. Noted for other builders: cache upstream data in MCP tools meant for voice.
