import { resolveUsedFraction, type ProviderDetails, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import "@oh-my-pi/pi-tui/host/intrinsics";
import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import { createMemo, For, Show, type JSX } from "@oh-my-pi/pi-tui/reactive";
import type { ToolUIStatus } from "@oh-my-pi/pi-tui/host/elements/status";
import type { ThemeColor } from "@oh-my-pi/pi-tui/theme";
import { formatProviderName } from "@oh-my-pi/pi-tui/chrome/format";
import { collapseSharedUsageReports, formatLimitTitle } from "@oh-my-pi/pi-tui/overlays/usage-display";
import { formatActiveAccountLabel, limitMatchesActiveAccount } from "../../slash-commands/helpers/active-oauth-account";
import { formatRemainingOnlyTotal, isUsedOnlyAbsoluteAmount } from "@oh-my-pi/pi-tui/prompt/usage-amounts";
import type { OAuthAccountIdentity } from "../../session/auth-storage";
import type { AsyncJobSnapshotItem } from "../../session/agent-session";
import type { AdvisorStats } from "../../session/session-advisors";
import type { SessionStats } from "../../session/agent-session-types";

function KeyValue(props: { readonly label: string; readonly value: string; readonly color?: ThemeColor }): JSX.Element {
	return (
		<text>
			<span color="dim">{props.label}: </span>
			<span color={props.color}>{props.value}</span>
		</text>
	);
}

function FeedbackSection(props: { readonly title: string; readonly children: JSX.Element }): JSX.Element {
	return (
		<stack gap={0}>
			<text bold>{props.title}</text>
			{props.children}
		</stack>
	);
}

export function SessionInfoView(props: {
	readonly stats: SessionStats;
	readonly providerDetails?: ProviderDetails;
	readonly routedModels: readonly { readonly id: string; readonly count: number }[];
	readonly appendOnly: { readonly active: boolean; readonly setting: string };
	readonly lspServers: readonly {
		readonly name: string;
		readonly status: string;
		readonly error?: string;
		readonly fileTypes: readonly string[];
	}[];
	readonly mcpServers: readonly { readonly name: string; readonly toolCount: number }[] | undefined;
}): JSX.Element {
	const stats = props.stats;
	const normalizedPremiumRequests = Math.round((stats.premiumRequests + Number.EPSILON) * 100) / 100;
	return (
		<stack gap={1}>
			<KeyValue label="File" value={stats.sessionFile ?? "In-memory"} />
			<KeyValue label="ID" value={stats.sessionId} />
			<FeedbackSection title="Provider">
				{props.providerDetails ? (
					<stack>
						<KeyValue label="Name" value={props.providerDetails.provider} />
						<For each={props.providerDetails.fields}>
							{field => <KeyValue label={field.label} value={field.value} />}
						</For>
						<Show when={props.routedModels.length > 0}>
							<text>
								<span color="dim">Served: </span>
								<For each={props.routedModels}>
									{(model, index) => (
										<>
											<Show when={index() > 0}>{", "}</Show>
											<span>{model.id}</span>
											<Show when={model.count > 1}>
												<span color="dim">{` ×${model.count}`}</span>
											</Show>
										</>
									)}
								</For>
							</text>
						</Show>
					</stack>
				) : (
					<text color="dim">No model selected</text>
				)}
			</FeedbackSection>
			<FeedbackSection title="Messages">
				<stack>
					<KeyValue label="User" value={String(stats.userMessages)} />
					<KeyValue label="Assistant" value={String(stats.assistantMessages)} />
					<KeyValue label="Tool Calls" value={String(stats.toolCalls)} />
					<KeyValue label="Tool Results" value={String(stats.toolResults)} />
					<KeyValue label="Total" value={String(stats.totalMessages)} />
				</stack>
			</FeedbackSection>
			<KeyValue
				label="Append-Only"
				value={`${props.appendOnly.active ? "active" : "inactive"} (setting: ${props.appendOnly.setting})`}
				color={props.appendOnly.active ? "success" : "dim"}
			/>
			<FeedbackSection title="Tokens">
				<stack>
					<KeyValue label="Input" value={stats.tokens.input.toLocaleString()} />
					<KeyValue label="Output" value={stats.tokens.output.toLocaleString()} />
					<Show when={stats.tokens.cacheRead > 0}>
						<KeyValue label="Cache Read" value={stats.tokens.cacheRead.toLocaleString()} />
					</Show>
					<Show when={stats.tokens.cacheWrite > 0}>
						<KeyValue label="Cache Write" value={stats.tokens.cacheWrite.toLocaleString()} />
					</Show>
					<KeyValue label="Total" value={stats.tokens.total.toLocaleString()} />
				</stack>
			</FeedbackSection>
			<Show when={stats.cost > 0 || normalizedPremiumRequests > 0 || stats.credits !== undefined}>
				<FeedbackSection title="Cost">
					<stack>
						<Show when={stats.cost > 0}>
							<KeyValue label="Total" value={stats.cost.toFixed(4)} />
						</Show>
						<Show when={normalizedPremiumRequests > 0}>
							<KeyValue label="Premium Requests" value={normalizedPremiumRequests.toLocaleString()} />
						</Show>
						{stats.credits ? (
							<>
								<KeyValue
									label="Credits"
									value={stats.credits.cost.toLocaleString(undefined, { maximumFractionDigits: 4 })}
								/>
								<KeyValue
									label="Committed Credits"
									value={stats.credits.committedCost.toLocaleString(undefined, { maximumFractionDigits: 4 })}
								/>
								<KeyValue
									label="Committed ACU"
									value={stats.credits.acuCost.toLocaleString(undefined, { maximumFractionDigits: 4 })}
								/>
							</>
						) : null}
					</stack>
				</FeedbackSection>
			</Show>
			<Show when={props.lspServers.length > 0}>
				<FeedbackSection title="LSP Servers">
					<stack>
						<For each={props.lspServers}>
							{server => (
								<KeyValue
									label={server.name}
									value={`${server.status === "error" && server.error ? `${server.status}: ${server.error}` : server.status} (${server.fileTypes.join(", ")})`}
									color={
										server.status === "ready"
											? "success"
											: server.status === "available"
												? "dim"
												: server.status === "connecting"
													? "warning"
													: "error"
									}
								/>
							)}
						</For>
					</stack>
				</FeedbackSection>
			</Show>
			{props.mcpServers ? (
				<FeedbackSection title="MCP Servers">
					{props.mcpServers.length > 0 ? (
						<stack>
							<For each={props.mcpServers}>
								{server => (
									<KeyValue
										label={server.name}
										value={`connected (${server.toolCount} tools)`}
										color="success"
									/>
								)}
							</For>
						</stack>
					) : (
						<text color="dim">None connected</text>
					)}
				</FeedbackSection>
			) : null}
		</stack>
	);
}

function advisorColor(status: string): ThemeColor {
	if (status === "running") return "success";
	if (status === "quota_exhausted" || status === "error") return "error";
	return "dim";
}

function advisorGlyph(status: string): string {
	if (status === "running") return "●";
	if (status === "paused" || status === "no_model") return "○";
	if (status === "quota_exhausted" || status === "error") return "✕";
	return "?";
}

function advisorLabel(status: string): string {
	if (status === "paused") return "off";
	if (status === "no_model") return "no model";
	return status;
}

export function AdvisorStatusView(props: {
	readonly stats: AdvisorStats;
	readonly quotas: ReadonlyMap<string, string>;
}): JSX.Element {
	const stats = props.stats;
	const roster = stats.advisors.length > 1 || !stats.active;
	const singleAdvisor = stats.advisors.length === 1 ? stats.advisors[0] : undefined;
	return (
		<stack gap={1}>
			<text bold>{roster ? `Advisor Status (${stats.advisors.length} advisors)` : "Advisor Status"}</text>
			{singleAdvisor ? (
				<text>
					<span color={advisorColor(singleAdvisor.status)}>{advisorGlyph(singleAdvisor.status)}</span>{" "}
					<span bold>{singleAdvisor.name}</span>{" "}
					<span color="dim">{`[${advisorLabel(singleAdvisor.status)}]`}</span>
				</text>
			) : null}
			<Show when={roster}>
				<For each={stats.advisors}>
					{advisor => (
						<stack gap={0}>
							<text>
								<span color={advisorColor(advisor.status)}>{advisorGlyph(advisor.status)}</span>{" "}
								<span bold>{advisor.name}</span> <span color="dim">{`[${advisorLabel(advisor.status)}]`}</span>
							</text>
							{advisor.model ? (
								<KeyValue label="Model" value={`${advisor.model.provider}/${advisor.model.id}`} />
							) : null}
							{props.quotas.get(advisor.name) ? <text color="dim">{props.quotas.get(advisor.name)}</text> : null}
							<Show when={advisor.status === "running" || advisor.status === "quota_exhausted"}>
								<stack>
									<KeyValue
										label="Context"
										value={
											advisor.contextWindow > 0
												? `${advisor.contextTokens.toLocaleString()} / ${advisor.contextWindow.toLocaleString()} (${Math.round((advisor.contextTokens / advisor.contextWindow) * 100)}%)`
												: advisor.contextTokens.toLocaleString()
										}
									/>
									<KeyValue label="Messages" value={advisor.messages.total.toLocaleString()} />
									<KeyValue
										label="Spend"
										value={`${advisor.tokens.input.toLocaleString()} in / ${advisor.tokens.output.toLocaleString()} out${advisor.cost > 0 ? `, $${advisor.cost.toFixed(4)}` : ""}`}
									/>
								</stack>
							</Show>
						</stack>
					)}
				</For>
			</Show>
			{!roster && stats.model ? (
				<FeedbackSection title="Provider">
					<KeyValue label="Model" value={`${stats.model.provider}/${stats.model.id}`} />
				</FeedbackSection>
			) : null}
			{!roster && singleAdvisor && props.quotas.get(singleAdvisor.name) ? (
				<FeedbackSection title="Quota">
					<text color="dim">{props.quotas.get(singleAdvisor.name)}</text>
				</FeedbackSection>
			) : null}
			<Show when={!roster}>
				<>
					<FeedbackSection title="Messages">
						<stack>
							<KeyValue label="User" value={stats.messages.user.toLocaleString()} />
							<KeyValue label="Assistant" value={stats.messages.assistant.toLocaleString()} />
							<KeyValue label="Total" value={stats.messages.total.toLocaleString()} />
						</stack>
					</FeedbackSection>
					<FeedbackSection title="Context">
						<KeyValue
							label="Tokens"
							value={
								stats.contextWindow > 0
									? `${stats.contextTokens.toLocaleString()} / ${stats.contextWindow.toLocaleString()} (${Math.round((stats.contextTokens / stats.contextWindow) * 100)}%)`
									: stats.contextTokens.toLocaleString()
							}
						/>
					</FeedbackSection>
					<FeedbackSection title="Spend">
						<stack>
							<KeyValue label="Input" value={stats.tokens.input.toLocaleString()} />
							<KeyValue label="Output" value={stats.tokens.output.toLocaleString()} />
							<Show when={stats.tokens.cacheRead > 0}>
								<KeyValue label="Cache Read" value={stats.tokens.cacheRead.toLocaleString()} />
							</Show>
							<Show when={stats.cost > 0}>
								<KeyValue label="Cost" value={`$${stats.cost.toFixed(4)}`} />
							</Show>
						</stack>
					</FeedbackSection>
				</>
			</Show>
			<Show when={roster && stats.active}>
				<FeedbackSection title="Totals">
					<stack>
						<KeyValue label="Tokens" value={stats.tokens.total.toLocaleString()} />
						<Show when={stats.cost > 0}>
							<KeyValue label="Cost" value={`$${stats.cost.toFixed(4)}`} />
						</Show>
					</stack>
				</FeedbackSection>
			</Show>
		</stack>
	);
}

function jobStatusColor(status: AsyncJobSnapshotItem["status"]): ThemeColor {
	if (status === "running") return "warning";
	if (status === "completed") return "success";
	if (status === "cancelled") return "dim";
	return "error";
}

function JobView(props: { readonly job: AsyncJobSnapshotItem; readonly now: number }): JSX.Element {
	return (
		<stack gap={0}>
			<text>
				<span color="dim">{props.job.id}</span> <span color="dim">{`[${props.job.type}]`}</span>{" "}
				<span color={jobStatusColor(props.job.status)}>{props.job.status}</span>{" "}
				<span color="dim">{`(${formatDuration(Math.max(0, props.now - props.job.startTime))})`}</span>
			</text>
			<text color="dim" wrap="word">{`  ${props.job.label}`}</text>
		</stack>
	);
}

export function JobsView(props: {
	readonly running: readonly AsyncJobSnapshotItem[];
	readonly recent: readonly AsyncJobSnapshotItem[];
	readonly now: number;
}): JSX.Element {
	return (
		<stack gap={1}>
			<text bold>Background Jobs</text>
			<KeyValue label="Running" value={String(props.running.length)} />
			<Show
				when={props.running.length > 0 || props.recent.length > 0}
				fallback={<text color="dim">No async jobs yet.</text>}
			>
				<Show when={props.running.length > 0}>
					<FeedbackSection title="Running Jobs">
						<For each={props.running}>{job => <JobView job={job} now={props.now} />}</For>
					</FeedbackSection>
				</Show>
				<Show when={props.recent.length > 0}>
					<FeedbackSection title="Recent Jobs">
						<For each={props.recent}>{job => <JobView job={job} now={props.now} />}</For>
					</FeedbackSection>
				</Show>
			</Show>
		</stack>
	);
}
function usageAccountLabel(report: UsageReport, index: number): string {
	const org =
		typeof report.metadata?.orgName === "string" && report.metadata.orgName
			? ` (${report.metadata.orgName})`
			: typeof report.metadata?.orgId === "string" && report.metadata.orgId
				? ` (${report.metadata.orgId})`
				: "";
	if (typeof report.metadata?.email === "string" && report.metadata.email) return `${report.metadata.email}${org}`;
	if (typeof report.metadata?.accountId === "string" && report.metadata.accountId)
		return `${report.metadata.accountId}${org}`;
	if (typeof report.metadata?.projectId === "string" && report.metadata.projectId) return report.metadata.projectId;
	return `account ${index + 1}`;
}

function usageAmount(limits: readonly UsageReport["limits"][number][]): string {
	const fractions = limits.map(resolveUsedFraction).filter((value): value is number => value !== undefined);
	if (fractions.length === limits.length && fractions.length > 0) {
		const used = fractions.reduce((sum, value) => sum + value, 0);
		return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(Math.max(0, ((limits.length - used) / limits.length) * 100))}% free`;
	}
	const capped = limits
		.map(limit => limit.amount)
		.filter(amount => amount.used !== undefined && amount.limit !== undefined && amount.limit > 0);
	if (capped.length === limits.length && capped.length > 0) {
		const used = capped.reduce((sum, amount) => sum + (amount.used ?? 0), 0);
		const total = capped.reduce((sum, amount) => sum + (amount.limit ?? 0), 0);
		return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(Math.max(0, 100 - (used / total) * 100))}% free`;
	}
	if (limits.every(isUsedOnlyAbsoluteAmount)) return "";
	return (
		formatRemainingOnlyTotal(limits) ??
		`${new Set(limits.map(limit => limit.scope.accountId).filter((id): id is string => !!id)).size || limits.length} accts`
	);
}

function usageStatus(limits: readonly UsageLimit[]): ToolUIStatus {
	if (limits.every(isUsedOnlyAbsoluteAmount)) return "info";
	if (limits.some(limit => limit.status === "ok"))
		return limits.some(limit => limit.status === "warning" || limit.status === "exhausted") ? "warning" : "success";
	if (limits.some(limit => limit.status === "warning")) return "warning";
	return limits.some(limit => limit.status === "exhausted") ? "error" : "pending";
}

interface UsageEntry {
	readonly report: UsageReport;
	readonly limit: UsageLimit;
	readonly account: string;
}

interface UsageGroup {
	readonly label: string;
	readonly window: string;
	readonly entries: UsageEntry[];
}

function groupUsage(reports: readonly UsageReport[]): UsageGroup[] {
	const ranked = reports.map((report, index) => ({
		report,
		index,
		used: report.limits.reduce((maximum, limit) => Math.max(maximum, resolveUsedFraction(limit) ?? -1), -1),
	}));
	ranked.sort((left, right) => right.used - left.used || left.index - right.index);
	const groups = new Map<string, UsageGroup>();
	for (const { report, index } of ranked) {
		for (const limit of report.limits) {
			const label = formatLimitTitle(limit);
			const window = limit.window?.label ?? limit.scope.windowId ?? "quota window";
			const key = `${label}|${limit.window?.id ?? limit.scope.windowId ?? "default"}`;
			let group = groups.get(key);
			if (!group) {
				group = { label, window, entries: [] };
				groups.set(key, group);
			}
			group.entries.push({ report, limit, account: usageAccountLabel(report, index) });
		}
	}
	return [...groups.values()];
}

function UsageMeter(props: { readonly limit: UsageLimit }): JSX.Element {
	const fraction = () => resolveUsedFraction(props.limit);
	const used = () =>
		props.limit.amount.unit === "usd"
			? `$${(props.limit.amount.used ?? 0).toFixed(2)}`
			: `${props.limit.amount.used ?? 0} ${props.limit.amount.unit}`;
	return (
		<Show
			when={!isUsedOnlyAbsoluteAmount(props.limit)}
			fallback={
				<text color="dim" wrap="none" overflow="ellipsis">
					{used()} used
				</text>
			}
		>
			<Show when={fraction() !== undefined} fallback={<text color="dim">—</text>}>
				<progress
					value={fraction() ?? 0}
					max={1}
					color={
						props.limit.status === "exhausted"
							? "error"
							: props.limit.status === "warning"
								? "warning"
								: "success"
					}
					emptyColor="dim"
					filled="█"
					empty="░"
				/>
			</Show>
		</Show>
	);
}

function UsageGroupView(props: {
	readonly group: UsageGroup;
	readonly now: number;
	readonly active?: OAuthAccountIdentity;
}): JSX.Element {
	const limits = createMemo(() => props.group.entries.map(entry => entry.limit));
	const amount = () => usageAmount(limits());
	const reset = () => (limits().length === 1 ? limits()[0]?.window : undefined);
	const notes = createMemo(() => [...new Set(limits().flatMap(limit => limit.notes ?? []))]);
	return (
		<stack>
			<text>
				<status value={usageStatus(limits())} /> {props.group.label}
				<Show
					when={
						props.group.window.toLowerCase() !== props.group.label.toLowerCase() &&
						props.group.window !== "quota window"
					}
				>
					{" "}
					({props.group.window})
				</Show>
			</text>
			<box padding={{ left: 2 }}>
				<row gap={1} align="end">
					<For each={props.group.entries}>
						{entry => (
							<stack grow={1} minWidth={0}>
								<text wrap="none" overflow="ellipsis" color="muted">
									{entry.account}
									{props.active && limitMatchesActiveAccount(entry.report, entry.limit, props.active)
										? " (active)"
										: ""}
								</text>
								<UsageMeter limit={entry.limit} />
							</stack>
						)}
					</For>
					<Show when={amount()}>
						<text shrink={0} color="dim" wrap="none">
							{amount()}
						</text>
					</Show>
				</row>
				<Show when={(reset()?.resetsAt ?? 0) > props.now}>
					<text color="dim">
						{reset()?.resetLabel ?? "resets"} in {formatDuration((reset()?.resetsAt ?? props.now) - props.now)}
					</text>
				</Show>
				<For each={notes()}>{note => <text color="dim">{sanitizeText(note)}</text>}</For>
			</box>
		</stack>
	);
}

function ResetCreditsView(props: {
	readonly reports: readonly UsageReport[];
	readonly now: number;
	readonly active?: OAuthAccountIdentity;
}): JSX.Element {
	const available = createMemo(() => props.reports.filter(report => (report.resetCredits?.availableCount ?? 0) > 0));
	return (
		<Show when={available().length > 0}>
			<text color="muted">Saved rate-limit resets (/usage reset to spend)</text>
			<box padding={{ left: 2 }}>
				<For each={available()}>
					{(report, index) => (
						<stack>
							<text>
								• {usageAccountLabel(report, index())}: {report.resetCredits?.availableCount} saved reset
								{report.resetCredits?.availableCount === 1 ? "" : "s"}
								{props.active &&
								report.limits.some(limit => limitMatchesActiveAccount(report, limit, props.active))
									? " (active)"
									: ""}
							</text>
							<For each={report.resetCredits?.credits ?? []}>
								{credit => {
									const expiry = () => (credit.expiresAt ? Date.parse(credit.expiresAt) : Number.NaN);
									return (
										<Show when={Number.isFinite(expiry())}>
											<text color="dim">
												{" "}
												{expiry() > props.now
													? `expires in ${formatDuration(expiry() - props.now)}`
													: "expired"}{" "}
												({credit.expiresAt?.slice(0, 10)})
											</text>
										</Show>
									);
								}}
							</For>
						</stack>
					)}
				</For>
			</box>
		</Show>
	);
}

/** Full retained usage report, including account pools, reset credits and native quota meters. */
export function UsageReportsView(props: {
	readonly reports: readonly UsageReport[];
	readonly now: number;
	readonly resolveActiveAccount?: (provider: string) => OAuthAccountIdentity | undefined;
	readonly usageModelSelectors?: readonly string[];
}): JSX.Element {
	const reports = createMemo(() => collapseSharedUsageReports([...props.reports]));
	const latest = () => Math.max(0, ...reports().map(report => report.fetchedAt ?? 0));
	const providers = createMemo(() => {
		const groups = new Map<string, UsageReport[]>();
		for (const report of reports()) {
			const entries = groups.get(report.provider);
			if (entries) entries.push(report);
			else groups.set(report.provider, [report]);
		}
		const used = (entries: readonly UsageReport[]) =>
			entries.flatMap(report => report.limits).reduce((sum, limit) => sum + (resolveUsedFraction(limit) ?? 0), 0);
		return [...groups].sort(
			([leftProvider, left], [rightProvider, right]) =>
				used(left) - used(right) || leftProvider.localeCompare(rightProvider),
		);
	});
	return (
		<stack gap={1}>
			<text bold>Usage{latest() ? ` (${formatDuration(props.now - latest())} ago)` : ""}</text>
			<For each={providers()}>
				{([provider, providerReports]) => {
					const active = () => props.resolveActiveAccount?.(provider);
					const activeLabel = () => formatActiveAccountLabel(active());
					const groups = groupUsage(providerReports);
					const notes = [...new Set(providerReports.flatMap(report => report.notes ?? []))];
					const selectors = () =>
						props.usageModelSelectors?.filter(selector => selector.startsWith(`${provider}/`)) ?? [];
					return (
						<stack>
							<text color="accent" bold>
								{formatProviderName(provider)}
							</text>
							<Show when={activeLabel()}>
								<text color="dim"> in use by this session: {activeLabel()}</text>
							</Show>
							<Show when={selectors().length > 0}>
								<text color="muted"> Models with usage data</text>
								<For each={selectors()}>{selector => <text color="dim"> {sanitizeText(selector)}</text>}</For>
							</Show>
							<For each={notes}>{note => <text color="dim"> {sanitizeText(note)}</text>}</For>
							<ResetCreditsView reports={providerReports} now={props.now} active={active()} />
							<For each={groups}>
								{group => <UsageGroupView group={group} now={props.now} active={active()} />}
							</For>
							<For each={providerReports}>
								{(report, index) => (
									<Show when={report.limits.length === 0}>
										<text color="dim">
											{usageAccountLabel(report, index())}
											{report.metadata?.planType ? ` (${report.metadata.planType})` : ""} — no limits
										</text>
									</Show>
								)}
							</For>
						</stack>
					);
				}}
			</For>
		</stack>
	);
}
