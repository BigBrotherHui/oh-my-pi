export {
	ErrorBoundary,
	For,
	Index,
	Match,
	Show,
	Suspense,
	Switch,
	batch,
	createContext,
	createEffect,
	createMemo,
	createResource,
	createRoot,
	createSignal,
	from,
	getOwner,
	mergeProps,
	on,
	onCleanup,
	onMount,
	runWithOwner,
	splitProps,
	untrack,
	useContext,
	createStore,
	produce,
	reconcile,
	unwrap,
	createCommitEffect,
	createLayoutEffect,
	useClock,
	useFocus,
	useKeymap,
	useTheme,
	useTui,
	type Accessor,
	type JSX,
	type Setter,
} from "./reactive";

export { render, type RootHandle, type RootOptions, type TerminalCapabilities } from "./root";
export { mountSnapshot, renderSnapshot, type SnapshotOptions, type SnapshotRoot } from "./snapshot";
export { Portal, type PortalProps } from "./host/overlay";

export { createDocument, createOutputDocument, type MutableOutputDocument } from "./document/document";
export { documentFromSnapshots, type SnapshotDocument } from "./document/snapshots";
export type { CaptureState, DocumentChange, OutputDocument, OutputNotice, TextDocument } from "./document/types";

export {
	createToolCallModel,
	registerToolView,
	resolveToolView,
	toolViews,
	type ActivitySummary,
	type ApplyToolResultOptions,
	type CallOutcome,
	type CallPhase,
	type CreateToolCallModelOptions,
	type ResolvedToolView,
	type ToolCallModel,
	type ToolResultPayload,
	type ToolUiState,
	type ToolView,
	type ToolViewDefinition,
	type ToolViewProps,
} from "./tools";

export type { FocusHandle } from "./host/focus";
export type { Keymap, KeymapAccess } from "./host/keymap";
export { Damage, type HostNode } from "./host/types";
export type * from "./host/intrinsics";

export { AgentRow } from "./view/agent-row";
export { Bar } from "./view/bar";
export { Card } from "./view/card";
export { DiffStats } from "./view/diff-stats";
export { ExpandHint } from "./view/expand-hint";
export { FileList } from "./view/file-list";
export { Hints } from "./view/hints";
export { JsonTree } from "./view/json-tree";
export { Kbd } from "./view/kbd";
export { KeyValue } from "./view/key-value";
export { List } from "./view/list";
export { MoreItems } from "./view/more-items";
export { Notice } from "./view/notice";
export { Section } from "./view/section";
export { StatusIcon } from "./view/status-icon";
export { ToolCard } from "./view/tool-card";
export { ToolHeader } from "./view/tool-header";
export { TreeList } from "./view/tree-list";
export { TruncationNotice } from "./view/truncation-notice";

export {
	mountForTest,
	renderToRows,
	renderToText,
	type Counters,
	type FakeClock,
	type MountForTestOptions,
	type TestRoot,
} from "./testing";

export {
	TUI,
	type HistoryBatch,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	type TuiPaint,
	type TUIOptions,
	type TUIStartOptions,
	type ViewportSize,
} from "./tui";
export { ProcessTerminal, type Terminal } from "./terminal";
export { Attr, Style, type Color } from "./core/style";
export type { EditorTheme } from "./components/editor";
export type { AutocompleteProvider } from "./autocomplete";
export type { OverlayHandle, OverlayOptions } from "./tui";
export * from "./keybindings";
export { ImageProtocol, setTerminalImageProtocol, TERMINAL, TERMINAL_ID } from "./terminal-capabilities";
export { fuzzyFilter, fuzzyMatch } from "./fuzzy";
export { getTerminalId } from "./ttyid";
export { isTuiTight, padding, replaceTabs, setTuiTight, truncateToWidth, visibleWidth } from "./utils";
export { shortenPath } from "./render/render-utils";
export { RichText, cellWidth, type Out } from "./core/richtext";
export { emitRows } from "./core/emit";
export { parseAnsiRow } from "./core/ansi";
export { spliceRow } from "./core/frame";
export { theme, type Theme, type ThemeBg, type ThemeColor } from "./theme";
export * from "./keys";
export * from "./mouse";
export { QrCode, type QrEcLevel, type QrEncodeOptions } from "./host/qr-encode";
export { CollabQrCodeView, collabBrowserLink, type CollabQrCodeProps } from "./chrome/collab-qrcode";
