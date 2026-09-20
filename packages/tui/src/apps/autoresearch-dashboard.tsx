import { Ellipsis } from "@oh-my-pi/pi-natives";
import {
	createMemo,
	createSignal,
	onMount,
	useClock,
	useFocus,
	useTheme,
	useViewport,
	type Accessor,
	type JSX,
} from "../reactive";
import type { HostKeyEvent } from "../host/input";
import { matchesKey } from "../keys";
import { replaceTabs } from "../utils";
import { formatNum, type ExperimentResult, type ExperimentState } from "../tools/autoresearch";
import type { TableCell } from "../host/elements/table";
import {
	currentResults,
	findBaselineMetric,
	findBaselineRunNumber,
	findBaselineSecondary,
	formatElapsed,
	isBetter,
} from "./autoresearch-data";

export interface AutoresearchDashboardRuntime {
	autoresearchMode: boolean;
	dashboardExpanded: boolean;
	state: ExperimentState;
	lastRunSummary: { runNumber: number; passed: boolean; parsedPrimary: number | null } | null;
	runningExperiment: { startedAt: number; command: string } | null;
}

/** A live store accessor or a one-shot snapshot for a dashboard surface. */
export type AutoresearchDashboardRuntimeSource = AutoresearchDashboardRuntime | Accessor<AutoresearchDashboardRuntime>;

function runtimeOf(source: AutoresearchDashboardRuntimeSource): AutoresearchDashboardRuntime {
	return typeof source === "function" ? source() : source;
}

/** The historic controller showed a dashboard only while it had live or recorded state. */
export function shouldShowAutoresearchDashboard(runtime: AutoresearchDashboardRuntime): boolean {
	return (
		runtime.autoresearchMode ||
		runtime.state.results.length > 0 ||
		runtime.runningExperiment !== null ||
		runtime.lastRunSummary !== null
	);
}

function clipPlain(text: string, width: number): string {
	if (width <= 0) return "";
	if (Bun.stringWidth(text) <= width) return text;
	if (width === 1) return "…";
	let prefix = "";
	for (const character of text) {
		if (Bun.stringWidth(`${prefix}${character}`) > width - 1) break;
		prefix += character;
	}
	return `${prefix}…`;
}

function PlainRows({ values }: { values: readonly string[] }): JSX.Element {
	return (
		<stack>
			{values.map((value, index) => (
				<text key={index} wrap="clip" ellipsis={Ellipsis.Unicode}>
					{value}
				</text>
			))}
		</stack>
	);
}

function renderModeStatus(runtime: AutoresearchDashboardRuntime, state: ExperimentState): string {
	if (runtime.autoresearchMode) return state.results.length === 0 ? "baseline pending" : "mode on";
	const current = currentResults(state.results, state.currentSegment);
	if (state.maxExperiments !== null && current.length >= state.maxExperiments) return "segment complete";
	return "mode off";
}

function findBestResult(state: ExperimentState): { index: number; result: ExperimentResult } | null {
	let best: { index: number; result: ExperimentResult } | null = null;
	for (let index = 0; index < state.results.length; index += 1) {
		const result = state.results[index]!;
		if (result.segment !== state.currentSegment || result.status !== "keep" || result.metric <= 0) continue;
		if (!best || isBetter(result.metric, best.result.metric, state.bestDirection)) best = { index, result };
	}
	return best;
}

function renderSecondaryCell(value: number | undefined, unit: string, baseline: number | undefined): string {
	if (value === undefined) return "-";
	const formatted = formatNum(value, unit);
	if (baseline === undefined || baseline === 0 || baseline === value) return formatted;
	const delta = ((value - baseline) / baseline) * 100;
	return `${formatted} ${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

function renderSecondarySummary(
	name: string,
	value: number | undefined,
	baseline: number | undefined,
	unit: string,
): string | null {
	if (value === undefined) return null;
	if (baseline === undefined || baseline === 0 || baseline === value) return `${name} ${formatNum(value, unit)}`;
	const delta = ((value - baseline) / baseline) * 100;
	return `${name} ${formatNum(value, unit)} ${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

function experimentColumns(state: ExperimentState, width: number): number[] {
	const fixed = 4 + 10 + 12 + 11 * state.secondaryMetrics.length + 14;
	const widths = [4, 10, 12, ...state.secondaryMetrics.map(() => 11), 14, Math.max(8, width - fixed)];
	let overflow = Math.max(0, widths.reduce((sum, column) => sum + column, 0) - width);
	for (let index = widths.length - 1; index >= 0 && overflow > 0; index--) {
		const minimum = index === widths.length - 1 ? 8 : 1;
		const shrink = Math.min(overflow, widths[index]! - minimum);
		widths[index] = widths[index]! - shrink;
		overflow -= shrink;
	}
	return widths;
}

function DashboardTable({
	state,
	current,
	baselineSecondary,
	width,
	maxRows,
}: {
	state: ExperimentState;
	current: readonly ExperimentResult[];
	baselineSecondary: Record<string, number>;
	width: number;
	maxRows: number;
}): JSX.Element {
	const widths = experimentColumns(state, width);
	const headerValues = [
		"#",
		"commit",
		state.metricName,
		...state.secondaryMetrics.map(metric => clipPlain(metric.name, 10)),
		"status",
		"description",
	];
	const columns = widths.map(columnWidth => ({
		width: columnWidth,
		align: "left" as const,
		overflow: "ellipsis" as const,
		minWidth: 1,
	}));
	const visible = maxRows > 0 ? current.slice(-maxRows) : current;
	const rows: TableCell[][] = visible.map(result => {
		const statusColor: TableCell["color"] =
			result.status === "keep" ? "success" : result.status === "discard" ? "warning" : "error";
		const values = [
			String(result.runNumber ?? state.results.indexOf(result) + 1),
			result.commit || "-",
			formatNum(result.metric, state.metricUnit),
			...state.secondaryMetrics.map(metric =>
				clipPlain(
					renderSecondaryCell(result.metrics[metric.name], metric.unit, baselineSecondary[metric.name]),
					10,
				),
			),
			result.status,
			replaceTabs(result.description),
		];
		return values.map((text, index): TableCell => ({
			text,
			color:
				index === 0
					? "dim"
					: index === 1
						? "accent"
						: index === 2 || index === values.length - 2
							? statusColor
							: index === values.length - 1
								? "muted"
								: undefined,
		}));
	});
	const header: TableCell[] = headerValues.map((text, index): TableCell => ({
		text,
		color: index === 2 ? "warning" : "muted",
	}));
	const hidden = maxRows > 0 && current.length > maxRows ? current.length - maxRows : 0;
	return (
		<stack>
			<table rows={[header]} columns={columns} gap={0} />
			<text color="borderMuted">{"-".repeat(Math.max(0, width - 1))}</text>
			{hidden > 0 ? <text color="dim">... {hidden} earlier runs hidden ...</text> : null}
			<table rows={rows} columns={columns} gap={0} />
		</stack>
	);
}

function DashboardLinesAtWidth({
	runtime,
	width,
	maxRows,
}: {
	runtime: AutoresearchDashboardRuntimeSource;
	width: number;
	maxRows: number;
}): JSX.Element {
	const active = runtimeOf(runtime);
	const state = active.state;
	if (state.results.length === 0) {
		if (active.lastRunSummary) {
			return (
				<PlainRows
					values={[
						`Pending run: #${active.lastRunSummary.runNumber}`,
						`Result: ${active.lastRunSummary.passed ? "passed" : "failed"}${active.lastRunSummary.parsedPrimary !== null ? `  ${state.metricName} ${formatNum(active.lastRunSummary.parsedPrimary, state.metricUnit)}` : ""}`,
						"Next action: finish log_experiment before starting another run.",
						...(!active.autoresearchMode ? ["Mode: off"] : []),
					]}
				/>
			);
		}
		if (active.autoresearchMode) {
			return (
				<PlainRows
					values={[
						"Current segment: 0 runs",
						"Baseline: pending",
						"Next action: run and log the baseline experiment.",
					]}
				/>
			);
		}
		return <text color="dim">No experiments logged yet.</text>;
	}
	const current = currentResults(state.results, state.currentSegment);
	const kept = current.filter(result => result.status === "keep").length;
	const discarded = current.filter(result => result.status === "discard").length;
	const crashed = current.filter(result => result.status === "crash").length;
	const checksFailed = current.filter(result => result.status === "checks_failed").length;
	const baseline = findBaselineMetric(state.results, state.currentSegment);
	const baselineRunNumber = findBaselineRunNumber(state.results, state.currentSegment);
	const baselineSecondary = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
	const best = findBestResult(state);
	const summary = [
		`Current segment: ${current.length} runs  ${kept} kept  ${discarded} discarded  ${crashed} crashed  ${checksFailed} checks_failed`,
		`Baseline: ${formatNum(baseline, state.metricUnit)}${baselineRunNumber ? ` (#${baselineRunNumber})` : ""}`,
	];
	if (state.results.length > current.length)
		summary.push(`Archived from earlier segments: ${state.results.length - current.length} runs`);
	if (active.lastRunSummary)
		summary.push(
			`Pending run: #${active.lastRunSummary.runNumber} (${active.lastRunSummary.passed ? "passed" : "failed"}) — log_experiment required`,
		);
	if (!active.autoresearchMode) summary.push(`Mode: ${renderModeStatus(active, state)}`);
	if (best) {
		const bestRunNumber = best.result.runNumber ?? best.index + 1;
		let progress = `Best: ${formatNum(best.result.metric, state.metricUnit)} (#${bestRunNumber})`;
		if (baseline !== null && baseline !== 0 && best.result.metric !== baseline) {
			const delta = ((best.result.metric - baseline) / baseline) * 100;
			progress += ` ${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`;
		}
		if (state.confidence !== null) progress += `  conf ${state.confidence.toFixed(1)}x`;
		summary.push(progress);
		const details = state.secondaryMetrics
			.map(metric =>
				renderSecondarySummary(
					metric.name,
					best.result.metrics[metric.name],
					baselineSecondary[metric.name],
					metric.unit,
				),
			)
			.filter((value): value is string => Boolean(value));
		if (details.length > 0) summary.push(`Secondary: ${details.join("  ")}`);
	}
	return (
		<stack>
			<PlainRows values={summary} />
			<text>{""}</text>
			<DashboardTable
				state={state}
				current={current}
				baselineSecondary={baselineSecondary}
				width={width}
				maxRows={maxRows}
			/>
		</stack>
	);
}

/** Experiment progress and result table as a width-aware retained subtree. */
export function DashboardLinesView({
	runtime,
	maxRows,
}: {
	runtime: AutoresearchDashboardRuntimeSource;
	maxRows: number;
}): JSX.Element {
	const painter = createMemo(() => {
		const snapshot = runtimeOf(runtime);
		return (width: number): JSX.Element => (
			<DashboardLinesAtWidth runtime={snapshot} width={width} maxRows={maxRows} />
		);
	});
	return <sized paint={painter()} />;
}

function RunningOnlyView({ runtime }: { runtime: AutoresearchDashboardRuntimeSource }): JSX.Element {
	const active = () => runtimeOf(runtime);
	return (
		<text wrap="clip" ellipsis={Ellipsis.Unicode}>
			<span color="accent">autoresearch</span>
			<span color="warning"> running...</span>
			{active().state.name ? <span color="dim"> | {replaceTabs(active().state.name ?? "")}</span> : null}
			{active().runningExperiment ? (
				<span color="dim"> | {replaceTabs(active().runningExperiment!.command)}</span>
			) : null}
		</text>
	);
}

function CollapsedView({ runtime }: { runtime: AutoresearchDashboardRuntimeSource }): JSX.Element {
	const now = useClock("second");
	const active = () => runtimeOf(runtime);
	const pending = () => active().lastRunSummary;
	const state = () => active().state;
	if (pending()) {
		return (
			<text wrap="clip" ellipsis={Ellipsis.Unicode}>
				<span color="accent">autoresearch</span>
				<span color="warning"> pending run #{pending()!.runNumber}</span>
				<span color="dim">{pending()!.passed ? " pass" : " fail"}</span>
				{pending()!.parsedPrimary !== null ? (
					<span color="muted">
						{" "}
						| {state().metricName}={formatNum(pending()!.parsedPrimary, state().metricUnit)}
					</span>
				) : null}
				<span color="warning"> | log_experiment required</span>
				{!active().autoresearchMode ? <span color="dim"> | mode off</span> : null}
			</text>
		);
	}
	if (state().results.length === 0) {
		return (
			<text wrap="clip" ellipsis={Ellipsis.Unicode}>
				<span color="accent">autoresearch</span>
				<span color="warning"> {active().autoresearchMode ? "baseline pending" : "mode off"}</span>
				{state().name ? <span color="dim"> | {replaceTabs(state().name ?? "")}</span> : null}
				{active().autoresearchMode ? <span color="dim"> | run the baseline</span> : null}
			</text>
		);
	}
	const current = currentResults(state().results, state().currentSegment);
	const kept = current.filter(result => result.status === "keep").length;
	const crashed = current.filter(result => result.status === "crash").length;
	const checksFailed = current.filter(result => result.status === "checks_failed").length;
	const best = findBestResult(state());
	return (
		<text wrap="clip" ellipsis={Ellipsis.Unicode}>
			<span color="accent">autoresearch</span>
			<span color="muted"> {current.length} runs</span>
			<span color="success"> {kept} kept</span>
			{state().results.length > current.length ? (
				<span color="dim"> +{state().results.length - current.length} archived</span>
			) : null}
			{crashed > 0 ? <span color="error"> {crashed} crash</span> : null}
			{checksFailed > 0 ? <span color="error"> {checksFailed} checks_failed</span> : null}
			<span color="dim"> | </span>
			{best && state().bestMetric !== null && best.result.metric !== state().bestMetric ? (
				<>
					<span color="warning">best {formatNum(best.result.metric, state().metricUnit)}</span>
					<span color="dim"> baseline {formatNum(state().bestMetric, state().metricUnit)}</span>
				</>
			) : state().bestMetric !== null ? (
				<span color="warning">baseline {formatNum(state().bestMetric, state().metricUnit)}</span>
			) : (
				<span color="warning">no kept runs yet</span>
			)}
			{state().confidence !== null ? (
				<>
					<span color="dim"> | </span>
					<span color={state().confidence! >= 2 ? "success" : state().confidence! >= 1 ? "warning" : "error"}>
						conf {state().confidence!.toFixed(1)}x
					</span>
				</>
			) : null}
			{active().runningExperiment ? (
				<span color="dim"> | running {formatElapsed(now() - active().runningExperiment!.startedAt)}</span>
			) : !active().autoresearchMode ? (
				<span color="dim"> | {renderModeStatus(active(), state())}</span>
			) : null}
			<span color="dim"> | ctrl+x expand</span>
		</text>
	);
}

function ExpandedHeaderAtWidth({
	runtime,
	width,
}: {
	runtime: AutoresearchDashboardRuntimeSource;
	width: number;
}): JSX.Element {
	const active = runtimeOf(runtime);
	const label = active.state.name ? ` autoresearch: ${replaceTabs(active.state.name)} ` : " autoresearch ";
	const status = renderModeStatus(active, active.state);
	const hint = ` ctrl+x collapse  ctrl+shift+x overlay${status ? `  ${status}` : ""} `;
	const fillWidth = Math.max(0, width - Bun.stringWidth(label) - Bun.stringWidth(hint));
	return (
		<text wrap="clip" ellipsis={Ellipsis.Unicode}>
			<span color="accent">{label}</span>
			<span color="borderMuted">{"-".repeat(fillWidth)}</span>
			<span color="dim">{hint}</span>
		</text>
	);
}

function DashboardHeader({ runtime }: { runtime: AutoresearchDashboardRuntimeSource }): JSX.Element {
	const painter = createMemo(() => {
		const snapshot = runtimeOf(runtime);
		return (width: number): JSX.Element => <ExpandedHeaderAtWidth runtime={snapshot} width={width} />;
	});
	return <sized paint={painter()} />;
}

function ExpandedView({ runtime }: { runtime: AutoresearchDashboardRuntimeSource }): JSX.Element {
	return (
		<stack>
			<DashboardHeader runtime={runtime} />
			<DashboardLinesView runtime={runtime} maxRows={8} />
		</stack>
	);
}

function DashboardOverlayFooterAtWidth({ width }: { width: number }): JSX.Element {
	const hint = " up/down j/k pageup pagedown g G esc ";
	const fill = Math.max(0, width - Bun.stringWidth(hint));
	return (
		<text wrap="clip" ellipsis={Ellipsis.Unicode}>
			<span color="borderMuted">{"-".repeat(fill)}</span>
			<span color="dim">{hint}</span>
		</text>
	);
}

export interface AutoresearchDashboardWidgetViewProps {
	readonly runtime: AutoresearchDashboardRuntimeSource;
}

/** Historical inline widget: compact by default, with its eight-row expanded variant. */
export function AutoresearchDashboardWidgetView(props: AutoresearchDashboardWidgetViewProps): JSX.Element {
	const content = createMemo(() => {
		const runtime = runtimeOf(props.runtime);
		if (runtime.state.results.length === 0 && runtime.runningExperiment) return <RunningOnlyView runtime={runtime} />;
		return runtime.dashboardExpanded ? <ExpandedView runtime={runtime} /> : <CollapsedView runtime={runtime} />;
	});
	return <>{content()}</>;
}

function DashboardRunningLine({ runtime }: { runtime: AutoresearchDashboardRuntimeSource }): JSX.Element {
	const now = useClock("spinner");
	const palette = useTheme();
	const startedAt = now();
	const text = (): string => {
		const running = runtimeOf(runtime).runningExperiment;
		if (!running) return "";
		const frames = palette.theme().spinnerFrames;
		const frame = frames[Math.floor(Math.max(0, now() - startedAt) / 80) % frames.length] ?? "*";
		return `${frame} running ${formatElapsed(now() - running.startedAt)} ${replaceTabs(running.command)}`;
	};
	return (
		<text color="warning" wrap="clip" ellipsis={Ellipsis.Unicode}>
			{text()}
		</text>
	);
}

export interface AutoresearchDashboardViewProps {
	readonly runtime: AutoresearchDashboardRuntimeSource;
	onClose?(): void;
}

/** Reactive, viewport-bounded dashboard overlay with the historical scroll controls. */
export function AutoresearchDashboardView(props: AutoresearchDashboardViewProps): JSX.Element {
	const focus = useFocus();
	const viewport = useViewport();
	const [offset, setOffset] = createSignal(0);
	const [totalRows, setTotalRows] = createSignal(0);
	const [bodyRows, setBodyRows] = createSignal(0);
	const active = () => runtimeOf(props.runtime);
	const scrollHeight = (): number => Math.max(4, viewport().rows - 4);
	const page = (): number => Math.max(1, bodyRows() || scrollHeight());
	const close = (event: HostKeyEvent): void => {
		event.preventDefault();
		event.stopPropagation();
		props.onClose?.();
	};
	const scroll = (delta: number): void => {
		setOffset(value => Math.max(0, value + delta));
	};
	const handleKey = (event: HostKeyEvent): void => {
		const data = event.data;
		if (matchesKey(data, "escape") || matchesKey(data, "esc") || data === "q") {
			close(event);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) scroll(-1);
		else if (matchesKey(data, "down") || matchesKey(data, "j")) scroll(1);
		else if (matchesKey(data, "pageUp")) scroll(-page());
		else if (matchesKey(data, "pageDown")) scroll(page());
		else if (data === "g") setOffset(0);
		else if (data === "G") setOffset(Math.max(0, totalRows() - page()));
		else return;
		event.preventDefault();
		event.stopPropagation();
	};
	onMount(() => focus.focus());
	return (
		<box tabIndex={focus.tabIndex} onKey={handleKey}>
			<stack>
				<DashboardHeader runtime={props.runtime} />
				<scroll
					height={scrollHeight()}
					offset={offset()}
					scrollbar="auto"
					followTail={false}
					trackColor="dim"
					thumbColor="accent"
					onViewport={next => {
						setTotalRows(next.totalRows);
						setBodyRows(next.height);
					}}
				>
					<stack>
						<DashboardLinesView runtime={props.runtime} maxRows={0} />
						{active().runningExperiment ? <DashboardRunningLine runtime={props.runtime} /> : null}
					</stack>
				</scroll>
				<sized paint={width => <DashboardOverlayFooterAtWidth width={width} />} />
			</stack>
		</box>
	);
}
