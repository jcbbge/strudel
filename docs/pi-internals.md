# Pi Coding Agent — Internals Reference

> Source base: `~/strudel-lab/packages/` — Pi v0.74 fork, lightly rebranded as `@strudel/*`.
> All `file:line` citations use paths under that root. Fork-specific deviations
> (system prompt, empty default tools) are marked. Upstream is now v0.80.2 (minor drift).
> Produced by a deep-dive research pass; companion presentation: `pi-internals.html`.

---

## Executive summary

Pi is a four-package TypeScript monorepo: a provider-agnostic LLM agent loop
(`@strudel/agent-core`), a provider/model abstraction (`@strudel/ai`), a
coding-agent harness (`@strudel/coding-agent`), and a terminal-UI primitives
library (`@strudel/tui`). The dependency graph is strictly layered — agent-core
and ai know nothing of coding-agent or tui. The loop in agent-core is a pure,
side-effect-free event emitter: it receives a context snapshot, streams an LLM
response, executes tools, and emits typed events; all persistence, extension
dispatch, compaction, and UI live in the coding-agent layer that subscribes to
those events. Extensions are isolated TypeScript modules loaded at runtime via
`jiti`, given a typed `ExtensionAPI` with ~25 lifecycle hooks, able to mutate
messages, system prompt, tool calls, tool results, and provider payloads. `pi
install` manages npm/git/local extension packages. Skills are Markdown files
injected into the system prompt as XML; slash-commands are text-expansion macros.
The design optimizes for thin testable primitives at the bottom, maximum hook
surface in the middle, and a fully replaceable UI/session layer at the top.

---

## 1. Invocation lifecycle — start → end

### 1A. Process start

```
cli.ts:22          main(process.argv.slice(2))
  ├─ main.ts:431   handlePackageCommand(args)        // early exit for `pi install`
  ├─ main.ts:435   handleConfigCommand(args)         // early exit for `pi config`
  ├─ main.ts:439   parseArgs(args)
  ├─ main.ts:488   SettingsManager.create(cwd, agentDir)
  ├─ main.ts:501   createSessionManager(parsed, ...) // resolve/open/fork JSONL
  ├─ main.ts:522   createAgentSessionRuntime(...)    // agent-session-runtime.ts:408
  │    └─ createAgentSessionServices()
  │         ├─ SettingsManager.create()
  │         ├─ ModelRegistry.create()
  │         ├─ DefaultResourceLoader.reload()        // extensions, skills, prompts, themes
  │         └─ discoverAndLoadExtensions()           // loader.ts:575
  │              └─ per path: loadExtension() → jiti.import(path) + factory(api)
  │    └─ createAgentSessionFromServices()
  │         └─ sdk.ts:174 createAgentSession()
  │              ├─ new Agent(...)                   // agent-core/agent.ts
  │              └─ new AgentSession(...)            // agent-session.ts
  ├─ main.ts:687   new InteractiveMode(runtime, ...)
  └─ main.ts:711   interactiveMode.run()            // enters TUI event loop
```

### 1B. User submits a prompt (interactive)

```
AgentSession.prompt(text, options)              // agent-session.ts:953
  1. _tryExecuteExtensionCommand(text)          // :1099  → return if handled
  2. runner.emitInput(text, images, source)     // runner.ts:1007  → may transform/handle
  3. _expandSkillCommand() + expandPromptTemplate()  // :1130
  4. guard: if streaming → queue (steer/followUp), return
  5. modelRegistry.hasConfiguredAuth(model)
  6. _checkCompaction(lastAssistant, false)     // pre-turn
  7. build messages[] = [user msg + pending nextTurn msgs]
  8. runner.emitBeforeAgentStart(...)           // runner.ts:892
       → returns {messages?, systemPrompt?}; applies systemPrompt override
  9. agent.prompt(messages)                     // agent-core/agent.ts:321
       └─ runPromptMessages() → runWithLifecycle(() => runAgentLoop(...))  // agent-loop.ts:31
```

### 1C. Inside `runAgentLoop` (agent-core/agent-loop.ts)

```
runAgentLoop(prompts, context, config, emit, signal)        // :95
  emit(agent_start); emit(turn_start); emit(message_start/end per prompt)
  runLoop(context, newMessages, config, signal, emit)        // :155
    OUTER LOOP (follow-up messages):
      INNER LOOP (while toolCalls || pendingSteering):
        streamAssistantResponse(context, config, signal, emit)   // :275
          config.transformContext(messages, signal)   // ← `context` event hook
          config.convertToLlm(messages)               // AgentMessage[] → Message[]
          streamSimple(model, {systemPrompt, messages, tools}, ...)  // @strudel/ai HTTP
          stream events → emit(message_start | message_update | message_end)
        if toolCalls:
          executeToolCalls(...)                         // :373
            prepareToolCall() → config.beforeToolCall() // ← `tool_call` hook
            executePreparedToolCall() → tool.execute(id, args, signal, onUpdate)
            config.afterToolCall()                      // ← `tool_result` hook
            emit(tool_execution_start | _update | _end)
        emit(turn_end)
        config.shouldStopAfterTurn?() / getSteeringMessages?()
      getFollowUpMessages?()
  emit(agent_end)
```

### 1D. Event fan-out back to the session

Every `emit()` → `Agent.processEvents(event)` (agent.ts:505): mutates `_state`,
then calls each listener. `AgentSession._handleAgentEvent` is the sole listener
(agent-session.ts:316) → queues `_processAgentEvent` (serialized). Inside
`_processAgentEvent` (:486): dispatch to `ExtensionRunner` → fan-out to UI →
on `message_end` `sessionManager.appendMessage()` (JSONL) → on `agent_end`
`_checkCompaction()` / `_handleRetryableError()`.

### Extension event fire points (within the lifecycle)

| When | Method |
|---|---|
| Before LLM call: context transform | `runner.emitContext(messages)` (agent-loop.ts:285) |
| Before provider HTTP request | `runner.emitBeforeProviderRequest(payload)` (sdk.ts:333) |
| After provider response headers | `after_provider_response` (sdk.ts:340) |
| Before agent loop (per turn) | `runner.emitBeforeAgentStart()` (agent-session.ts:1056) |
| agent_start / turn_start / message_* | `runner.emit(...)` (agent-session.ts:622–668) |
| tool_call (before exec) | `runner.emitToolCall()` (agent-session.ts:365) |
| tool_execution_start/update/end | `runner.emit(...)` (agent-session.ts:666–691) |
| tool_result (after exec) | `runner.emitToolResult()` (agent-session.ts:388) |
| turn_end / agent_end | `runner.emit(...)` (agent-session.ts:625–634) |

---

## 2. Data flow

### Key structures

| Structure | Where | Purpose |
|---|---|---|
| `AgentMessage` | agent/src/types.ts:301 | Union of `Message` + app custom messages. The conversation type. |
| `AgentContext` | agent/src/types.ts:379 | Snapshot `{systemPrompt, messages, tools}` passed into the loop |
| `AgentLoopConfig` | agent/src/types.ts:127 | Stateless config: model, convertToLlm, hooks |
| `AgentTool` | agent/src/types.ts:353 | `{name, description, parameters, execute(), executionMode?}` |
| `AgentState` | agent/src/types.ts:309 | Live mutable: systemPrompt, model, tools[], messages[], isStreaming |
| `Extension` | extensions/types.ts:1432 | handlers/tools/commands/flags/shortcuts Maps |

### Message flow

```
USER INPUT (text + images)
  → AgentSession.prompt()
      ├ input event (transform)
      ├ skill/template expansion
      ├ before_agent_start (prepend custom msgs, replace systemPrompt)
  → Agent.prompt(messages)
  → createContextSnapshot()  → AgentContext{systemPrompt, messages, tools}  (slice() — a copy)
  → runAgentLoop (inner loop)
      ├ config.transformContext(messages)   ← context event (extensions rewrite messages[])
      ├ config.convertToLlm(messages)       → Message[] (filters custom/branchSummary)
      ├ streamSimple(...)                    → AssistantMessage{content, stopReason, usage}
      ├ tool calls → beforeToolCall (tool_call) → tool.execute() → afterToolCall (tool_result)
      └ message_end → _processAgentEvent → message_end ext handler → sessionManager.appendMessage()
```

### Where state lives

| State | Lives in | Mutated by |
|---|---|---|
| Transcript | `Agent._state.messages[]` | `processEvents()` on `message_end` |
| System prompt | `Agent._state.systemPrompt` | base + extension override per turn |
| Active tools | `Agent._state.tools[]` | `_refreshToolRegistry()` |
| Session file (JSONL) | `.pi/sessions/<id>.jsonl` | `sessionManager.appendMessage()` per `message_end` |
| Extension handlers | `Extension.handlers` Map | during `factory(api)` at load |

### Context assembly per turn

`buildSystemPrompt()` (system-prompt.ts:27) composes: voice template + tools list
+ guidelines (from active tools' `promptGuidelines`) + context files (AGENTS.md /
pi.md) + **skills as `<available_skills>` XML** (skills.ts:340) + date/cwd.
Rebuilt via `_rebuildSystemPrompt()` whenever tools change. Extensions can replace
it entirely for one turn via `before_agent_start` returning `{systemPrompt}`.

### Compaction

`_checkCompaction()` → `shouldCompact(tokens, window, settings)` →
`prepareCompaction()` finds the cut point (oldest user msg after last compaction)
→ `compact()` LLM-summarizes → `sessionManager.appendCompaction()` →
`agent.state.messages = [summaryMessage, ...kept]` (controlled swap). Token
estimate reads actual usage from the last assistant message + char/4 for the tail.

---

## 3. Internals map (subsystem-by-subsystem)

- **Session** (`core/agent-session.ts`, 2977) — the heart. Coordinates agent,
  extensions, persistence, compaction, retry, tools, model switching. `prompt()`
  (:953) is the per-turn entry; `_processAgentEvent()` (:486) the serialized event
  handler; `_rebuildSystemPrompt()` (~:822); `_installAgentToolHooks()` (:364)
  wires beforeToolCall/afterToolCall to the ExtensionRunner once.
- **Agent** (`agent/src/agent.ts`, 553) — stateful wrapper over the loop. Owns
  `_state`, `runWithLifecycle()` (:447), `createContextSnapshot()` (:410, slices),
  `processEvents()` (:505, reducer + fan-out).
- **Agent loop** (`agent/src/agent-loop.ts`, 718) — pure, classless. `runAgentLoop`
  (:95), `runLoop` (:155), `streamAssistantResponse` (:275), `executeToolCalls`
  (:373), `prepareToolCall` (:552), `executePreparedToolCall` (:604).
- **Compaction** (`core/compaction/compaction.ts`, 847) — `shouldCompact`,
  `prepareCompaction` (cut-point), `compact` (LLM summary), branch summaries.
- **Providers / ai** (`packages/ai`) — `streamSimple()` is the single LLM call
  boundary; per-provider impls register via `registerApiProvider`. `onPayload` /
  `onResponse` hooks expose raw request/response to extensions.
- **Extensions** (`core/extensions/`) — `loader.ts` (jiti discovery/load),
  `runner.ts` (`ExtensionRunner`, dispatch, lazy context), `types.ts`
  (`ExtensionAPI` + events), `wrapper.ts` (ToolDefinition → AgentTool). See §4.
- **Package manager** (`core/package-manager.ts`, 2463) — the `pi install` engine
  (npm/git/local), resolves `package.json` `pi.{extensions,skills,prompts,themes}`.
- **Skills** (`core/skills.ts`, 504) — load Markdown skills; inject as XML. See §5.
- **Settings** (`core/settings-manager.ts`, 1067) — two-level (global + project)
  config: model, compaction, retry, steering, theme, sessions, packages.
- **Model registry / resolver** (953 / 638) — model catalog + auth resolution;
  CLI-flag → concrete `Model`; glob scopes like `anthropic/*:high`.
- **Resource loader** (918) — aggregates extensions/skills/prompts/themes/context;
  `reload()` re-discovers without restart.
- **Session manager** (1424) — JSONL session files; `appendMessage()` streams each
  message immediately; `buildSessionContext()` reconstructs from the branch; fork
  = copy the JSONL; tree navigation via branch-summary entries.
- **TUI** (`packages/tui`) — standalone terminal-UI primitives; the loop and
  extensions have no direct TUI dependency (only via `ExtensionUIContext`).

---

## 4. The extension system, in depth (strudel's seam)

### Discovery & loading

Order (loader.ts:575): project `cwd/.pi/extensions/` → global
`~/.pi/agent/extensions/` → configured paths → installed packages (filtered by
`pi.extensions` in `package.json`). Scan rules: direct `*.ts`/`*.js`; subdirs with
`index.ts`; subdirs with `package.json` `pi.extensions`. Load (loader.ts:393):
`jiti.import(path, {default:true})` → `factory(api)`. jiti: `moduleCache:false`
(hot-reload), virtual modules for the `@strudel/*` packages so extensions
`import from "@strudel/coding-agent"` without separate install. **Action methods
throw during load**; only registration is safe until `bindCore()` runs.

### `ExtensionAPI` capabilities

`on(event, handler)`, `registerTool(def)`, `registerCommand/Shortcut/Flag`,
`registerMessageRenderer`, `sendMessage/sendUserMessage`, `appendEntry`,
`exec(cmd, args)`, `getActiveTools/getAllTools/setActiveTools`, `getCommands`,
`setModel/getThinkingLevel/setThinkingLevel`, `registerProvider/unregisterProvider`
(queued at load, flushed at `bindCore`), `events` (cross-extension EventBus).

### Lifecycle events (★ = can mutate the turn)

| Event | When | Mutate? | Use |
|---|---|---|---|
| resources_discover | after session_start | ★ `{skillPaths?,promptPaths?,themePaths?}` | contribute resources |
| session_start | startup/reload/new/resume/fork | — | init, telemetry |
| session_before_switch/fork/compact/tree | before the action | ★ `{cancel?}` (+more) | block/customize |
| session_compact / session_tree | after | — | UI/metrics |
| session_shutdown | before teardown | — | cleanup |
| **input** | after submit, before expansion | ★ transform/handled | input preprocessing |
| **before_agent_start** | before `agent.prompt()` | ★ `{message?, systemPrompt?}` | **inject context / replace system prompt** |
| **context** | before each LLM call | ★ `{messages?}` | filter/inject (RAG) |
| before_provider_request | before HTTP | ★ replace payload | metadata |
| after_provider_response | response headers | — | metrics |
| agent_start / agent_end | loop begin/end | — | busy UI / post-turn |
| turn_start / turn_end | per assistant turn | — | bookkeeping |
| message_start / message_update | begin / token stream | — | live render |
| **message_end** | finalized | ★ `{message?}` (same role) | post-process output |
| tool_execution_start/update/end | tool lifecycle | — | UI/logging |
| **tool_call** | before exec (post-validate) | ★ mutate `input` / `{block?}` | patch args / block |
| **tool_result** | after exec, before LLM | ★ `{content?,details?,isError?}` | transform result |
| model_select / thinking_level_select | on change | — | UI |

Mutation notes: `context` gets a `structuredClone`; `before_agent_start` chains
systemPrompt across extensions; `message_end` replacement must keep the role;
`tool_call` mutate `event.input` in place or `{block:true}`; `session_before_*`
short-circuits on first `cancel:true`.

### `pi install`

Sources: `npm:<pkg>[@ver]`, `git:<host>/<path>[@ref]` / GitHub URL, local path.
`installAndPersist(source)` → parse → install to `agentDir/packages/<name>` (or
`cwd/.pi/packages/`) → add to settings `packages`. At startup `resolve()` reads
each package's `pi.{extensions,skills,prompts,themes}` + auto-discovers standard
dirs → flat `ResolvedPaths`. Precedence: project+local > project+auto >
user+local > user+auto > package.

---

## 5. Pi's native primitive handling (what NOT to duplicate)

- **Tools.** Built-ins in this fork: `grep`/`find`/`ls` (stubs). **The fork ships
  zero default active tools** (sdk.ts:257 `defaultActiveToolNames = []` — "the
  bakery's `before_agent_start` hook is the sole authority on active tools").
  Upstream default was `["read","bash","edit","write"]`. Extension tools
  (`pi.registerTool`) merge via `_refreshToolRegistry()`.
- **Skills.** Markdown files from `~/.pi/agent/skills/`, `cwd/.pi/skills/`,
  extension paths, `--skill`. A `Skill` (skills.ts:75) is injected into the system
  prompt as `<available_skills><skill><name/><description/><location/></skill>…`.
  **Pi does NOT execute skills — it inlines their text into context.** The LLM is
  told to `read` the file when relevant; `/skill:name` inlines it into the user msg.
  **→ This is exactly the mechanism strudel's thesis says breaks at scale.**
- **Slash-commands.** (1) extension commands (`pi.registerCommand`, run as code);
  (2) prompt templates (Markdown in `prompts/`, pure text substitution). No
  built-in slash commands beyond these.
- **MCPs.** No native MCP support in v0.74 (extension territory; upstream 0.80 may
  differ).
- **Context files.** `AGENTS.md`/`pi.md`/`.pi/context.md` loaded into the system
  prompt under `# Project Context`; static at session start (refresh via `/reload`).

---

## 6. Original author's design intent (inferred, with evidence)

1. **The loop is pure; the shell is not.** `agent-loop.ts` is a stateless
   function — no `this`, no I/O. All side effects live in `AgentEvent` subscribers
   in `AgentSession`.
2. **Extensions are first-class.** ~25 typed hooks covering every observable
   moment; jiti virtual-modules so extensions import Pi packages directly;
   `resources_discover` lets extensions BE resource providers.
3. **Provider agnosticism via one boundary.** `streamSimple()` is the only LLM
   call site; `convertToLlm` is a required callback; the loop never touches wire
   format.
4. **Harness/loop split enables testability.** `runAgentLoop()` is a plain async
   function — testable with mock tools + a fake stream, no session/UI/extensions.
5. **Session state IS the JSONL.** `appendMessage()` on every `message_end` (not
   buffered) — survives a mid-turn crash; `buildSessionContext()` rebuilds from
   disk; the tree lives in the JSONL too.
6. **Extension context is lazy & stale-aware.** `createContext()` getters call
   `assertActive()`; `invalidate()` makes stale `pi.`/`ctx.` calls throw — kills
   dangling-callback bugs without forcing cleanup.
7. **The UI is replaceable noise at the top.** `AgentSession` is shared across
   interactive/print/RPC unchanged; `noOpUIContext` no-ops UI calls off-TUI.
8. **Scoped snapshots prevent cross-turn pollution.** `createContextSnapshot()`
   slices messages/tools; compaction swaps the array deliberately, never mutating
   the snapshot the loop iterates.

---

## 7. Ecosystem overview

```
            @strudel/coding-agent   (cli → AgentSession; extensions, compaction,
                  │   │   │           skills, settings, sessions, package-manager)
        ┌─────────┘   │   └─────────┐
        ▼             ▼             ▼
  @strudel/agent  @strudel/ai   @strudel/tui
  (Agent, loop,   (streamSimple, (TUI, Component,
   harness)        providers,     Overlay, Editor,
        │          model/tool      Themes — standalone)
        └────▶ ai   types)
```

Direction: coding-agent → {agent-core, ai, tui}; agent-core → ai; tui & ai
standalone. For an extension author: **use** `@strudel/coding-agent`
(`ExtensionAPI`, `ToolDefinition`, `defineTool`) — this is the seam; types only
from agent-core/ai/tui; optionally override a provider (`registerProvider`) or the
editor (`ctx.ui.setEditorComponent`).

---

## What this means for strudel (integration points)

1. **`before_agent_start` is the seam.** Strudel's hook replaces Pi's
   inject-all-skills-as-XML with the gateway (index + `strudel_search`), and calls
   `setActiveTools` to lock the surface to the gateway tools.
2. **`registerTool`** for `strudel_search` / `strudel_prep` / `strudel_bake`.
3. **`context`** (per-LLM-call) is the place to inject the *distilled, relevant*
   subset rather than the whole catalog.
4. **Skills are already text-injection** — strudel doesn't execute skills; it
   selects and injects the right ones. Don't rebuild what Pi does; replace the
   *selection* mechanism.
5. **Telemetry** = a second extension subscribing to the lifecycle events above →
   JSONL → visualizer. No runtime changes.
6. **MCP** isn't native (0.74) — strudel can treat MCP as a Pantry kind via the
   gateway.
