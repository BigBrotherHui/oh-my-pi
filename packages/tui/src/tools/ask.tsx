import { createDocument } from "../document";
import { For, Show, createMemo, type Accessor, type JSX } from "../reactive";
import { replaceTabs, sanitizeCarriageReturns } from "../render/render-utils";

import { registerToolView } from "./registry";
import { Card } from "../view/card";
import type { ActivitySummary, CallOutcome, CallPhase, DeepReadonly, ToolViewDefinition, ToolViewProps } from "./view";

/** Result for a single question. */
export interface QuestionResult {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
	note?: string;
	timedOut?: boolean;
}

/** Answers and redirect metadata displayed for an ask tool result. */
export interface AskToolDetails {
	question?: string;
	options?: string[];
	multi?: boolean;
	selectedOptions?: string[];
	customInput?: string;
	note?: string;
	timedOut?: boolean;
	results?: QuestionResult[];
	chatRedirect?: boolean;
	questions?: string[];
}

export interface AskRenderOption {
	label: string;
	description?: string;
	/** Original selection value when display text has been sanitized. */
	value?: string;
}

export interface AskRenderArgs {
	question?: string;
	options?: AskRenderOption[];
	multi?: boolean;
	questions?: Array<{
		id: string;
		question: string;
		options: AskRenderOption[];
		multi?: boolean;
	}>;
}

export function normalizeRenderOptions(raw: unknown): AskRenderOption[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const normalized: AskRenderOption[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			normalized.push({ label: sanitizeCarriageReturns(entry), value: entry });
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const { label, description } = entry as Partial<AskRenderOption>;
		if (typeof label !== "string") continue;
		normalized.push(
			typeof description === "string"
				? { label: sanitizeCarriageReturns(label), description: sanitizeCarriageReturns(description), value: label }
				: { label: sanitizeCarriageReturns(label), value: label },
		);
	}
	return normalized;
}

export function sanitizeAskResultDetails(details: DeepReadonly<AskToolDetails>): AskToolDetails {
	return {
		...(details.question !== undefined ? { question: sanitizeCarriageReturns(details.question) } : {}),
		...(details.options !== undefined ? { options: details.options.map(sanitizeCarriageReturns) } : {}),
		...(details.multi !== undefined ? { multi: details.multi } : {}),
		...(details.selectedOptions !== undefined
			? { selectedOptions: details.selectedOptions.map(sanitizeCarriageReturns) }
			: {}),
		...(details.customInput !== undefined ? { customInput: sanitizeCarriageReturns(details.customInput) } : {}),
		...(details.note !== undefined ? { note: sanitizeCarriageReturns(details.note) } : {}),
		...(details.timedOut !== undefined ? { timedOut: details.timedOut } : {}),
		...(details.chatRedirect !== undefined ? { chatRedirect: details.chatRedirect } : {}),
		...(details.questions !== undefined ? { questions: details.questions.map(sanitizeCarriageReturns) } : {}),
		...(details.results !== undefined
			? {
					results: details.results.map(entry => ({
						id: sanitizeCarriageReturns(entry.id),
						question: sanitizeCarriageReturns(entry.question),
						options: entry.options.map(sanitizeCarriageReturns),
						multi: entry.multi,
						selectedOptions: entry.selectedOptions.map(sanitizeCarriageReturns),
						...(entry.customInput !== undefined
							? { customInput: sanitizeCarriageReturns(entry.customInput) }
							: {}),
						...(entry.note !== undefined ? { note: sanitizeCarriageReturns(entry.note) } : {}),
						...(entry.timedOut !== undefined ? { timedOut: entry.timedOut } : {}),
					})),
				}
			: {}),
	};
}

export function normalizeRenderQuestions(raw: unknown): NonNullable<AskRenderArgs["questions"]> | undefined {
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return undefined;
		}
	}
	if (!Array.isArray(raw)) return undefined;
	const normalized: NonNullable<AskRenderArgs["questions"]> = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const question = entry as Partial<NonNullable<AskRenderArgs["questions"]>[number]>;
		normalized.push({
			id: typeof question.id === "string" ? sanitizeCarriageReturns(question.id) : "?",
			question: typeof question.question === "string" ? sanitizeCarriageReturns(question.question) : "",
			options: normalizeRenderOptions(question.options) ?? [],
			multi: question.multi === true,
		});
	}
	return normalized;
}

function statusFor(phase: CallPhase, outcome: CallOutcome | undefined): ActivitySummary["status"] {
	if (phase === "receiving" || phase === "queued") return "pending";
	if (phase === "running") return "running";
	if (outcome === "failed") return "error";
	if (outcome === "cancelled") return "aborted";
	if (outcome === "timed_out") return "warning";
	if (outcome === "skipped") return "info";
	return "success";
}

function cardRecipe(
	phase: CallPhase,
	outcome: CallOutcome | undefined,
	tone: "success" | "warning" | undefined = undefined,
	autoTimedOut = false,
): string | undefined {
	if (phase !== "settled") return `tool.card.${phase}`;
	if (outcome === "failed" || (outcome === "timed_out" && !autoTimedOut)) return "tool.card.error";
	if (tone === "warning" || outcome === "cancelled" || outcome === "skipped") return "tool.card.queued";
	if (outcome === "success" || tone === "success") return "tool.card.success";
	return undefined;
}

function hasAnswer(question: {
	readonly selectedOptions: readonly string[];
	readonly customInput?: string;
	readonly note?: string;
}): boolean {
	return question.selectedOptions.length > 0 || question.customInput !== undefined || question.note !== undefined;
}

function selectedIndicesFor(
	rawOptions: readonly string[] | undefined,
	rawSelected: readonly string[] | undefined,
): ReadonlySet<number> | undefined {
	if (!rawOptions || rawOptions.length === 0) return undefined;
	const selected = new Set(rawSelected ?? []);
	const indices = new Set<number>();
	rawOptions.forEach((option, index) => {
		if (selected.has(option)) indices.add(index);
	});
	return indices;
}

interface QuestionItem {
	readonly id: string;
	readonly question: string;
	readonly options: readonly AskRenderOption[];
	readonly multi: boolean;
	readonly selectedOptions: readonly string[];
	readonly selectedIndices?: ReadonlySet<number>;
	readonly customInput?: string;
	readonly note?: string;
	readonly timedOut?: boolean;
}

function questionFromResult(result: QuestionResult, rawResult: DeepReadonly<QuestionResult> | undefined): QuestionItem {
	const labels = result.options.length > 0 ? result.options : result.selectedOptions;
	return {
		id: result.id,
		question: result.question,
		options: labels.map((label, index): AskRenderOption => ({
			label,
			value: rawResult?.options[index] ?? label,
		})),
		multi: result.multi,
		selectedOptions: result.selectedOptions,
		selectedIndices: selectedIndicesFor(rawResult?.options, rawResult?.selectedOptions),
		customInput: result.customInput,
		note: result.note,
		timedOut: result.timedOut,
	};
}

function questionFromDetails(details: AskToolDetails, rawDetails: DeepReadonly<AskToolDetails>): QuestionItem {
	const labels = details.options?.length ? details.options : (details.selectedOptions ?? []);
	return {
		id: "q0",
		question: details.question ?? "",
		options: labels.map((label, index): AskRenderOption => ({
			label,
			value: rawDetails.options?.[index] ?? label,
		})),
		multi: details.multi === true,
		selectedOptions: details.selectedOptions ?? [],
		selectedIndices: selectedIndicesFor(rawDetails.options, rawDetails.selectedOptions),
		customInput: details.customInput,
		note: details.note,
		timedOut: details.timedOut,
	};
}

function isOptionSelected(question: QuestionItem, index: number): boolean {
	if (question.selectedIndices !== undefined) return question.selectedIndices.has(index);
	const option = question.options[index];
	return option !== undefined && question.selectedOptions.includes(option.value ?? option.label);
}

function sectionLabel(question: QuestionItem, includeMetadata: boolean, separator: string): string {
	if (!includeMetadata) return `[${question.id}]`;
	const metadata: string[] = [];
	if (question.multi) metadata.push("multi");
	if (question.options.length > 0) metadata.push(`options:${question.options.length}`);
	return metadata.length === 0
		? `[${question.id}]`
		: `[${question.id}] ${separator} ${metadata.join(` ${separator} `)}`;
}

function QuestionDivider(props: { readonly question: QuestionItem; readonly metadata: boolean }): JSX.Element {
	return <hr variant="frame" label={sectionLabel(props.question, props.metadata, "·")} labelColor="dim" />;
}

function AskCallHeader(props: {
	readonly questions: readonly QuestionItem[];
	readonly multipart: boolean;
}): JSX.Element {
	const metadata = (): string[] => {
		const question = props.questions[0];
		if (question === undefined || props.multipart) return [];
		const values: string[] = [];
		if (question.multi) values.push("multi");
		if (question.options.length > 0) values.push(`options:${question.options.length}`);
		return values;
	};
	return (
		<text bold={false}>
			<span color="toolTitle">Ask</span>
			<Show
				when={props.multipart}
				fallback={
					<Show when={metadata().length > 0}>
						{" "}
						<span color="muted">{metadata().join(" · ")}</span>
					</Show>
				}
			>
				{" "}
				<span color="muted">{props.questions.length} questions</span>
			</Show>
		</text>
	);
}

function AskResultHeader(props: {
	readonly phase: CallPhase;
	readonly outcome: CallOutcome | undefined;
	readonly multipart: boolean;
	readonly questionCount: number;
	readonly answered: boolean;
	readonly autoTimedOut: boolean;
}): JSX.Element {
	const lifecycle =
		props.phase === "settled" &&
		(props.outcome === undefined ||
			props.outcome === "success" ||
			(props.outcome === "timed_out" && props.autoTimedOut))
			? undefined
			: statusFor(props.phase, props.outcome);
	if (!props.multipart) {
		return (
			<text color="accent" bold={false}>
				<Show
					when={lifecycle}
					fallback={
						<Show when={props.answered} fallback={<status value="warning" />}>
							<icon name="tool.ask" color="accent" />
						</Show>
					}
				>
					{(status: Accessor<ActivitySummary["status"]>) => <status value={status()} />}
				</Show>{" "}
				Ask
			</text>
		);
	}
	return (
		<text bold={false}>
			<status value={lifecycle ?? (props.answered ? "success" : "warning")} /> <span color="accent">Ask</span>{" "}
			<span color="dim">{props.questionCount} questions</span>
		</text>
	);
}

function AskRedirectHeader(): JSX.Element {
	return (
		<text bold={false}>
			<status value="info" /> <span color="accent">Ask</span> <span color="dim">chat redirect</span>
		</text>
	);
}

function AskCard(props: {
	readonly phase: CallPhase;
	readonly outcome: CallOutcome | undefined;
	readonly tone?: "success" | "warning";
	readonly autoTimedOut?: boolean;
	readonly header: JSX.Element;
	readonly children?: JSX.Element;
}): JSX.Element {
	return (
		<Card
			title={props.header}
			titleInset={3}
			borderColor="borderMuted"
			backgroundBorder
			paddingX={1}
			paddingY={0}
			recipe={cardRecipe(props.phase, props.outcome, props.tone, props.autoTimedOut)}
		>
			{props.children}
		</Card>
	);
}

function AskQuestion(props: { readonly question: QuestionItem; readonly answer: boolean }): JSX.Element {
	const noteLines = createMemo(() =>
		props.question.note === undefined ? [] : replaceTabs(props.question.note).split("\n"),
	);
	const customLines = (): string[] => (props.question.customInput ?? "").split("\n");
	const isCancelled = (): boolean => props.answer && !hasAnswer(props.question);

	return (
		<stack>
			<box padding={{ left: 1 }}>
				<markdown document={createDocument(props.question.question)} color="accent" />
			</box>
			<box>
				<For each={props.question.options}>
					{(option, index) => {
						const selected = (): boolean => isOptionSelected(props.question, index());
						return (
							<stack>
								<box padding={{ left: 1 }}>
									<row gap={1} pad={false}>
										<icon
											name={
												props.question.multi
													? selected()
														? "checkbox.checked"
														: "checkbox.unchecked"
													: selected()
														? "radio.selected"
														: "radio.unselected"
											}
											color={selected() ? "success" : "dim"}
										/>
										<text color="toolOutput" grow={1} minWidth={1}>
											<markdown document={createDocument(option.label)} />
										</text>
									</row>
								</box>
								<Show when={option.description?.trim()}>
									{(description: Accessor<string>) => (
										<text color="dim">
											{"   "}↳ <markdown document={createDocument(description())} />
										</text>
									)}
								</Show>
							</stack>
						);
					}}
				</For>
				<Show when={isCancelled()}>
					<row gap={1} pad={false}>
						<status value="warning" />
						<text color="warning">Cancelled</text>
					</row>
				</Show>
				<Show when={props.question.customInput !== undefined}>
					<stack>
						<row gap={1} pad={false}>
							<status value="success" />
							<text color="toolOutput">{customLines()[0] ?? ""}</text>
						</row>
						<For each={customLines().slice(1)}>
							{line => (
								<box padding={{ left: 2 }}>
									<text color="toolOutput">{line}</text>
								</box>
							)}
						</For>
					</stack>
				</Show>
				<Show when={props.question.note !== undefined}>
					<stack>
						<row gap={1} pad={false}>
							<text color="dim" wrap="none">
								Note:
							</text>
							<text color="toolOutput">{noteLines()[0] ?? ""}</text>
						</row>
						<For each={noteLines().slice(1)}>
							{line => (
								<box padding={{ left: 6 }}>
									<text color="toolOutput">{line}</text>
								</box>
							)}
						</For>
					</stack>
				</Show>
			</box>
			<Show when={props.question.timedOut}>
				<text color="dim">auto-selected after timeout — not a user choice</text>
			</Show>
		</stack>
	);
}

interface AskCallPresentation {
	readonly kind: "call";
	readonly questions: readonly QuestionItem[];
	readonly multipart: boolean;
}

interface AskAnswersPresentation {
	readonly kind: "answers";
	readonly questions: readonly QuestionItem[];
	readonly multipart: boolean;
}

interface AskRedirectPresentation {
	readonly kind: "redirect";
	readonly questions: readonly QuestionItem[];
}

interface AskFallbackPresentation {
	readonly kind: "fallback";
	readonly text: string;
}

interface AskInvalidPresentation {
	readonly kind: "invalid";
}

type AskPresentation =
	| AskCallPresentation
	| AskAnswersPresentation
	| AskRedirectPresentation
	| AskFallbackPresentation
	| AskInvalidPresentation;

/** Solid view for question prompts and user answers. */
export function AskView(props: ToolViewProps<AskRenderArgs, AskToolDetails>): JSX.Element {
	const presentation = createMemo<AskPresentation>(() => {
		props.output.version();
		const rawDetails = props.details;
		const output = sanitizeCarriageReturns(props.output.text());

		if (rawDetails !== undefined) {
			const details = sanitizeAskResultDetails(rawDetails);
			if (details.chatRedirect) {
				return {
					kind: "redirect",
					questions: (details.questions ?? []).map((question, index): QuestionItem => ({
						id: `q${index}`,
						question,
						options: [],
						multi: false,
						selectedOptions: [],
					})),
				};
			}
			if (details.results && details.results.length > 0) {
				return {
					kind: "answers",
					questions: details.results.map((result, index) =>
						questionFromResult(result, rawDetails.results?.[index]),
					),
					multipart: true,
				};
			}
			if (details.question) {
				return {
					kind: "answers",
					questions: [questionFromDetails(details, rawDetails)],
					multipart: false,
				};
			}
			return { kind: "fallback", text: output };
		}

		if (output || props.phase === "settled") return { kind: "fallback", text: output };

		const questions = normalizeRenderQuestions(props.args.questions);
		if (questions && questions.length > 0) {
			return {
				kind: "call",
				questions: questions.map((question): QuestionItem => ({
					id: question.id,
					question: question.question,
					options: question.options,
					multi: question.multi === true,
					selectedOptions: [],
				})),
				multipart: true,
			};
		}

		if (typeof props.args.question === "string" && props.args.question) {
			return {
				kind: "call",
				questions: [
					{
						id: "q0",
						question: sanitizeCarriageReturns(props.args.question),
						options: normalizeRenderOptions(props.args.options) ?? [],
						multi: props.args.multi === true,
						selectedOptions: [],
					},
				],
				multipart: false,
			};
		}
		return { kind: "invalid" };
	});

	const fallbackStatus = createMemo(() => statusFor(props.phase, props.outcome));
	const call = createMemo(() => {
		const current = presentation();
		return current.kind === "call" ? current : undefined;
	});
	const answers = createMemo(() => {
		const current = presentation();
		return current.kind === "answers" ? current : undefined;
	});
	const redirect = createMemo(() => {
		const current = presentation();
		return current.kind === "redirect" ? current : undefined;
	});
	const fallback = createMemo(() => {
		const current = presentation();
		return current.kind === "fallback" ? current : undefined;
	});
	const invalid = createMemo(() => presentation().kind === "invalid");

	return (
		<>
			<Show when={call()}>
				{(data: Accessor<AskCallPresentation>) => (
					<AskCard
						phase={props.phase}
						outcome={props.outcome}
						header={<AskCallHeader questions={data().questions} multipart={data().multipart} />}
					>
						<For each={data().questions}>
							{question => (
								<>
									<Show when={data().multipart}>
										<QuestionDivider question={question} metadata />
									</Show>
									<AskQuestion question={question} answer={false} />
								</>
							)}
						</For>
					</AskCard>
				)}
			</Show>
			<Show when={answers()}>
				{(data: Accessor<AskAnswersPresentation>) => {
					const answered = (): boolean => data().questions.some(hasAnswer);
					const autoTimedOut = (): boolean =>
						data().questions.some((question: QuestionItem) => question.timedOut === true);
					return (
						<AskCard
							phase={props.phase}
							outcome={props.outcome}
							tone={answered() ? "success" : "warning"}
							autoTimedOut={autoTimedOut()}
							header={
								<AskResultHeader
									phase={props.phase}
									outcome={props.outcome}
									multipart={data().multipart}
									questionCount={data().questions.length}
									answered={answered()}
									autoTimedOut={autoTimedOut()}
								/>
							}
						>
							<For each={data().questions}>
								{question => (
									<>
										<Show when={data().multipart}>
											<QuestionDivider question={question} metadata={false} />
										</Show>
										<AskQuestion question={question} answer />
									</>
								)}
							</For>
						</AskCard>
					);
				}}
			</Show>
			<Show when={redirect()}>
				{(data: Accessor<AskRedirectPresentation>) => (
					<AskCard phase={props.phase} outcome={props.outcome} tone="warning" header={<AskRedirectHeader />}>
						<For each={data().questions}>
							{question => <markdown document={createDocument(question.question)} options={{ paddingX: 1 }} />}
						</For>
					</AskCard>
				)}
			</Show>
			<Show when={invalid()}>
				<frame
					title={
						<text color="error" bold={false}>
							<status value="error" /> Error: No question provided
						</text>
					}
					titleInset={3}
					borderColor="error"
					backgroundBorder
					paddingX={1}
					paddingY={0}
					recipe={cardRecipe(props.phase, "failed")}
				/>
			</Show>
			<Show when={fallback()}>
				{(data: Accessor<AskFallbackPresentation>) => (
					<stack>
						<text>
							<status value={fallbackStatus() === "error" ? "warning" : fallbackStatus()} />{" "}
							<span color="accent">Ask</span>
						</text>
						<Show when={data().text}>
							<text color="dim">{data().text}</text>
						</Show>
					</stack>
				)}
			</Show>
		</>
	);
}

export function askSummary(props: ToolViewProps<AskRenderArgs, AskToolDetails>): ActivitySummary {
	const status = statusFor(props.phase, props.outcome);
	const results = props.details?.results;
	const questions = results ?? (props.details?.question === undefined ? [] : [props.details]);
	const answeredCount = questions.filter(
		question =>
			(question.selectedOptions?.length ?? 0) > 0 ||
			question.customInput !== undefined ||
			question.note !== undefined,
	).length;
	const detail =
		props.details?.chatRedirect === true
			? "chat redirect"
			: props.phase === "settled"
				? `${answeredCount} answered`
				: "asking question…";
	return {
		label: "Ask",
		detail,
		status,
	};
}

export const askToolView: ToolViewDefinition<AskRenderArgs, AskToolDetails> = {
	view: AskView,
	summary: askSummary,
	framed: true,
};

registerToolView("ask", askToolView);
