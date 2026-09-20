import "@oh-my-pi/pi-tui/host/intrinsics";
import { stripVTControlCharacters } from "node:util";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { render } from "@oh-my-pi/pi-tui/root";
import { createSignal, For, onCleanup, onMount, Show, useFocus, type JSX } from "@oh-my-pi/pi-tui/reactive";
import { replaceTabs } from "@oh-my-pi/pi-tui/utils";
import type { HostKeyEvent } from "@oh-my-pi/pi-tui/host/input";
import type { Accessor } from "@oh-my-pi/pi-tui/reactive";
import type { StreamChatMessage } from "@oh-my-pi/pi-wire";
import type { StreamConsoleEvent, StreamMuxHost } from "./streamer";

const HISTORY_LIMIT = 50;
const CHAT_COLORS = ["accent", "success", "warning", "thinkingHigh", "statusLineModel"] as const;

type StreamConsoleLine =
	| { readonly kind: "dim"; readonly text: string }
	| { readonly kind: "error"; readonly text: string }
	| {
			readonly kind: "chat";
			readonly timestamp: string;
			readonly name: string;
			readonly host: boolean;
			readonly text: string;
	  };

interface PaneSummary {
	id: number;
	title: string;
	cols: number;
	rows: number;
}

export interface StreamTuiInfo {
	title: string;
	initialEvents: readonly StreamConsoleEvent[];
	subscribe(listener: (event: StreamConsoleEvent) => void): () => void;
}

function safeInline(text: string): string {
	return replaceTabs(stripVTControlCharacters(text)).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function formatLinkEvent(event: Extract<StreamConsoleEvent, { t: "link" }>): string {
	const detail = event.detail ? ` · ${safeInline(event.detail)}` : "";
	const user = event.user ? ` · @${safeInline(event.user)}` : "";
	return `link: ${event.state}${detail}${user}`;
}

function formatChatEvent(message: StreamChatMessage): StreamConsoleLine {
	const time = new Date(message.ts);
	return {
		kind: "chat",
		timestamp: `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`,
		name: safeInline(message.name),
		host: message.host === true,
		text: safeInline(message.text),
	};
}

function stableNameHash(name: string): number {
	let hash = 0;
	for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
	return hash;
}

function StreamConsoleEventView({ line }: { readonly line: StreamConsoleLine }): JSX.Element {
	switch (line.kind) {
		case "dim":
			return (
				<text>
					<span dim>{line.text}</span>
				</text>
			);
		case "error":
			return (
				<text>
					<span color="error">{line.text}</span>
				</text>
			);
		case "chat":
			return (
				<text>
					<span dim>{line.timestamp}</span>
					<span> </span>
					<span
						bold={line.host}
						color={
							line.host ? "accent" : (CHAT_COLORS[stableNameHash(line.name) % CHAT_COLORS.length] ?? "accent")
						}
					>
						{line.name}
					</span>
					<span>{": " + line.text}</span>
				</text>
			);
	}
}

export interface StreamConsoleAppProps {
	readonly host: StreamMuxHost;
	readonly info: StreamTuiInfo;
	readonly terminalRows: () => number;
	readonly onQuit: () => void;
}

export function StreamConsoleApp(props: StreamConsoleAppProps): JSX.Element {
	const [linkState, setLinkState] = createSignal<Extract<StreamConsoleEvent, { t: "link" }>["state"]>("connecting");
	const [channel, setChannel] = createSignal("");
	const [viewerUrl, setViewerUrl] = createSignal("");
	const [title, setTitle] = createSignal(props.info.title);
	const [user, setUser] = createSignal<string | undefined>(undefined);
	const [viewers, setViewers] = createSignal(0);
	const [panes, setPanes] = createSignal<readonly PaneSummary[]>([]);
	const [lines, setLines] = createSignal<readonly StreamConsoleLine[]>([]);
	const [inputValue, setInputValue] = createSignal("");

	const focus = useFocus();
	onMount(() => {
		focus.focus();
	});

	const history: string[] = [];
	let historyIndex = 0;
	let historyDraft = "";
	let quitting = false;

	function acceptEvent(event: StreamConsoleEvent): void {
		switch (event.t) {
			case "link":
				setLinkState(event.state);
				if (event.state === "live") {
					if (event.channel !== undefined) setChannel(event.channel);
					if (event.detail !== undefined) setViewerUrl(event.detail);
				}
				if (event.user !== undefined) setUser(event.user);
				setLines(prev => [...prev, { kind: "dim", text: formatLinkEvent(event) }]);
				break;
			case "pane":
				if (event.action === "attached") {
					setPanes(prev => [...prev.filter(p => p.id !== event.id), event]);
					setLines(prev => [
						...prev,
						{
							kind: "dim",
							text: `pane attached: #${event.id} ${safeInline(event.title)} ${event.cols}x${event.rows}`,
						},
					]);
				} else {
					setPanes(prev => prev.filter(p => p.id !== event.id));
					setLines(prev => [
						...prev,
						{ kind: "dim", text: `pane closed: #${event.id} ${safeInline(event.title)}` },
					]);
				}
				break;
			case "viewers":
				setViewers(event.n);
				setLines(prev => [...prev, { kind: "dim", text: `viewers: ${event.n}` }]);
				break;
			case "chat":
				setLines(prev => [...prev, formatChatEvent(event.msg)]);
				break;
			case "title":
				setTitle(event.title);
				setLines(prev => [...prev, { kind: "dim", text: `title: ${safeInline(event.title)}` }]);
				break;
			case "error":
				setLines(prev => [...prev, { kind: "error", text: safeInline(event.message) }]);
				break;
			case "notice":
				setLines(prev => [...prev, { kind: "dim", text: safeInline(event.message) }]);
				break;
		}
	}

	for (const event of props.info.initialEvents) {
		acceptEvent(event);
	}
	const unsubscribe = props.info.subscribe(acceptEvent);
	onCleanup(() => {
		unsubscribe();
	});

	function quit(): void {
		if (quitting) return;
		quitting = true;
		props.onQuit();
	}

	function recall(delta: -1 | 1): void {
		if (history.length === 0) return;
		if (delta < 0) {
			if (historyIndex === history.length) historyDraft = inputValue();
			historyIndex = Math.max(0, historyIndex - 1);
			setInputValue(history[historyIndex] ?? "");
		} else {
			historyIndex = Math.min(history.length, historyIndex + 1);
			setInputValue(historyIndex === history.length ? historyDraft : (history[historyIndex] ?? ""));
		}
	}

	function handleSubmit(value: string): void {
		const text = value.trim();
		setInputValue("");
		if (!text) {
			historyIndex = history.length;
			historyDraft = "";
			return;
		}
		history.push(text);
		if (history.length > HISTORY_LIMIT) history.shift();
		historyIndex = history.length;
		historyDraft = "";
		if (text === "/quit") {
			quit();
			return;
		}
		if (text.startsWith("/title ")) {
			props.host.setTitle(text.slice(7));
		} else {
			props.host.sendChat(text);
		}
	}

	function handleKey(event: HostKeyEvent): void {
		if (event.key === "ctrl+c") {
			event.preventDefault();
			quit();
			return;
		}
		if (event.key === "up") {
			event.preventDefault();
			recall(-1);
			return;
		}
		if (event.key === "down") {
			event.preventDefault();
			recall(1);
			return;
		}
	}

	return (
		<stack>
			<text>
				<Show
					when={linkState() === "live"}
					fallback={<span dim>{"○ " + (linkState() === "stopped" ? "offline" : linkState())}</span>}
				>
					<span bold color="accent">
						{"● LIVE"}
					</span>
				</Show>
				<span> </span>
				<Show when={channel()} fallback={<span dim>{"identifying channel"}</span>}>
					<span>{"#" + safeInline(channel())}</span>
				</Show>
				<span dim>{" · "}</span>
				<span>{safeInline(title())}</span>
				<Show when={user()}>
					{(u: Accessor<string>) => (
						<>
							<span dim>{" · streaming as "}</span>
							<span color="accent">{"@" + safeInline(u())}</span>
						</>
					)}
				</Show>
				<br />
				<Show when={viewerUrl()} fallback={<span dim>{"waiting for stream server"}</span>}>
					<span>{safeInline(viewerUrl())}</span>
				</Show>
				<span dim>{" · "}</span>
				<span>{"👁 " + viewers() + " watching"}</span>
				<span dim>{" · "}</span>
				<span>{"panes: "}</span>
				<Show when={panes().length > 0} fallback={<span>{"none"}</span>}>
					<For each={panes()}>
						{(pane, index) => (
							<>
								<Show when={index() > 0}>
									<span> </span>
								</Show>
								<span>{pane.id + ":" + safeInline(pane.title)}</span>
							</>
						)}
					</For>
				</Show>
			</text>
			<scroll height={Math.max(0, props.terminalRows() - 4)} followTail={true} anchor="end" scrollbar="auto">
				<For each={lines()}>{line => <StreamConsoleEventView line={line} />}</For>
			</scroll>
			<input
				tabIndex={focus.tabIndex}
				value={inputValue()}
				onChange={setInputValue}
				onSubmit={handleSubmit}
				onKey={handleKey}
				prompt="> "
			/>
			<text dim wrap="clip">
				{"/title <text> · /quit · ↑/↓ history · Ctrl-C quit"}
			</text>
		</stack>
	);
}

/** Run the fullscreen interactive stream chat console until the stream or user exits. */
export async function runStreamTui(host: StreamMuxHost, info: StreamTuiInfo): Promise<void> {
	const done = Promise.withResolvers<void>();
	const terminal = new ProcessTerminal();
	const [terminalRows, setTerminalRows] = createSignal(terminal.rows);
	const onResize = () => setTerminalRows(terminal.rows);
	process.stdout.on("resize", onResize);

	const quit = () => {
		void host.close("stream stopped").finally(() => done.resolve());
	};

	const root = render(() => <StreamConsoleApp host={host} info={info} terminalRows={terminalRows} onQuit={quit} />, {
		terminal,
		theme,
	});

	try {
		await Promise.race([done.promise, host.wait().then(() => undefined)]);
	} finally {
		process.stdout.removeListener("resize", onResize);
		root.dispose();
	}
}
