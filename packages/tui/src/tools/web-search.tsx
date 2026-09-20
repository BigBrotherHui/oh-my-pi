import { createDocument } from "../document/document";
import { createEffect, createMemo, createSignal, For, Show, type JSX } from "../reactive";
import { formatAge, formatCount, formatMoreItems, PREVIEW_LIMITS, replaceTabs } from "../render/render-utils";
import { useTheme } from "../theme/reactive";
import { ExpandHint } from "../view/expand-hint";
import { ToolCard } from "../view/tool-card";
import { ToolHeader } from "../view/tool-header";
import { UrlResultView } from "../view/url-result";
import type { ToolUIStatus } from "../host/elements/status";

import { registerToolView } from "./registry";
import type { ActivitySummary, CallOutcome, CallPhase, ToolViewDefinition, ToolViewProps } from "./view";

const MAX_COLLAPSED_ITEMS = PREVIEW_LIMITS.COLLAPSED_ITEMS;
const FALLBACK_PREVIEW_LINES = 6;

/** Search response and optional failure shown in the transcript. */
export interface SearchRenderDetails {
	response: SearchResponse;
	error?: string;
}

export interface WebSearchArgs {
	query?: string;
	maxAnswerLines?: number;
	[key: string]: unknown;
}

function isAborted(outcome: CallOutcome | undefined): boolean {
	return outcome === "cancelled" || outcome === "skipped";
}

function isError(outcome: CallOutcome | undefined, details: { readonly error?: string } | undefined): boolean {
	return !isAborted(outcome) && (outcome === "failed" || outcome === "timed_out" || details?.error !== undefined);
}

function activeStatus(_phase: CallPhase): ToolUIStatus {
	return "pending";
}

function searchStatus(
	phase: CallPhase,
	outcome: CallOutcome | undefined,
	details: { readonly error?: string } | undefined,
	sourceCount: number | undefined,
): ToolUIStatus {
	if (isAborted(outcome)) return "aborted";
	if (isError(outcome, details)) return "error";
	if (phase !== "settled") return activeStatus(phase);
	return sourceCount === 0 || sourceCount === undefined ? "warning" : "success";
}

export function SearchSourceView(props: {
	readonly source: Readonly<SearchSource>;
	readonly prefix?: () => string | undefined;
}): JSX.Element {
	const title = createMemo(() => {
		const source = props.source;
		if (typeof source.title === "string" && source.title.trim()) return source.title;
		if (typeof source.url === "string" && source.url.trim()) return source.url;
		return "Untitled";
	});
	const url = createMemo(() => (typeof props.source.url === "string" ? props.source.url : ""));
	const age = createMemo(() => {
		const formatted = formatAge(props.source.ageSeconds);
		return formatted || (typeof props.source.publishedDate === "string" ? props.source.publishedDate : "");
	});
	return <UrlResultView href={() => url() || undefined} title={title} metadata={age} prefix={props.prefix} />;
}

export function WebSearchView(props: ToolViewProps<WebSearchArgs, SearchRenderDetails>): JSX.Element {
	const { theme } = useTheme();
	const outputText = createMemo(() => {
		props.output.version();
		return props.output.text();
	});
	const response = createMemo(() => props.details?.response);
	const sources = createMemo(() => {
		const value = response()?.sources;
		return Array.isArray(value) ? value : [];
	});
	const sourceCount = createMemo(() => sources().length);
	const visibleSources = createMemo(() => (props.ui.expanded ? sources() : sources().slice(0, MAX_COLLAPSED_ITEMS)));
	const hiddenSources = createMemo(() => Math.max(0, sourceCount() - visibleSources().length));
	const queryFromArgs = createMemo(() => {
		const query = props.args.query;
		return typeof query === "string" && query.length > 0 ? query : undefined;
	});
	const queryPreview = createMemo(() => {
		const query = queryFromArgs();
		if (query) return query;
		const queries = response()?.searchQueries;
		if (!Array.isArray(queries)) return undefined;
		const first = queries.find(item => typeof item === "string");
		return first;
	});
	const providerLabel = createMemo(() => {
		const provider = response()?.provider;
		if (provider === undefined) return undefined;
		return provider === "none" ? "None" : getSearchProviderLabel(provider);
	});
	const aborted = createMemo(() => isAborted(props.outcome));
	const failed = createMemo(() => isError(props.outcome, props.details));
	const resultVisible = createMemo(
		() => props.hasResult || response() !== undefined || outputText().length > 0 || props.phase === "settled",
	);
	const presentation = createMemo<"call" | "fallback" | "result" | "error" | "aborted">(() => {
		if (aborted()) return "aborted";
		if (failed()) return "error";
		if (!resultVisible()) return "call";
		return response() === undefined ? "fallback" : "result";
	});
	const callHeader = createMemo(() => (
		<ToolHeader
			status={presentation() === "aborted" ? "aborted" : activeStatus(props.phase)}
			label={
				<>
					<span color="accent">Web Search</span>
					<Show when={queryFromArgs()}>
						<span>: </span>
						<span color="muted">{queryFromArgs()}</span>
					</Show>
				</>
			}
		/>
	));
	const resultStatus = createMemo<ToolUIStatus | undefined>(() => {
		if (props.phase !== "settled") return activeStatus(props.phase);
		return sourceCount() === 0 ? "warning" : undefined;
	});
	const resultHeader = createMemo(() => (
		<ToolHeader
			status={resultStatus()}
			label={
				<>
					<Show when={resultStatus() === undefined}>
						<span color="accent">
							<icon name="tool.webSearch" />
						</span>{" "}
					</Show>
					<span color="accent">Web Search</span>
					<Show when={providerLabel()}>
						<span>: </span>
						<span color="muted">{providerLabel()}</span>
					</Show>
				</>
			}
			meta={<span>{formatCount("source", sourceCount())}</span>}
		/>
	));
	const errorProviderLabel = createMemo(() => (response()?.provider === "none" ? undefined : providerLabel()));
	const errorHeader = createMemo(() => (
		<ToolHeader
			status="error"
			label={
				<>
					<span color="accent">Web Search</span>
					<Show when={errorProviderLabel()}>
						<span>: </span>
						<span color="muted">{errorProviderLabel()}</span>
					</Show>
				</>
			}
		/>
	));
	const contentText = createMemo(() => {
		const answer = response()?.answer;
		if (typeof answer === "string" && answer.trim().length > 0) return answer.trim();
		return outputText().trim();
	});
	const fallbackPreview = createMemo(() => {
		const lines = outputText()
			.trim()
			.split("\n")
			.filter(line => line.trim().length > 0);
		const shown = props.ui.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		return {
			lines: shown.map(line => line.trim()),
			hidden: lines.length - shown.length,
		};
	});
	const maxAnswerLines = createMemo(() => {
		const limit = props.args.maxAnswerLines;
		if (typeof limit !== "number" || !Number.isFinite(limit)) return undefined;
		const normalized = Math.floor(limit);
		return normalized > 0 ? normalized : undefined;
	});
	const capAnswer = createMemo(() => maxAnswerLines() !== undefined && !props.ui.expanded);
	const answerDocument = createDocument(contentText());
	createEffect(() => {
		const next = contentText();
		if (answerDocument.text() !== next) answerDocument.apply({ kind: "reset", text: next });
	});
	const [answerRows, setAnswerRows] = createSignal(0);
	const recordAnswerRows = (state: { readonly totalRows: number }): void => {
		setAnswerRows(previous => (previous === state.totalRows ? previous : state.totalRows));
	};
	const providerInfo = createMemo(() => {
		const provider = providerLabel() ?? "None";
		const responseValue = response();
		const auth = responseValue?.authMode;
		const authShort = auth === "oauth" ? "OAuth" : auth === "api_key" ? "API" : auth;
		let info = responseValue?.model ? `${responseValue.model} @ ${provider}` : provider;
		if (authShort) info += ` (${authShort})`;
		return info;
	});
	const usageParts = createMemo(() => {
		const usage = response()?.usage;
		if (!usage) return [];
		const parts: string[] = [];
		if (usage.inputTokens !== undefined) parts.push(`in ${usage.inputTokens}`);
		if (usage.outputTokens !== undefined) parts.push(`out ${usage.outputTokens}`);
		if (usage.totalTokens !== undefined) parts.push(`total ${usage.totalTokens}`);
		if (usage.searchRequests !== undefined) parts.push(`search ${usage.searchRequests}`);
		return parts;
	});
	const errorMessage = createMemo(() => props.details?.error || outputText() || "Unknown error");

	const fallbackContent = (
		<stack>
			<row gap={1}>
				<status value="warning" />
				<row gap={0}>
					<text color="dim">Response</text>
					<Show when={fallbackPreview().hidden > 0}>
						<ExpandHint expanded={props.ui.expanded} hasMore />
					</Show>
				</row>
			</row>
			<tree guides={true}>
				<Show when={fallbackPreview().lines.length > 0} fallback={<text color="muted">No response data</text>}>
					<For each={fallbackPreview().lines}>{line => <text color="dim">{line}</text>}</For>
					<Show when={fallbackPreview().hidden > 0}>
						<text color="muted">{formatMoreItems(fallbackPreview().hidden, "line")}</text>
					</Show>
				</Show>
			</tree>
		</stack>
	);

	return (
		<Show
			when={presentation() === "call" || presentation() === "aborted"}
			fallback={
				<Show
					when={presentation() === "error"}
					fallback={
						<Show
							when={presentation() === "fallback"}
							fallback={
								<ToolCard
									phase={props.phase}
									outcome={props.outcome}
									framed={true}
									expanded={true}
									header={resultHeader()}
									recipe={resultStatus() === "warning" ? "tool.card.queued" : undefined}
								>
									<Show when={queryPreview()}>
										<text>
											<span color="muted">Query:</span> {queryPreview()}
										</text>
									</Show>

									<hr variant="frame" label="Answer" />
									<Show
										when={contentText().length > 0}
										fallback={<text color="muted">No answer text returned</text>}
									>
										<Show
											when={capAnswer()}
											fallback={<markdown document={answerDocument} options={{ paddingX: 0 }} />}
										>
											<stack>
												<scroll
													height={maxAnswerLines() ?? 0}
													scrollbar={false}
													shrinkToFit
													onViewport={recordAnswerRows}
												>
													<markdown document={answerDocument} options={{ paddingX: 0 }} />
												</scroll>
												<Show when={answerRows() > (maxAnswerLines() ?? 0)}>
													<text color="muted">
														{formatMoreItems(answerRows() - (maxAnswerLines() ?? 0), "line")}
													</text>
												</Show>
											</stack>
										</Show>
									</Show>

									<hr variant="frame" label="Sources" />
									<Show when={sourceCount() > 0} fallback={<text color="muted">No sources returned</text>}>
										<stack>
											<For each={visibleSources()}>
												{(source, index) => (
													<SearchSourceView
														source={source}
														prefix={() =>
															index() === visibleSources().length - 1 && hiddenSources() === 0
																? theme().tree.last
																: theme().tree.branch
														}
													/>
												)}
											</For>
											<Show when={hiddenSources() > 0}>
												<text color="muted">
													{theme().tree.last} {formatMoreItems(hiddenSources(), "source")}
												</text>
											</Show>
										</stack>
									</Show>

									<hr variant="frame" label="Metadata" />
									<stack>
										<text>
											<span color="muted">Provider:</span> {providerInfo()}
										</text>
										<Show when={usageParts().length > 0}>
											<text>
												<span color="muted">Usage:</span> {usageParts().join(theme().sep.dot)}
											</text>
										</Show>
									</stack>
								</ToolCard>
							}
						>
							{fallbackContent}
						</Show>
					}
				>
					<ToolCard
						phase={props.phase}
						outcome={props.outcome}
						framed={true}
						expanded={true}
						header={errorHeader()}
						recipe="tool.card.error"
					>
						<text color="error">Error: {replaceTabs(errorMessage())}</text>
					</ToolCard>
				</Show>
			}
		>
			{callHeader()}
		</Show>
	);
}

export function webSearchActivitySummary(props: ToolViewProps<WebSearchArgs, SearchRenderDetails>): ActivitySummary {
	const query = props.args.query;
	const sources = props.details?.response?.sources;
	const count = Array.isArray(sources) ? sources.length : undefined;
	const detail = count === undefined ? undefined : formatCount("source", count);
	return {
		label: typeof query === "string" && query.length > 0 ? `Web Search ${query}` : "Web Search",
		detail,
		status: searchStatus(props.phase, props.outcome, props.details, count),
	};
}

export const webSearchToolView: ToolViewDefinition<WebSearchArgs, SearchRenderDetails> = {
	view: WebSearchView,
	summary: webSearchActivitySummary,
	framed: true,
};

registerToolView("web_search", webSearchToolView);
registerToolView("web-search", webSearchToolView);

/**
 * Web Search Types
 * Unified types for web search responses across supported providers.
 */
export const SEARCH_PROVIDER_OPTIONS = [
	{
		value: "auto",
		label: "Auto",
		description: "Automatically uses the first configured web-search provider",
	},
	{
		value: "parallel",
		label: "Parallel",
		description: "Uses API auth when configured; otherwise searches through the keyless public MCP",
	},
	{
		value: "perplexity",
		label: "Perplexity",
		description: "Uses auth when configured; explicit selection falls back to anonymous search",
	},
	{
		value: "gemini",
		label: "Gemini",
		description: "Google Search grounding via Gemini (uses google-gemini-cli or google-antigravity OAuth)",
	},
	{
		value: "anthropic",
		label: "Anthropic",
		description: "Claude's native web_search tool (uses Anthropic OAuth or ANTHROPIC_API_KEY)",
	},
	{
		value: "codex",
		label: "OpenAI",
		description: "OpenAI's native web_search (uses ChatGPT OAuth via /login openai-codex)",
	},
	{
		value: "xai",
		label: "xAI",
		description:
			"Grok web search via xAI Responses API (uses SuperGrok/X Premium+ OAuth via /login xai-oauth, or XAI_API_KEY)",
	},
	{
		value: "openrouter",
		label: "OpenRouter",
		description: "OpenRouter web-plugin grounding using the selected model's configured credentials",
	},
	{ value: "zai", label: "Z.AI", description: "Calls Z.AI webSearchPrime MCP" },
	{ value: "exa", label: "Exa", description: "API via /login exa or EXA_API_KEY; explicit keyless fallback via MCP" },
	{ value: "tinyfish", label: "TinyFish", description: "Requires TINYFISH_API_KEY" },
	{ value: "jina", label: "Jina", description: "Requires JINA_API_KEY" },
	{ value: "kagi", label: "Kagi", description: "Requires KAGI_API_KEY and Kagi Search API beta access" },
	{ value: "tavily", label: "Tavily", description: "Requires TAVILY_API_KEY" },
	{
		value: "firecrawl",
		label: "Firecrawl",
		description: "Uses Firecrawl API when FIRECRAWL_API_KEY is set; falls back to keyless mode",
	},
	{ value: "brave", label: "Brave", description: "Requires BRAVE_API_KEY" },
	{
		value: "kimi",
		label: "Kimi",
		description:
			"Kimi Code search (requires a Kimi Code Console key via KIMI_SEARCH_API_KEY/MOONSHOT_SEARCH_API_KEY or /login kimi-code; not MOONSHOT_API_KEY)",
	},
	{ value: "synthetic", label: "Synthetic", description: "Requires SYNTHETIC_API_KEY" },
	{ value: "ollama", label: "Ollama", description: "Requires OLLAMA_CLOUD_API_KEY" },
	{ value: "searxng", label: "SearXNG", description: "Requires SEARXNG_ENDPOINT or searxng.endpoint" },
	{
		value: "startpage",
		label: "Startpage",
		description: "Credential-free scrape of Startpage (Google-backed) results; may be bot-challenged",
	},
	{
		value: "duckduckgo",
		label: "DuckDuckGo",
		description: "Credential-free best-effort fallback; may be bot-challenged on datacenter/shared-egress IPs",
	},
	{
		value: "ecosia",
		label: "Ecosia",
		description: "Credential-free browser-backed scrape of Ecosia (Google-backed) results",
	},
	{
		value: "google",
		label: "Google",
		description: "Credential-free browser-backed fallback; slower and may be bot-challenged",
	},
	{
		value: "mojeek",
		label: "Mojeek",
		description: "Credential-free browser-backed scrape of Mojeek's independent index",
	},
	{
		value: "public",
		label: "Public Web",
		description: "Queries every credential-free engine in parallel and consolidates deduplicated results",
	},
	{ value: "none", label: "None", description: "Disables web search" },
] as const;

export type SearchProviderId = Exclude<(typeof SEARCH_PROVIDER_OPTIONS)[number]["value"], "auto">;

export const SEARCH_PROVIDER_LABELS = Object.fromEntries(
	SEARCH_PROVIDER_OPTIONS.flatMap(option => (option.value === "auto" ? [] : [[option.value, option.label] as const])),
) as Record<SearchProviderId, string>;

export interface SearchSource {
	title: string;
	url: string;
	snippet?: string;
	/** ISO date string or relative ("2d ago") */
	publishedDate?: string;
	/** Age in seconds for consistent formatting */
	ageSeconds?: number;
	author?: string;
}

export interface SearchCitation {
	url: string;
	title: string;
	citedText?: string;
}

export interface SearchUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	searchRequests?: number;
}

export interface SearchResponse {
	provider: SearchProviderId;
	/** Synthesized answer text (LLM-mediated providers) */
	answer?: string;
	/** Search result sources */
	sources: SearchSource[];
	/** Text citations with context */
	citations?: SearchCitation[];
	/** Intermediate search queries */
	searchQueries?: string[];
	/** Follow-up question suggestions (provider-dependent) */
	relatedQuestions?: string[];
	/** Token usage metrics */
	usage?: SearchUsage;
	/** Model used */
	model?: string;
	/** Request ID for debugging */
	requestId?: string;
	/** Authentication mode used by the provider (e.g. oauth, api_key) */
	authMode?: string;
}

export function getSearchProviderLabel(id: SearchProviderId): string {
	return SEARCH_PROVIDER_LABELS[id] ?? id;
}
