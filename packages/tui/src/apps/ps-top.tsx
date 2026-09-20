import { formatDuration } from "@oh-my-pi/pi-utils";
import { clampScrollOffset, scrollOffsetForRow } from "../components/scroll-viewport";
import { cellWidth } from "../core/richtext";
import type { HostKeyEvent } from "../host/input";
import { matchesKey } from "../keys";
import { createSelectController } from "../overlays/select-overlay";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	fromSnapshots,
	onCleanup,
	onMount,
	Show,
	useClock,
	useFocus,
	useViewport,
	type JSX,
} from "../reactive";
import { render } from "../root";
import { ProcessTerminal } from "../terminal";
import { getThemeByName } from "../theme/loader";
import { theme } from "../theme/theme";
import type { DaemonSnapshot, DaemonSpec } from "../tools/hub-contract";
import {
	collapseCommand,
	daemonLabel,
	formatCommand,
	type PsDaemonRow,
	type PsScope,
	type PsScopeReport,
	type PsTarget,
	ScopeHeaderView,
	stateColor,
	TABLE_HEADER,
	TERMINAL_STATES,
	tableCellsPlain,
} from "./ps-data";

const REFRESH_MS = 2_000;
const LOGS_POLL_MS = 1_000;
const STATUS_TTL_MS = 5_000;

interface FlatRow {
	scope: PsScope;
	row: PsDaemonRow;
}

interface LogsState {
	lines: readonly string[];
	state: string;
	error: boolean;
}

type PsTopViewMode = "table" | "info" | "logs";

export interface PsTopOptions extends PsTarget {
	all: boolean;
}

export interface PsTopHost {
	collectReports(all: boolean, target: PsTarget): Promise<PsScopeReport[]>;
	act(scope: PsScope, name: string, verb: "stop" | "kill" | "restart"): Promise<DaemonSnapshot>;
	describe(scope: PsScope, name: string): Promise<{ daemon: DaemonSnapshot; spec: DaemonSpec }>;
	logs(scope: PsScope, name: string, lines: number): Promise<{ terminalRows?: string[]; text: string; state: string }>;
	close(): void;
}

function flatKey(scope: PsScope, name: string): string {
	return `${scope.runtimeDir}\u0000${name}`;
}

function padCell(value: string, width: number): string {
	return `${value}${" ".repeat(Math.max(0, width - cellWidth(value)))}`;
}

function tableWidths(reports: readonly PsScopeReport[], now: number): readonly number[] {
	const widths = TABLE_HEADER.map(cellWidth);
	for (const report of reports) {
		for (const daemon of report.daemons) {
			const cells = tableCellsPlain(daemon, now);
			for (let index = 0; index < cells.length; index++) {
				widths[index] = Math.max(widths[index]!, cellWidth(cells[index]!));
			}
		}
	}
	return widths;
}

function PsHeaderView(props: { title: JSX.Element; titleText: string; age: string; width: number }): JSX.Element {
	const leftWidth = cellWidth(` omp ps · ${props.titleText}`);
	const padding = Math.max(1, props.width - leftWidth - cellWidth(props.age) - 1);
	return (
		<text wrap="clip">
			{" "}
			<span bold>omp ps</span> <span color="dim">·</span> {props.title}
			{" ".repeat(padding)}
			<span color="dim">{props.age}</span>
		</text>
	);
}

function PsFooterView(props: {
	status: string;
	statusColor: "error" | "warning" | "success" | "dim";
	hints: string;
}): JSX.Element {
	return (
		<stack>
			<text wrap="clip">
				{" "}
				<Show when={props.status}>
					<span color={props.statusColor}>{props.status}</span>
				</Show>
			</text>
			<text wrap="clip" color="dim">
				{" "}
				{props.hints}
			</text>
		</stack>
	);
}

function PsTableHeaderView(props: { widths: readonly number[] }): JSX.Element {
	return (
		<text color="dim" wrap="none" overflow="clip">
			{"   "}
			<For each={props.widths}>
				{(width, index) => (
					<>
						<Show when={index() > 0}>{"  "}</Show>
						<span>{padCell(TABLE_HEADER[index()]!, width)}</span>
					</>
				)}
			</For>
		</text>
	);
}

function PsTableRowView(props: {
	scope: PsScope;
	daemon: PsDaemonRow;
	widths: readonly number[];
	selectedKey: string | undefined;
	now: number;
}): JSX.Element {
	const selected = () => flatKey(props.scope, props.daemon.snapshot.name) === props.selectedKey;
	const terminal = () => TERMINAL_STATES[props.daemon.snapshot.state] === true;
	const cells = () => tableCellsPlain(props.daemon, props.now);
	return (
		<text inverse={selected()} dim={terminal()} pad={selected()} wrap="none" overflow="clip">
			{selected() ? " ❯ " : "   "}
			<For each={props.widths}>
				{(width, index) => (
					<>
						<Show when={index() > 0}>{"  "}</Show>
						<span color={index() === 1 ? stateColor(props.daemon) : undefined}>
							{padCell(cells()[index()]!, width)}
						</span>
					</>
				)}
			</For>
		</text>
	);
}

function PsTableBodyView(props: {
	reports: readonly PsScopeReport[];
	selectedKey: string | undefined;
	now: number;
}): JSX.Element {
	const widths = tableWidths(props.reports, props.now);
	return (
		<stack>
			<For each={props.reports}>
				{report => (
					<stack>
						<row gap={0}>
							<text width={1}> </text>
							<box grow={1} minWidth={0}>
								<ScopeHeaderView scope={report.scope} />
							</box>
						</row>
						<Show
							when={report.daemons.length > 0}
							fallback={
								<text color="dim" wrap="none" overflow="clip">
									{" "}
									no processes
								</text>
							}
						>
							<PsTableHeaderView widths={widths} />
							<For each={report.daemons}>
								{daemon => (
									<PsTableRowView
										scope={report.scope}
										daemon={daemon}
										widths={widths}
										selectedKey={props.selectedKey}
										now={props.now}
									/>
								)}
							</For>
						</Show>
						<text>{""}</text>
					</stack>
				)}
			</For>
			<Show when={props.reports.length === 0}>
				<text color="dim" wrap="none" overflow="clip">
					{" "}
					No daemon broker scopes found.
				</text>
			</Show>
		</stack>
	);
}

function PsInfoRowsView(props: { rows: readonly (readonly [string, string])[]; width: number }): JSX.Element {
	const labelWidth = Math.min(9, Math.max(0, props.width - 5));
	return (
		<For each={props.rows}>
			{([label, value]) => (
				<row gap={1} align="start">
					<text width={3}> </text>
					<text width={labelWidth} color="muted" pad wrap="none" overflow="clip">
						{label}
					</text>
					<box grow={1} minWidth={1}>
						<text wrap="word">{value}</text>
					</box>
				</row>
			)}
		</For>
	);
}

function PsInfoBodyView(props: {
	info: { daemon: DaemonSnapshot; spec: DaemonSpec } | undefined;
	now: number;
}): JSX.Element {
	if (!props.info) {
		return (
			<stack>
				<text>{""}</text>
				<text color="dim"> loading…</text>
			</stack>
		);
	}
	const daemon = props.info.daemon;
	const spec = props.info.spec;
	const rows: Array<readonly [string, string]> = [
		["command:", collapseCommand(formatCommand(spec))],
		["cwd:", spec.cwd],
	];
	if (!TERMINAL_STATES[daemon.state]) rows.push(["uptime:", formatDuration(props.now - daemon.startedAt)]);
	if (daemon.exitReason) rows.push(["exit:", daemon.exitReason]);
	rows.push(["restarts:", `${daemon.restartCount} (policy: ${spec.restart})`]);
	rows.push(["owner:", daemon.owner ?? "-"]);

	return (
		<stack>
			<text>{""}</text>
			<text wrap="none" overflow="clip">
				{" "}
				<span bold>{daemonLabel(daemon)}</span>
			</text>
			<text>{""}</text>
			<sized paint={width => <PsInfoRowsView rows={rows} width={width} />} />
			<text wrap="none" overflow="clip">
				{`   pty: ${String(spec.pty)}  persist: ${String(spec.persist)}  detached: ${String(spec.detached)}`}
			</text>
		</stack>
	);
}

function tableRowCount(reports: readonly PsScopeReport[]): number {
	if (reports.length === 0) return 1;
	let rows = 0;
	for (const report of reports) rows += report.daemons.length === 0 ? 3 : report.daemons.length + 3;
	return rows;
}

function selectedTableRow(reports: readonly PsScopeReport[], selectedKey: string | undefined): number {
	let row = 0;
	for (const report of reports) {
		row++;
		if (report.daemons.length === 0) {
			row += 2;
			continue;
		}
		row++;
		for (const daemon of report.daemons) {
			if (flatKey(report.scope, daemon.snapshot.name) === selectedKey) return row;
			row++;
		}
		row++;
	}
	return -1;
}

export interface PsTopAppProps {
	options: PsTopOptions;
	host: PsTopHost;
	onDone: () => void;
}

/** Reactive ps-top application mounted at the root. */
export function PsTopApp(props: PsTopAppProps): JSX.Element {
	const viewport = useViewport();
	const screenHeight = createMemo(() => Math.max(6, viewport().rows));
	const bodyHeight = createMemo(() => screenHeight() - 3);
	const [all, setAll] = createSignal(props.options.all);
	const target: PsTarget = { dir: props.options.dir, global: props.options.global };
	const [selectedKey, setSelectedKey] = createSignal<string>();
	const [viewMode, setViewMode] = createSignal<PsTopViewMode>("table");
	const [info, setInfo] = createSignal<{ daemon: DaemonSnapshot; spec: DaemonSpec }>();
	const [status, setStatus] = createSignal("");
	const [statusColor, setStatusColor] = createSignal<"error" | "warning" | "success" | "dim">("dim");
	const [statusAt, setStatusAt] = createSignal(0);
	const [lastRefresh, setLastRefresh] = createSignal(0);
	const [tableOffset, setTableOffset] = createSignal(0);
	const [logs, setLogs] = createSignal<LogsState>({ lines: [], state: "", error: false });

	let refreshSubscription: (() => void) | undefined;
	let refreshing = false;
	let cachedReports: PsScopeReport[] = [];
	let logsTimer: NodeJS.Timeout | undefined;
	let logsGeneration = 0;
	let priorSelectionIndex = 0;

	const reports = fromSnapshots(
		() => cachedReports,
		notify => {
			let active = true;
			const poll = async () => {
				if (!active || refreshing) return;
				refreshing = true;
				try {
					const next = await props.host.collectReports(all(), target);
					if (!active) return;
					cachedReports = next;
					setLastRefresh(Date.now());
					notify();
				} catch (error) {
					if (!active) return;
					setStatus(error instanceof Error ? error.message : String(error));
					setStatusColor("error");
					setStatusAt(Date.now());
				} finally {
					refreshing = false;
				}
			};
			const refresh = () => void poll();
			refreshSubscription = refresh;
			refresh();
			const timer = setInterval(refresh, REFRESH_MS);
			return () => {
				active = false;
				clearInterval(timer);
				if (refreshSubscription === refresh) refreshSubscription = undefined;
			};
		},
	);

	const flat = createMemo(() =>
		reports().flatMap(report => report.daemons.map(row => ({ scope: report.scope, row }))),
	);
	const selectOptions = createMemo(() =>
		flat().map(entry => ({
			value: flatKey(entry.scope, entry.row.snapshot.name),
			label: entry.row.snapshot.name,
		})),
	);
	const selection = createSelectController({
		options: selectOptions,
		maxRows: bodyHeight,
		wrapNavigation: false,
		search: "never",
		onChange(value) {
			setSelectedKey(value);
			const index = selectOptions().findIndex(option => option.value === value);
			if (index >= 0) priorSelectionIndex = index;
		},
	});
	const selected = selection.selectedIndex;
	const selectedEntry = createMemo(() => {
		const index = selected();
		return index < 0 ? undefined : flat()[index];
	});

	createEffect(() => {
		const options = selectOptions();
		if (options.length === 0) {
			priorSelectionIndex = 0;
			if (selectedKey() !== undefined) setSelectedKey(undefined);
			return;
		}
		const current = selected();
		if (current >= 0) {
			priorSelectionIndex = current;
			const currentKey = options[current]?.value;
			if (currentKey !== undefined && currentKey !== selectedKey()) setSelectedKey(currentKey);
			return;
		}
		const retained = selectedKey() === undefined ? -1 : options.findIndex(option => option.value === selectedKey());
		selection.selectIndex(retained >= 0 ? retained : Math.min(priorSelectionIndex, options.length - 1));
	});

	const bodyRows = createMemo(() => tableRowCount(reports()));
	const activeTableRow = createMemo(() => selectedTableRow(reports(), selectedKey()));
	createEffect(() => {
		const rows = bodyRows();
		const height = bodyHeight();
		const active = activeTableRow();
		setTableOffset(previous =>
			active >= 0 ? scrollOffsetForRow(previous, active, rows, height) : clampScrollOffset(previous, rows, height),
		);
	});

	const clock = useClock("second");
	const age = createMemo(() =>
		lastRefresh() > 0 ? `updated ${formatDuration(clock() - lastRefresh())} ago` : "updating…",
	);
	const currentStatus = createMemo(() => (clock() - statusAt() < STATUS_TTL_MS ? status() : ""));

	const stopLogsPoll = () => {
		logsGeneration++;
		if (logsTimer !== undefined) clearInterval(logsTimer);
		logsTimer = undefined;
	};

	const openLogs = () => {
		if (!selectedEntry()) return;
		stopLogsPoll();
		setLogs({ lines: [], state: "", error: false });
		setViewMode("logs");
		const generation = logsGeneration;
		const poll = async () => {
			const entry = selectedEntry();
			if (generation !== logsGeneration || viewMode() !== "logs" || !entry) return;
			try {
				const result = await props.host.logs(
					entry.scope,
					entry.row.snapshot.name,
					Math.max(10, screenHeight() - 4),
				);
				if (generation !== logsGeneration || viewMode() !== "logs") return;
				setLogs({
					lines: result.terminalRows ?? result.text.replace(/\n$/, "").split("\n"),
					state: result.state,
					error: false,
				});
			} catch (error) {
				if (generation !== logsGeneration || viewMode() !== "logs") return;
				setLogs({
					lines: [error instanceof Error ? error.message : String(error)],
					state: "",
					error: true,
				});
			}
		};
		void poll();
		logsTimer = setInterval(() => void poll(), LOGS_POLL_MS);
	};

	const closeView = () => {
		stopLogsPoll();
		setViewMode("table");
		setInfo(undefined);
	};

	const act = async (verb: "stop" | "kill" | "restart") => {
		const entry = selectedEntry();
		if (!entry) return;
		const name = entry.row.snapshot.name;
		setStatus(`${verb} ${name}…`);
		setStatusColor("warning");
		setStatusAt(Date.now());
		try {
			const daemon = await props.host.act(entry.scope, name, verb);
			setStatus(
				`${verb === "restart" ? "Restarted" : verb === "kill" ? "Killed" : "Stopped"} ${daemonLabel(daemon)}`,
			);
			setStatusColor("success");
			setStatusAt(Date.now());
			refreshSubscription?.();
		} catch (error) {
			setStatus(`${verb} ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
			setStatusColor("error");
			setStatusAt(Date.now());
		}
	};

	const openInfo = async () => {
		const entry = selectedEntry();
		if (!entry) return;
		try {
			const result = await props.host.describe(entry.scope, entry.row.snapshot.name);
			setInfo(result);
			setViewMode("info");
		} catch (error) {
			setStatus(error instanceof Error ? error.message : String(error));
			setStatusColor("error");
			setStatusAt(Date.now());
		}
	};

	const handleKey = (event: HostKeyEvent) => {
		if (matchesKey(event.data, "ctrl+c")) {
			props.onDone();
			return;
		}
		if (viewMode() !== "table") {
			if (matchesKey(event.data, "escape") || event.data === "q") closeView();
			return;
		}
		if (matchesKey(event.data, "escape") || event.data === "q") props.onDone();
		else if (matchesKey(event.data, "up") || event.data === "k") selection.move(-1, false);
		else if (matchesKey(event.data, "down") || event.data === "j") selection.move(1, false);
		else if (event.data === "a") {
			setAll(!all());
			setStatus(all() ? "Showing all scopes" : "Showing current scope");
			setStatusColor("dim");
			setStatusAt(Date.now());
			refreshSubscription?.();
		} else if (matchesKey(event.data, "enter") || event.data === "i") void openInfo();
		else if (event.data === "l") openLogs();
		else if (event.data === "s") void act("stop");
		else if (event.data === "x") void act("kill");
		else if (event.data === "r") void act("restart");
	};

	const focus = useFocus();
	onMount(() => focus.focus());
	onCleanup(stopLogsPoll);

	return (
		<box tabIndex={focus.tabIndex} onKey={handleKey}>
			<sized
				paint={width => {
					const tableTitle = `${flat().length} process${flat().length === 1 ? "" : "es"} in ${reports().length} scope${reports().length === 1 ? "" : "s"} ${all() ? "(all)" : "(current)"}`;
					return (
						<>
							<Show when={viewMode() === "info"}>
								<stack>
									<PsHeaderView
										title={<span>process info</span>}
										titleText="process info"
										age={age()}
										width={width}
									/>
									<scroll height={bodyHeight()} followTail={false} shrinkToFit={false}>
										<PsInfoBodyView info={info()} now={clock()} />
									</scroll>
									<PsFooterView
										status={currentStatus()}
										statusColor={statusColor()}
										hints="esc back · q back"
									/>
								</stack>
							</Show>
							<Show when={viewMode() === "logs"}>
								<stack>
									<PsHeaderView
										title={
											<span>
												logs <span bold>{selectedEntry()?.row.snapshot.name ?? "?"}</span>
												<Show when={logs().state}>
													<span color="dim"> · {logs().state}</span>
												</Show>
											</span>
										}
										titleText={`logs ${selectedEntry()?.row.snapshot.name ?? "?"}${logs().state ? ` · ${logs().state}` : ""}`}
										age={age()}
										width={width}
									/>
									<scroll height={bodyHeight()} followTail anchor="end" shrinkToFit={false}>
										<For each={logs().lines}>
											{line => (
												<text color={logs().error ? "error" : undefined} wrap="none" overflow="clip">
													{" "}
													{line}
												</text>
											)}
										</For>
									</scroll>
									<PsFooterView
										status={currentStatus()}
										statusColor={statusColor()}
										hints="esc back · q back · view refreshes live"
									/>
								</stack>
							</Show>
							<Show when={viewMode() === "table"}>
								<stack>
									<PsHeaderView
										title={
											<span>
												{flat().length} process{flat().length === 1 ? "" : "es"} in {reports().length} scope
												{reports().length === 1 ? "" : "s"}{" "}
												<span color="dim">{all() ? "(all)" : "(current)"}</span>
											</span>
										}
										titleText={tableTitle}
										age={age()}
										width={width}
									/>
									<scroll height={bodyHeight()} offset={tableOffset()} followTail={false} shrinkToFit={false}>
										<PsTableBodyView reports={reports()} selectedKey={selectedKey()} now={clock()} />
									</scroll>
									<PsFooterView
										status={currentStatus()}
										statusColor={statusColor()}
										hints="↑/↓ select · enter info · l logs · s stop · x kill · r restart · a all scopes · q quit"
									/>
								</stack>
							</Show>
						</>
					);
				}}
			/>
		</box>
	);
}

/** Mount and run the interactive ps-top monitoring application. */
export async function runPsTop(options: PsTopOptions, host: PsTopHost): Promise<void> {
	const terminal = new ProcessTerminal();
	const themeInstance = (await getThemeByName("dark")) ?? theme;
	const { promise, resolve } = Promise.withResolvers<void>();
	const handle = render(
		() => (
			<PsTopApp
				options={options}
				host={host}
				onDone={() => {
					resolve();
				}}
			/>
		),
		{ terminal, theme: themeInstance },
	);
	try {
		await promise;
	} finally {
		handle?.dispose();
		host.close();
	}
}
