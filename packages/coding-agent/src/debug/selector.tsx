import "@oh-my-pi/pi-tui/host/intrinsics";
import * as fs from "node:fs/promises";
import * as url from "node:url";
import { getWorkProfile } from "@oh-my-pi/pi-natives";
import type { TUI } from "@oh-my-pi/pi-tui";
import { isNotificationSuppressed, TERMINAL, type TerminalNotification } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { createDocument } from "@oh-my-pi/pi-tui/document/document";
import { type HostKeyEvent } from "@oh-my-pi/pi-tui/host/input";
import { mountOverlay, Portal, type OverlayDisposer } from "@oh-my-pi/pi-tui/overlay";
import { createSignal, onMount, useFocus, type JSX } from "@oh-my-pi/pi-tui/reactive";
import { DebugLogViewerView } from "@oh-my-pi/pi-tui/apps/debug/log-viewer";
import { buildSampleImage, ProtocolProbeView } from "@oh-my-pi/pi-tui/apps/debug/protocol-probe";
import { RawSseViewerView } from "@oh-my-pi/pi-tui/apps/debug/raw-sse";
import { resolveRawSseDebugBuffer } from "@oh-my-pi/pi-tui/apps/debug/raw-sse-buffer";
import { collectTerminalState, TerminalStateView } from "@oh-my-pi/pi-tui/apps/debug/terminal-info";
import { formatBytes, getSessionsDir } from "@oh-my-pi/pi-utils";
import type { InteractiveModeContext } from "../modes/types";
import { copyToClipboard } from "../utils/clipboard";
import { openPath } from "../utils/open";
import { collectMemoryStats, type ProfilerSession, startCpuProfile } from "./profiler";
import { clearArtifactCache, createDebugLogSource, createReportBundle, getArtifactCacheStats } from "./report-bundle";
import { getRemoteDebugger, type RemoteDebuggerInfo, startRemoteDebuggerServer } from "./remote-debugger";
import { collectSystemInfo, formatSystemInfo } from "./system-info";

type DebugMenuValue =
	| "open-artifacts"
	| "performance"
	| "work"
	| "dump"
	| "memory"
	| "logs"
	| "system"
	| "terminal"
	| "protocols"
	| "raw-sse"
	| "remote-debugger"
	| "transcript"
	| "clear-cache";

const DEBUG_MENU_ITEMS: readonly {
	readonly value: DebugMenuValue;
	readonly label: string;
	readonly description: string;
}[] = [
	{ value: "open-artifacts", label: "Open: artifact folder", description: "Open session artifacts in file manager" },
	{ value: "performance", label: "Report: performance issue", description: "Profile CPU, reproduce, then bundle" },
	{ value: "work", label: "Profile: work scheduling", description: "Open flamegraph of last 30s" },
	{ value: "dump", label: "Report: dump session", description: "Create report bundle immediately" },
	{ value: "memory", label: "Report: memory issue", description: "Memory statistics + bundle" },
	{ value: "logs", label: "View: recent logs", description: "Show last 50 log entries" },
	{ value: "system", label: "View: system info", description: "Show environment details" },
	{ value: "terminal", label: "View: terminal state", description: "Subprotocols, geometry, scrollback strategy" },
	{
		value: "protocols",
		label: "Test: terminal protocols",
		description: "Styling, links, text sizing, graphics, notify",
	},
	{ value: "raw-sse", label: "View: raw SSE stream", description: "Show live provider SSE frames" },
	{
		value: "remote-debugger",
		label: "Start: JS remote debugger",
		description: "Expose JavaScriptCore inspector socket (experimental)",
	},
	{
		value: "transcript",
		label: "Export: TUI transcript",
		description: "Write visible TUI conversation to a temp txt",
	},
	{ value: "clear-cache", label: "Clear: artifact cache", description: "Remove old session artifacts" },
];

function DebugSelectorView({
	ctx,
	close,
}: {
	readonly ctx: InteractiveModeContext;
	readonly close: () => void;
}): JSX.Element {
	const [selectedIndex, setSelectedIndex] = createSignal(0);
	const focus = useFocus();
	onMount(() => focus.focus());

	const select = (): void => {
		const item = DEBUG_MENU_ITEMS[selectedIndex()];
		if (!item) return;
		close();
		void runDebugAction(ctx, item.value).catch(error =>
			ctx.showError(`Debug action failed: ${error instanceof Error ? error.message : String(error)}`),
		);
	};
	const onKey = (event: HostKeyEvent): void => {
		switch (event.key) {
			case "escape":
			case "esc":
				close();
				event.preventDefault();
				break;
			case "up":
				setSelectedIndex(index => Math.max(0, index - 1));
				event.preventDefault();
				break;
			case "down":
				setSelectedIndex(index => Math.min(DEBUG_MENU_ITEMS.length - 1, index + 1));
				event.preventDefault();
				break;
			case "enter":
			case "return":
				select();
				event.preventDefault();
				break;
		}
	};

	return (
		<frame title="Debug Tools" paddingX={1} borderPolicy="always">
			<box onKey={onKey} tabIndex={focus.tabIndex}>
				<select options={DEBUG_MENU_ITEMS} selectedIndex={selectedIndex()} maxRows={7} />
				<text color="dim">Enter select · Esc close</text>
			</box>
		</frame>
	);
}

/** Open the reactive debug command palette. */
export function openDebugSelectorOverlay(tui: TUI, ctx: InteractiveModeContext, onClose?: () => void): OverlayDisposer {
	const close = (): void => {
		dispose.dispose();
		onClose?.();
	};
	const dispose = mountOverlay(tui, () => (
		<Portal to="overlay" anchor="center" width="80%" maxHeight="90%">
			<DebugSelectorView ctx={ctx} close={close} />
		</Portal>
	));
	return dispose;
}

function openDebugViewer(ctx: InteractiveModeContext, view: (close: () => void) => JSX.Element): OverlayDisposer {
	const close = (): void => overlay.dispose();
	const overlay = mountOverlay(ctx.ui, () => (
		<Portal to="overlay" fullscreen>
			{view(close)}
		</Portal>
	));
	return overlay;
}

async function runDebugAction(ctx: InteractiveModeContext, value: DebugMenuValue): Promise<void> {
	switch (value) {
		case "open-artifacts":
			await openArtifacts(ctx);
			return;
		case "performance":
			await createPerformanceReport(ctx);
			return;
		case "work":
			await openWorkProfile(ctx);
			return;
		case "dump":
			await createDumpReport(ctx);
			return;
		case "memory":
			await createMemoryReport(ctx);
			return;
		case "logs":
			await showLogs(ctx);
			return;
		case "system":
			await showSystemInfo(ctx);
			return;
		case "terminal":
			showTerminalState(ctx);
			return;
		case "protocols":
			showProtocols(ctx);
			return;
		case "raw-sse":
			showRawSse(ctx);
			return;
		case "remote-debugger":
			await startRemoteDebugger(ctx);
			return;
		case "transcript":
			await ctx.handleDebugTranscriptCommand();
			return;
		case "clear-cache":
			await clearCache(ctx);
	}
}

function reportSaved(ctx: InteractiveModeContext, title: string, path: string, files: number): void {
	ctx.present(
		<frame title={title} paddingX={1} borderPolicy="always">
			<stack>
				<text color="success">Report saved</text>
				<text color="dim">
					<link href={url.pathToFileURL(path).href}>{path}</link>
				</text>
				<text color="dim">Files: {files}</text>
			</stack>
		</frame>,
	);
}

async function createPerformanceReport(ctx: InteractiveModeContext): Promise<void> {
	let session: ProfilerSession;
	try {
		session = await startCpuProfile();
	} catch (error) {
		ctx.showError(`Failed to start profiler: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	ctx.present(
		<frame title="CPU profiling" paddingX={1} borderPolicy="always">
			<text color="accent">CPU profiling started. Reproduce the issue, then confirm to create the report.</text>
		</frame>,
	);
	const confirmed = await ctx.showHookConfirm(
		"CPU profiling",
		"Reproduce the performance issue, then confirm to stop profiling and create a report.",
	);
	if (!confirmed) {
		await session.stop();
		ctx.showStatus("CPU profiling cancelled", { dim: true });
		return;
	}
	ctx.showStatus("Generating performance report…", { dim: true });
	try {
		const result = await createReportBundle({
			sessionFile: ctx.sessionManager.getSessionFile(),
			settings: resolvedSettings(ctx),
			rawSseText: rawSseText(ctx),
			cpuProfile: await session.stop(),
			workProfile: getWorkProfile(30),
		});
		reportSaved(ctx, "Performance report", result.path, result.files.length);
	} catch (error) {
		ctx.showError(`Failed to create report: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function openWorkProfile(ctx: InteractiveModeContext): Promise<void> {
	try {
		const workProfile = getWorkProfile(30);
		if (!workProfile.svg) {
			ctx.showWarning(`No work profile data (${workProfile.sampleCount} samples)`);
			return;
		}
		const path = `/tmp/work-profile-${Date.now()}.svg`;
		await Bun.write(path, workProfile.svg);
		openPath(path);
		ctx.showStatus(`Opened flamegraph (${workProfile.sampleCount} samples)`, { dim: true });
	} catch (error) {
		ctx.showError(`Failed to open profile: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function createDumpReport(ctx: InteractiveModeContext): Promise<void> {
	ctx.showStatus("Creating report bundle…", { dim: true });
	try {
		const result = await createReportBundle({
			sessionFile: ctx.sessionManager.getSessionFile(),
			settings: resolvedSettings(ctx),
			rawSseText: rawSseText(ctx),
		});
		reportSaved(ctx, "Debug report", result.path, result.files.length);
	} catch (error) {
		ctx.showError(`Failed to create report: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function createMemoryReport(ctx: InteractiveModeContext): Promise<void> {
	ctx.showStatus("Collecting memory statistics…", { dim: true });
	try {
		const result = await createReportBundle({
			sessionFile: ctx.sessionManager.getSessionFile(),
			settings: resolvedSettings(ctx),
			rawSseText: rawSseText(ctx),
			memoryStats: collectMemoryStats(),
		});
		reportSaved(ctx, "Memory report", result.path, result.files.length);
		ctx.present(
			<text color="warning">
				Review before sharing: session data, artifacts, logs, and settings may contain secrets.
			</text>,
		);
	} catch (error) {
		ctx.showError(`Failed to create report: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function showLogs(ctx: InteractiveModeContext): Promise<void> {
	try {
		const source = await createDebugLogSource();
		const logs = await source.getInitialText();
		if (!logs && !source.hasOlderLogs()) {
			ctx.showWarning("No log entries found for today.");
			return;
		}
		openDebugViewer(ctx, close => (
			<DebugLogViewerView
				logs={logs}
				deps={{
					copyToClipboard: text => void copyToClipboard(text),
					hasOlderLogs: source.hasOlderLogs,
					loadOlderLogs: source.loadOlderLogs,
				}}
				onExit={close}
				onStatus={message => ctx.showStatus(message)}
				onError={message => ctx.showError(message)}
			/>
		));
	} catch (error) {
		ctx.showError(`Failed to read logs: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function showSystemInfo(ctx: InteractiveModeContext): Promise<void> {
	try {
		const info = await collectSystemInfo();
		ctx.present(
			<frame title="System info" paddingX={1} borderPolicy="always">
				<pre document={createDocument(formatSystemInfo(info))} wrap={false} />
			</frame>,
		);
	} catch (error) {
		ctx.showError(`Failed to collect system info: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function showTerminalState(ctx: InteractiveModeContext): void {
	const info = collectTerminalState({
		columns: ctx.ui.terminal.columns,
		rows: ctx.ui.terminal.rows,
		synchronizedOutput: ctx.ui.synchronizedOutput,
	});
	ctx.present(<TerminalStateView info={info} />);
}

function showProtocols(ctx: InteractiveModeContext): void {
	const notificationSuppressed = isNotificationSuppressed();
	if (!notificationSuppressed) {
		const notification: TerminalNotification = {
			title: ctx.sessionManager.getSessionName() || "Oh My Pi",
			body: "Terminal protocol test",
			type: "test",
			actions: "focus",
		};
		TERMINAL.sendNotification(notification);
	}
	ctx.present(
		<ProtocolProbeView
			options={{
				image: buildSampleImage(),
				imageBudget: ctx.ui.imageBudget,
				notificationSuppressed,
			}}
		/>,
	);
}

function showRawSse(ctx: InteractiveModeContext): void {
	const buffer = resolveRawSseDebugBuffer(ctx.session);
	openDebugViewer(ctx, close => (
		<RawSseViewerView
			deps={{ copyToClipboard: text => void copyToClipboard(text) }}
			buffer={buffer}
			onExit={close}
			onStatus={message => ctx.showStatus(message)}
		/>
	));
}

async function startRemoteDebugger(ctx: InteractiveModeContext): Promise<void> {
	let info: RemoteDebuggerInfo;
	const existing = getRemoteDebugger();
	try {
		info = existing ?? (await startRemoteDebuggerServer());
	} catch (error) {
		ctx.showError(`Failed to start remote debugger: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	ctx.present(
		<frame title="Remote debugger" paddingX={1} borderPolicy="always">
			<stack>
				<text color="success">JavaScriptCore remote inspector {existing ? "already running" : "started"}</text>
				<text color="dim">
					Listening on {info.host}:{info.port}
				</text>
				<text color="dim">
					Experimental WebKit RemoteInspectorServer socket. Attach a compatible WebKit/Safari Web Inspector client.
				</text>
			</stack>
		</frame>,
	);
}

async function openArtifacts(ctx: InteractiveModeContext): Promise<void> {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		ctx.showWarning("No active session file.");
		return;
	}
	const artifactsDir = sessionFile.slice(0, -6);
	try {
		if (!(await fs.stat(artifactsDir)).isDirectory()) {
			ctx.showWarning("Artifact folder does not exist yet.");
			return;
		}
	} catch {
		ctx.showWarning("Artifact folder does not exist yet.");
		return;
	}
	openPath(artifactsDir);
	ctx.showStatus(`Opened: ${artifactsDir}`);
}

async function clearCache(ctx: InteractiveModeContext): Promise<void> {
	const sessionsDir = getSessionsDir();
	const stats = await getArtifactCacheStats(sessionsDir);
	if (stats.count === 0) {
		ctx.showStatus("Artifact cache is empty.");
		return;
	}
	const confirmed = await ctx.showHookConfirm(
		"Clear Artifact Cache",
		`Found ${stats.count} artifact files (${formatBytes(stats.totalSize)})\nOldest: ${stats.oldestDate?.toLocaleDateString() ?? "unknown"}\n\nRemove artifacts older than 30 days?`,
	);
	if (!confirmed) {
		ctx.showStatus("Cache clear cancelled.");
		return;
	}
	ctx.showStatus("Clearing artifact cache…", { dim: true });
	try {
		const result = await clearArtifactCache(sessionsDir, 30);
		ctx.present(<text color="success">Cleared {result.removed} artifact directories</text>);
	} catch (error) {
		ctx.showError(`Failed to clear cache: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function rawSseText(ctx: InteractiveModeContext): string | undefined {
	const text = resolveRawSseDebugBuffer(ctx.session).toRawText();
	return text.trim().length === 0 ? undefined : text;
}

function resolvedSettings(ctx: InteractiveModeContext): Record<string, unknown> {
	return {
		model: ctx.session.model?.id,
		thinkingLevel: ctx.session.thinkingLevel,
		planModeEnabled: ctx.planModeEnabled,
		toolOutputExpanded: ctx.toolOutputExpanded,
		hideThinkingBlock: ctx.hideThinkingBlock,
	};
}
