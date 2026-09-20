import { Ellipsis } from "@oh-my-pi/pi-natives";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { parseAnsiRows } from "../core/ansi";
import type { Out } from "../core/richtext";
import { createDocument } from "../document/document";
import type { TableCell, TableColumn } from "../host/elements/table";
import { render, type RootHandle } from "../root";
import {
	createMemo,
	createSignal,
	For,
	Show,
	useClock,
	useTheme,
	useViewport,
	type Accessor,
	type JSX,
	type Setter,
} from "../reactive";
import { ProcessTerminal, type Terminal } from "../terminal";
import { loadThemeSync } from "../theme/loader";
import { fgOrPlain, theme } from "../theme/theme";
import { replaceTabs } from "../utils";

export type IfBenchFailure = "result" | "cat" | "result+cat" | "format" | "provider";

export interface IfBenchTurnRecord {
	turn: number;
	cumulativeActions: number;
	placement: string;
	durationMs: number;
	passed: boolean;
	failure?: IfBenchFailure;
	expected: string;
	response: string;
}

export interface IfBenchModelReport {
	label: string;
	turns: readonly IfBenchTurnRecord[];
	turnsPassed: number;
	actionsPassed: number;
	failure?: { turn: number; kind: IfBenchFailure };
	durationMs: number;
	outputTokens: number;
	cost: number;
}

export interface IfBenchSummary {
	maxTurns: number;
	arrayLength: number;
	nyaMax: number;
	models: readonly IfBenchModelReport[];
}

export interface IfBenchObserver<
	Turn extends IfBenchTurnRecord = IfBenchTurnRecord,
	Report extends IfBenchModelReport = IfBenchModelReport,
> {
	modelStarted?(label: string): void;
	turnStarted?(label: string, turn: number, actions: number): void;
	turnFinished?(label: string, record: Turn): void;
	modelFinished?(report: Report): void;
}

export interface IfBenchBoard extends IfBenchObserver {
	readonly interactive: boolean;
	log(text: string): void;
	close(): void;
}

export interface IfBenchBoardMeta {
	maxTurns: number;
	arrayLength: number;
	nyaMax: number;
}

interface BoardOutput {
	readonly isTTY?: boolean;
	readonly terminal?: Terminal;
	write(text: string): unknown;
}

const LADDER_WIDTH = 28;
const LABEL_WIDTH = 34;

const FAILURE_TEXT: Record<IfBenchFailure, string> = {
	result: "wrong array",
	cat: "no cat sound",
	"result+cat": "wrong array + no cat sound",
	format: "no <result> block",
	provider: "provider error",
};

interface IfBenchLiveRow {
	readonly label: string;
	readonly startedAt: number;
	readonly turn: number;
	readonly actions: number;
	readonly passed: number;
	readonly failed: boolean;
	readonly placement: string;
	readonly lastDurationMs: number;
}

type IfBenchLogEntry =
	| { readonly id: number; readonly kind: "text"; readonly text: string }
	| { readonly id: number; readonly kind: "report"; readonly report: IfBenchModelReport };

export interface IfBenchBoardSnapshot {
	readonly rows: readonly IfBenchLiveRow[];
	readonly logs: readonly IfBenchLogEntry[];
	readonly startedAt: number;
	readonly closed: boolean;
}

/** Shared reactive state for the normal-buffer live board. */
export class IfBenchBoardModel implements IfBenchObserver {
	readonly #meta: IfBenchBoardMeta;
	readonly #startedAt = Date.now();
	readonly #rows = new Map<string, IfBenchLiveRow>();
	readonly #logs: IfBenchLogEntry[] = [];
	readonly #revision: Accessor<number>;
	readonly #setRevision: Setter<number>;
	#nextLogId = 1;
	#closed = false;

	constructor(meta: IfBenchBoardMeta) {
		this.#meta = meta;
		const [revision, setRevision] = createSignal(0);
		this.#revision = revision;
		this.#setRevision = setRevision;
	}

	get meta(): IfBenchBoardMeta {
		return this.#meta;
	}

	get startedAt(): number {
		return this.#startedAt;
	}

	snapshot(): IfBenchBoardSnapshot {
		this.#revision();
		return {
			rows: Array.from(this.#rows.values()),
			logs: this.#logs,
			startedAt: this.#startedAt,
			closed: this.#closed,
		};
	}

	log(text: string): void {
		if (this.#closed) return;
		this.#logs.push({ id: this.#nextLogId++, kind: "text", text });
		this.#notify();
	}

	modelStarted(label: string): void {
		if (this.#closed) return;
		this.#rows.set(label, {
			label,
			startedAt: Date.now(),
			turn: 0,
			actions: 0,
			passed: 0,
			failed: false,
			placement: "",
			lastDurationMs: 0,
		});
		this.#notify();
	}

	turnStarted(label: string, turn: number): void {
		if (this.#closed) return;
		const row = this.#rows.get(label);
		if (!row) return;
		this.#rows.set(label, { ...row, turn });
		this.#notify();
	}

	turnFinished(label: string, record: IfBenchTurnRecord): void {
		if (this.#closed) return;
		const row = this.#rows.get(label);
		if (!row) return;
		this.#rows.set(label, {
			...row,
			actions: record.cumulativeActions,
			placement: record.placement,
			lastDurationMs: record.durationMs,
			passed: record.passed ? record.turn : row.passed,
			failed: row.failed || !record.passed,
		});
		this.#notify();
	}

	modelFinished(report: IfBenchModelReport): void {
		if (this.#closed) return;
		this.#rows.delete(report.label);
		this.#logs.push({ id: this.#nextLogId++, kind: "report", report });
		this.#notify();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#rows.clear();
		this.#notify();
	}

	#notify(): void {
		this.#setRevision(revision => revision + 1);
	}
}

function formatCost(cost: number): string {
	return `$${cost >= 0.095 ? cost.toFixed(2) : cost.toFixed(3)}`;
}

function meanTurnMs(report: IfBenchModelReport): number {
	return report.turns.length === 0 ? 0 : report.durationMs / report.turns.length;
}

function formatTurnLine(label: string, record: IfBenchTurnRecord): string {
	const head = `[turn ${record.turn}] ${label} ${record.cumulativeActions} acts cat@${record.placement}`;
	return record.passed
		? `${head} PASS ${formatDuration(Math.round(record.durationMs))}`
		: `${head} FAIL ${record.failure ?? "format"}`;
}

function formatVerdict(report: IfBenchModelReport, meta: IfBenchBoardMeta): string {
	const stats = [
		`${report.turnsPassed}/${meta.maxTurns} turns`,
		`${report.actionsPassed} actions`,
		`${formatDuration(Math.round(meanTurnMs(report)))}/turn`,
	];
	if (report.outputTokens > 0) stats.push(`${formatNumber(report.outputTokens)} tok`);
	if (report.cost > 0) stats.push(formatCost(report.cost));
	const body = `${typeof theme === "undefined" ? report.label : theme.bold(report.label)} ${stats.join(fgOrPlain("dim", " · "))}`;
	if (!report.failure) return `${fgOrPlain("success", "✓")} ${body}`;
	return `${fgOrPlain("error", "✗")} ${body} ${fgOrPlain("dim", "·")} ${fgOrPlain("error", `broke on turn ${report.failure.turn}: ${FAILURE_TEXT[report.failure.kind]}`)}`;
}

function failureDetails(
	report: IfBenchModelReport,
): readonly { readonly kind: "provider" | "expected" | "actual"; readonly text: string }[] {
	const failed = report.turns.at(-1);
	if (!failed || !report.failure) return [];
	const oneLine = (text: string): string => replaceTabs(text).replace(/\s+/gu, " ").trim();
	if (failed.failure === "provider") return [{ kind: "provider", text: oneLine(failed.response) }];
	return [
		{ kind: "expected", text: failed.expected },
		{ kind: "actual", text: oneLine(failed.response) },
	];
}

function durationSince(now: number, then: number): string {
	return formatDuration(Math.max(0, now - then));
}

function singleLine(text: string): string {
	return replaceTabs(text).replace(/[\r\n]+/gu, " ");
}

interface LadderParts {
	readonly passed: string;
	readonly active: string;
	readonly remaining: string;
	readonly activeColor: "error" | "warning";
}

function ladder(row: IfBenchLiveRow, maxTurns: number, spinner: string): LadderParts {
	const width = Math.min(maxTurns, LADDER_WIDTH);
	if (width <= 0) return { passed: "", active: "", remaining: "", activeColor: row.failed ? "error" : "warning" };
	const scale = width / maxTurns;
	const filled = Math.min(width, Math.round(row.passed * scale));
	const active = row.failed || filled >= width ? 0 : Math.max(0, Math.min(width - filled, Math.round(scale)) || 1);
	const rest = Math.max(0, width - filled - active);
	if (row.failed) {
		const retained = width - 1;
		const keptPassed = Math.min(filled, retained);
		const keptActive = Math.min(1, Math.max(0, retained - keptPassed));
		const keptRemaining = Math.max(0, retained - keptPassed - keptActive);
		return {
			passed: "█".repeat(keptPassed),
			active: "▚".repeat(keptActive),
			remaining: `${"░".repeat(keptRemaining)}…`,
			activeColor: "error",
		};
	}
	return {
		passed: "█".repeat(filled),
		active: spinner.repeat(active),
		remaining: "░".repeat(rest),
		activeColor: "warning",
	};
}

function IfBenchLiveHeader(props: {
	readonly meta: IfBenchBoardMeta;
	readonly rows: Accessor<readonly IfBenchLiveRow[]>;
	readonly startedAt: number;
	readonly now: Accessor<number>;
	readonly spinner: Accessor<string>;
}): JSX.Element {
	const deepest = createMemo(() => Math.max(0, ...props.rows().map(row => row.actions)));
	return (
		<text wrap="clip" ellipsis={Ellipsis.Unicode}>
			<span color="accent">{props.spinner()}</span> <span bold>if-bench</span> <span color="dim">·</span>{" "}
			{props.rows().length} live <span color="dim">·</span> {deepest()} actions <span color="dim">·</span>{" "}
			<span color="dim">{`L=${props.meta.arrayLength} nya{1,${props.meta.nyaMax}}`}</span> <span color="dim">·</span>{" "}
			{durationSince(props.now(), props.startedAt)}
		</text>
	);
}

function IfBenchLiveRowView(props: {
	readonly row: IfBenchLiveRow;
	readonly meta: IfBenchBoardMeta;
	readonly now: Accessor<number>;
	readonly spinner: Accessor<string>;
}): JSX.Element {
	const meter = createMemo(() => ladder(props.row, props.meta.maxTurns, props.spinner()));
	const detail = createMemo(() => {
		const parts = [
			`turn ${Math.max(props.row.turn, 1)}/${props.meta.maxTurns}`,
			`${props.row.actions} acts`,
			durationSince(props.now(), props.row.startedAt),
		];
		if (props.row.placement) parts.push(`cat@${props.row.placement}`);
		return parts;
	});
	return (
		<row gap={1} wrap="continuation" continuationIndent={2}>
			<text width={1} shrink={0} color="warning" wrap="clip">
				{props.spinner()}
			</text>
			<text width={LABEL_WIDTH} shrink={1} overflowPriority={0} wrap="clip" overflow="ellipsis">
				{singleLine(props.row.label)}
			</text>
			<text shrink={0} color="success" wrap="clip">
				{meter().passed}
			</text>
			<text shrink={0} color={meter().activeColor} wrap="clip">
				{meter().active}
			</text>
			<text shrink={0} color="dim" wrap="clip">
				{meter().remaining}
			</text>
			<text grow={1} minWidth={12} wrap="word">
				{detail()[0]}
				<span color="dim"> · </span>
				{detail()[1]}
				<span color="dim"> · </span>
				{detail()[2]}
				<Show when={detail()[3]}>
					{(placement: Accessor<string>) => (
						<>
							<span color="dim"> · </span>
							<span color="dim">{placement()}</span>
						</>
					)}
				</Show>
			</text>
		</row>
	);
}

function IfBenchLiveRowsView(props: { readonly model: IfBenchBoardModel }): JSX.Element {
	const viewport = useViewport();
	const theme = useTheme();
	const tick = useClock("spinner");
	const snapshot = () => props.model.snapshot();
	const rows = createMemo(() => snapshot().rows);
	const spinner = createMemo(() => {
		const frames = theme.theme().getSpinnerFrames("activity");
		const elapsed = Math.max(0, tick() - props.model.startedAt);
		return frames[Math.floor(elapsed / 80) % frames.length] ?? "*";
	});
	const maximumRows = createMemo(() => Math.max(4, viewport().rows - 2));
	const visibleRows = createMemo(() => {
		const available = maximumRows() - 1;
		return rows().length > available ? rows().slice(0, Math.max(0, available - 1)) : rows();
	});
	const hiddenRows = createMemo(() => Math.max(0, rows().length - visibleRows().length));
	return (
		<Show when={rows().length > 0}>
			<stack>
				<IfBenchLiveHeader
					meta={props.model.meta}
					rows={rows}
					startedAt={props.model.startedAt}
					now={tick}
					spinner={spinner}
				/>
				<For each={visibleRows()}>
					{row => <IfBenchLiveRowView row={row} meta={props.model.meta} now={tick} spinner={spinner} />}
				</For>
				<Show when={hiddenRows() > 0}>
					<text wrap="clip" ellipsis={Ellipsis.Unicode}>
						… +{hiddenRows()} more
					</text>
				</Show>
			</stack>
		</Show>
	);
}

function IfBenchReportView(props: {
	readonly report: IfBenchModelReport;
	readonly meta: IfBenchBoardMeta;
}): JSX.Element {
	const stats = [
		`${props.report.turnsPassed}/${props.meta.maxTurns} turns`,
		`${props.report.actionsPassed} actions`,
		`${formatDuration(Math.round(meanTurnMs(props.report)))}/turn`,
		...(props.report.outputTokens > 0 ? [`${formatNumber(props.report.outputTokens)} tok`] : []),
		...(props.report.cost > 0 ? [formatCost(props.report.cost)] : []),
	];
	const details = failureDetails(props.report);
	const failure = props.report.failure;
	return (
		<stack>
			<text wrap="clip" ellipsis={Ellipsis.Unicode}>
				<span color={failure ? "error" : "success"}>{failure ? "✗" : "✓"}</span>{" "}
				<span bold>{props.report.label}</span>{" "}
				<For each={stats}>
					{(stat, index) => (
						<>
							<Show when={index() > 0}>
								<span color="dim"> · </span>
							</Show>
							<span>{stat}</span>
						</>
					)}
				</For>
				{failure ? (
					<>
						<span color="dim"> · </span>
						<span color="error">
							broke on turn {failure.turn}: {FAILURE_TEXT[failure.kind]}
						</span>
					</>
				) : null}
			</text>
			<For each={details}>
				{detail => {
					if (detail.kind === "provider")
						return (
							<text wrap="clip" ellipsis={Ellipsis.Unicode}>
								{"    "}
								<span color="dim">provider</span> <span color="error">{detail.text}</span>
							</text>
						);
					if (detail.kind === "expected")
						return (
							<text wrap="clip" ellipsis={Ellipsis.Unicode}>
								{"    "}
								<span color="dim">expected</span>
								{" <"}
								{detail.text}
								{">"}
							</text>
						);
					return (
						<text wrap="clip" ellipsis={Ellipsis.Unicode}>
							{"    "}
							<span color="dim">{"actual   "}</span>
							<span color="error">{detail.text}</span>
						</text>
					);
				}}
			</For>
		</stack>
	);
}

function IfBenchLogView(props: { readonly entry: IfBenchLogEntry; readonly meta: IfBenchBoardMeta }): JSX.Element {
	if (props.entry.kind === "report") return <IfBenchReportView report={props.entry.report} meta={props.meta} />;
	const document = createDocument(props.entry.text);
	return <pre document={document} ansi />;
}

/** Retained normal-buffer surface for the live rows and permanent verdicts. */
export function IfBenchBoardView(props: { readonly model: IfBenchBoardModel }): JSX.Element {
	const snapshot = () => props.model.snapshot();
	return (
		<transcript>
			<transcript-block settled={snapshot().closed}>
				<stack>
					<For each={snapshot().logs}>{entry => <IfBenchLogView entry={entry} meta={props.model.meta} />}</For>
					<sized paint={() => <IfBenchLiveRowsView model={props.model} />} />
				</stack>
			</transcript-block>
		</transcript>
	);
}

class IfBenchReactiveBoard implements IfBenchBoard {
	readonly interactive = true;
	readonly #model: IfBenchBoardModel;
	readonly #terminal: Terminal;
	#root: RootHandle | undefined;

	constructor(meta: IfBenchBoardMeta, terminal: Terminal) {
		this.#model = new IfBenchBoardModel(meta);
		this.#terminal = terminal;
	}

	log(text: string): void {
		this.#mount();
		this.#model.log(text);
	}

	modelStarted(label: string): void {
		this.#mount();
		this.#model.modelStarted(label);
	}

	turnStarted(label: string, turn: number): void {
		this.#mount();
		this.#model.turnStarted(label, turn);
	}

	turnFinished(label: string, record: IfBenchTurnRecord): void {
		this.#mount();
		this.#model.turnFinished(label, record);
	}

	modelFinished(report: IfBenchModelReport): void {
		this.#mount();
		this.#model.modelFinished(report);
	}

	close(): void {
		this.#model.close();
		this.#root?.dispose();
		this.#root = undefined;
	}

	#mount(): void {
		if (this.#root !== undefined) return;
		const activeTheme = typeof theme === "undefined" ? loadThemeSync("dark") : theme;
		this.#root = render(() => <IfBenchBoardView model={this.#model} />, {
			terminal: this.#terminal,
			theme: activeTheme,
			deferInput: true,
		});
	}
}

/** Plain reporter for piped and redirected command output. */
class IfBenchReporter implements IfBenchBoard {
	readonly interactive = false;
	readonly #model: IfBenchBoardModel;
	readonly #output: BoardOutput;
	readonly #errors: BoardOutput;

	constructor(meta: IfBenchBoardMeta, output: BoardOutput, errors: BoardOutput) {
		this.#model = new IfBenchBoardModel(meta);
		this.#output = output;
		this.#errors = errors;
	}

	log(text: string): void {
		this.#model.log(text);
		this.#output.write(`${text}\n`);
	}

	modelStarted(label: string): void {
		this.#model.modelStarted(label);
	}

	turnStarted(label: string, turn: number): void {
		this.#model.turnStarted(label, turn);
	}

	turnFinished(label: string, record: IfBenchTurnRecord): void {
		this.#model.turnFinished(label, record);
		(record.passed ? this.#output : this.#errors).write(`${formatTurnLine(label, record)}\n`);
	}

	modelFinished(report: IfBenchModelReport): void {
		this.#model.modelFinished(report);
		this.#output.write(`${formatVerdict(report, this.#model.meta)}\n`);
		for (const detail of failureDetails(report)) {
			if (detail.kind === "provider") {
				this.#output.write(`    ${fgOrPlain("dim", "provider")} ${fgOrPlain("error", detail.text)}\n`);
			} else if (detail.kind === "expected") {
				this.#output.write(`    ${fgOrPlain("dim", "expected")} <${detail.text}>\n`);
			} else {
				this.#output.write(`    ${fgOrPlain("dim", "actual  ")} ${fgOrPlain("error", detail.text)}\n`);
			}
		}
	}

	close(): void {
		this.#model.close();
	}
}

/** Create a retained live board for TTY output and a line-oriented reporter otherwise. */
export function createIfBenchBoard(
	meta: IfBenchBoardMeta,
	output: BoardOutput = process.stdout,
	errors: BoardOutput = process.stderr,
): IfBenchBoard {
	if (output.isTTY === true && (output.terminal !== undefined || process.stdout.isTTY === true)) {
		return new IfBenchReactiveBoard(meta, output.terminal ?? new ProcessTerminal());
	}
	return new IfBenchReporter(meta, output, errors);
}

interface ScoreboardColumn {
	readonly header: string;
	readonly value: (report: IfBenchModelReport) => string;
	readonly align?: "right";
}

function scoreboardColumns(summary: IfBenchSummary): readonly ScoreboardColumn[] {
	return [
		{ header: "model", value: report => report.label },
		{ header: "turns", value: report => `${report.turnsPassed}/${summary.maxTurns}`, align: "right" },
		{ header: "actions", value: report => String(report.actionsPassed), align: "right" },
		{
			header: "broke on",
			value: report =>
				report.failure ? `turn ${report.failure.turn} · ${FAILURE_TEXT[report.failure.kind]}` : "survived",
		},
		{ header: "per turn", value: report => formatDuration(Math.round(meanTurnMs(report))), align: "right" },
		{
			header: "tokens",
			value: report => (report.outputTokens > 0 ? formatNumber(report.outputTokens) : "-"),
			align: "right",
		},
		{ header: "cost", value: report => (report.cost > 0 ? formatCost(report.cost) : "-"), align: "right" },
	];
}

function rankedReports(summary: IfBenchSummary): IfBenchModelReport[] {
	return [...summary.models].sort(
		(a, b) => b.turnsPassed - a.turnsPassed || b.actionsPassed - a.actionsPassed || meanTurnMs(a) - meanTurnMs(b),
	);
}

export function IfBenchScoreboardView(props: { readonly summary: IfBenchSummary }): JSX.Element {
	const ranked = rankedReports(props.summary);
	const definitions = scoreboardColumns(props.summary);
	const columns: TableColumn[] = definitions.map(column => ({
		grow: column.header === "model" ? 3 : 1,
		align: column.align ?? "left",
		overflow: "ellipsis",
	}));
	const header: TableCell[] = definitions.map(column => ({ text: column.header, color: "dim" }));
	const rows: TableCell[][] = [
		header,
		...ranked.map((report, index) =>
			definitions.map((column): TableCell => ({
				text: column.value(report),
				color: index === 0 && report.turnsPassed > 0 ? "success" : undefined,
			})),
		),
	];
	return <table rows={rows} columns={columns} gap={2} />;
}

/** Paint the compact scoreboard into an existing run sink. */
export function paintIfBenchScoreboard(target: Out, summary: IfBenchSummary): void {
	parseAnsiRows(formatIfBenchScoreboard(summary).trimEnd().split("\n"), target);
}

/** Format the benchmark scoreboard for stdout. */
export function formatIfBenchScoreboard(summary: IfBenchSummary): string {
	const definitions = scoreboardColumns(summary);
	const values = rankedReports(summary).map(report => definitions.map(column => column.value(report)));
	const widths = definitions.map((column, index) =>
		Math.max(Bun.stringWidth(column.header), ...values.map(row => Bun.stringWidth(row[index]!))),
	);
	const formatRow = (row: readonly string[]): string =>
		row
			.map((value, index) => {
				const width = widths[index]!;
				const padding = " ".repeat(Math.max(0, width - Bun.stringWidth(value)));
				return definitions[index]!.align === "right" ? `${padding}${value}` : `${value}${padding}`;
			})
			.join("  ");
	return `${fgOrPlain("dim", formatRow(definitions.map(column => column.header)))}\n${values.map(formatRow).join("\n")}\n`;
}
