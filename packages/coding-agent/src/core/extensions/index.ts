/**
 * Extension system for lifecycle events and custom tools.
 */

export type { SlashCommandInfo, SlashCommandSource } from "../slash-commands.js";
export type { SourceInfo } from "../source-info.js";
export {
	createExtensionRuntime,
	discoverAndLoadExtensions,
	loadExtensionFromFactory,
	loadExtensions,
} from "./loader.js";
export type {
	ExtensionErrorListener,
	ForkHandler,
	NavigateTreeHandler,
	NewSessionHandler,
	ShutdownHandler,
	SwitchSessionHandler,
} from "./runner.js";
export { ExtensionRunner } from "./runner.js";
export type {
	AfterProviderResponseEvent,
	AgentEndEvent,
	AgentStartEvent,
	// Re-exports
	AgentToolResult,
	AgentToolUpdateCallback,
	AppendEntryHandler,
	// App keybindings (for custom editors)
	AppKeybinding,
	AutocompleteProviderFactory,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	BuildSystemPromptOptions,
	// Context
	CompactOptions,
	// Events - Agent
	ContextEvent,
	// Event Results
	ContextEventResult,
	ContextUsage,
	CustomToolCallEvent,
	CustomToolResultEvent,
	EditorFactory,
	ExecOptions,
	ExecResult,
	Extension,
	ExtensionActions,
	// API
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	// Errors
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionHandler,
	// Runtime
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	FindToolCallEvent,
	FindToolResultEvent,
	GetActiveToolsHandler,
	GetAllToolsHandler,
	GetCommandsHandler,
	GetThinkingLevelHandler,
	GrepToolCallEvent,
	GrepToolResultEvent,
	// Events - Input
	InputEvent,
	InputEventResult,
	InputSource,
	KeybindingsManager,
	LoadExtensionsResult,
	LsToolCallEvent,
	LsToolResultEvent,
	// Events - Message
	MessageEndEvent,
	// Message Rendering
	MessageRenderer,
	MessageRenderOptions,
	MessageStartEvent,
	MessageUpdateEvent,
	ModelSelectEvent,
	ModelSelectSource,
	// Provider Registration
	ProviderConfig,
	ProviderModelConfig,
	// Commands
	RegisteredCommand,
	RegisteredTool,
	ReplacedSessionContext,
	ResolvedCommand,
	// Events - Resources
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SendMessageHandler,
	SendUserMessageHandler,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionBeforeForkEvent,
	SessionBeforeForkResult,
	SessionBeforeSwitchEvent,
	SessionBeforeSwitchResult,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	SessionCompactEvent,
	SessionEvent,
	SessionShutdownEvent,
	// Events - Session
	SessionStartEvent,
	SessionTreeEvent,
	SetActiveToolsHandler,
	SetLabelHandler,
	SetModelHandler,
	SetThinkingLevelHandler,
	TerminalInputHandler,
	// Events - Tool
	ToolCallEvent,
	ToolCallEventResult,
	// Tools
	ToolDefinition,
	// Events - Tool Execution
	ToolExecutionEndEvent,
	// Tool execution mode
	ToolExecutionMode,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolInfo,
	ToolRenderResultOptions,
	ToolResultEvent,
	ToolResultEventResult,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
	WidgetPlacement,
	WorkingIndicatorOptions,
} from "./types.js";
// Type guards
export {
	defineTool,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isToolCallEventType,
} from "./types.js";
export { wrapRegisteredTool, wrapRegisteredTools } from "./wrapper.js";
