import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { formatNumber, getProjectDir } from "@oh-my-pi/pi-utils";
import { createEffect, createSignal, Show, type Accessor, type JSX, type Setter } from "../reactive";
import type { ThemeColor } from "../theme";
import { theme } from "../theme";
import { shortenPath } from "../render/render-utils";
import { sanitizeText as sanitizeStatusText } from "@oh-my-pi/pi-utils";
import { formatMetric } from "../components/metric";
import { formatBillingSummary } from "./metrics";
import { formatContextUsage, getContextUsageLevel, getContextUsageThemeColor } from "../chrome/context-thresholds";
import type { FooterHost, FooterSession } from "./host";

interface FooterPart {
	readonly text: string;
	readonly color: ThemeColor;
}

interface FooterSnapshot {
	readonly pwd: string;
	readonly parts: readonly FooterPart[];
	readonly thinking: string;
	readonly statuses: readonly string[];
}

export interface FooterSource {
	readonly revision: Accessor<number>;
	view(): JSX.Element;
}

export interface FooterViewProps {
	readonly source: FooterSource;
}

/** Declarative footer view backed by an ingested domain snapshot. */
export function FooterView(props: FooterViewProps): JSX.Element {
	const [revision, setRevision] = createSignal(-1);
	createEffect(() => setRevision(props.source.revision()));
	return (
		<Show when={revision()} keyed>
			{() => props.source.view()}
		</Show>
	);
}

/**
 * Domain source for the legacy footer. Session reads happen only in
 * `ingestSession`; the retained view consumes the resulting snapshot.
 */
export class FooterComponent implements FooterSource {
	readonly revision: Accessor<number>;
	#publishRevision: Setter<number>;
	#snapshot: FooterSnapshot;
	#branch: string | null | undefined;
	#branchResolve: AbortController | undefined;
	#branchGeneration = 0;
	#gitUnwatch: (() => void) | undefined;
	#disposed = false;
	#autoCompactEnabled = true;
	#extensionStatuses = new Map<string, string>();

	constructor(
		private readonly session: FooterSession,
		private readonly host: FooterHost,
	) {
		const [revision, publishRevision] = createSignal(0);
		this.revision = revision;
		this.#publishRevision = publishRevision;
		this.#snapshot = this.#readSessionSnapshot();
		this.#setupGitWatcher();
	}

	/** Ingest the latest session domain state for the declarative footer. */
	ingestSession(): void {
		if (this.#disposed) return;
		this.#snapshot = this.#readSessionSnapshot();
		this.#publish();
	}

	setAutoCompactEnabled(enabled: boolean): void {
		if (this.#autoCompactEnabled === enabled) return;
		this.#autoCompactEnabled = enabled;
		this.#snapshot = this.#readSessionSnapshot();
		this.#publish();
	}

	/** Set extension status text, or clear it with `undefined`. */
	setExtensionStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			if (!this.#extensionStatuses.delete(key)) return;
		} else {
			const sanitized = sanitizeStatusText(text);
			if (this.#extensionStatuses.get(key) === sanitized) return;
			this.#extensionStatuses.set(key, sanitized);
		}
		this.#snapshot = this.#readSessionSnapshot();
		this.#publish();
	}

	/** Refresh repository domain data after a cwd or VCS-head transition. */
	refreshGitSnapshot(): void {
		this.#branchGeneration++;
		this.#branchResolve?.abort();
		this.#branchResolve = undefined;
		this.#branch = undefined;
		this.#setupGitWatcher();
		this.#snapshot = this.#readSessionSnapshot();
		this.#publish();
	}

	#setupGitWatcher(): void {
		this.#gitUnwatch?.();
		this.#gitUnwatch = undefined;
		if (!this.host.gitEnabled() || this.#disposed) return;
		let repository;
		try {
			repository = vcs.repoForDisplay(getProjectDir());
		} catch {
			return;
		}
		if (!repository) return;
		try {
			this.#gitUnwatch = vcs.watch(repository, () => this.refreshGitSnapshot());
		} catch {
			// The footer remains usable without a VCS watcher.
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#branchResolve?.abort();
		this.#branchResolve = undefined;
		this.#gitUnwatch?.();
		this.#gitUnwatch = undefined;
		this.#extensionStatuses.clear();
	}

	#resolveBranch(): void {
		if (!this.host.gitEnabled() || this.#branch !== undefined) return;
		let repository;
		try {
			repository = vcs.repoForDisplay(getProjectDir());
		} catch {
			repository = null;
		}
		if (!repository) {
			this.#branch = null;
			return;
		}
		const git = repository.asGit();
		if (git) {
			try {
				const head = git.headSync();
				this.#branch =
					head === null ? null : head.kind === "ref" ? (head.branch ?? head.refName ?? "HEAD") : "detached";
			} catch {
				this.#branch = null;
			}
			return;
		}
		if (this.#branchResolve) return;
		const request = new AbortController();
		const generation = this.#branchGeneration;
		this.#branchResolve = request;
		void repository
			.label(request.signal)
			.then(label => {
				if (this.#disposed || this.#branchGeneration !== generation) return;
				this.#branch = typeof label === "string" ? sanitizeStatusText(label) : null;
				this.#snapshot = this.#readSessionSnapshot();
				this.#publish();
			})
			.catch(() => {
				if (this.#disposed || this.#branchGeneration !== generation) return;
				this.#branch = null;
				this.#snapshot = this.#readSessionSnapshot();
				this.#publish();
			})
			.finally(() => {
				if (this.#branchResolve === request) this.#branchResolve = undefined;
			});
	}

	#readSessionSnapshot(): FooterSnapshot {
		const state = this.session.state;
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let cost = 0;
		let premiumRequests = 0;
		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
			input += entry.message.usage.input;
			output += entry.message.usage.output;
			cacheRead += entry.message.usage.cacheRead;
			cacheWrite += entry.message.usage.cacheWrite;
			cost += entry.message.usage.cost.total;
			premiumRequests += entry.message.usage.premiumRequests ?? 0;
		}
		const parts: FooterPart[] = [];
		for (const [glyph, amount] of [
			["↑", input],
			["↓", output],
			["R", cacheRead],
			["W", cacheWrite],
		] as const) {
			const text = formatMetric({ leading: glyph, separator: "", value: amount ? formatNumber(amount) : undefined });
			if (text) parts.push({ text, color: "dim" });
		}
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		const billing = formatBillingSummary({ cost, usingSubscription, premiumRequests, fractionDigits: 3 }, theme);
		if (billing) parts.push({ text: billing, color: "dim" });
		const context = this.session.getContextUsage();
		const window = context?.contextWindow ?? state.model?.contextWindow ?? 0;
		const tokens = context?.tokens ?? 0;
		const percent = window > 0 ? (context?.percent ?? 0) : null;
		const auto = this.#autoCompactEnabled && theme.icon.auto ? ` ${theme.icon.auto}` : "";
		parts.push({
			text: `${formatContextUsage(percent, window, tokens)}${auto}`,
			color: context && percent !== null ? getContextUsageThemeColor(getContextUsageLevel(percent, window)) : "dim",
		});
		const model = state.model?.id || "no-model";
		const thinking = !state.model?.thinking
			? model
			: this.session.isAutoThinking
				? `${model} • ${this.session.autoResolvedThinkingLevel() || `${theme.thinking.autoPending} auto`}`
				: `${model} • ${state.thinkingLevel ?? ThinkingLevel.Off}`;
		let pwd = shortenPath(getProjectDir());
		this.#resolveBranch();
		if (this.#branch) pwd = `${pwd} (${this.#branch})`;
		const statuses = [...this.#extensionStatuses.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, status]) => status);
		return { pwd, parts, thinking, statuses };
	}

	#publish(): void {
		this.#publishRevision(revision => revision + 1);
	}

	view(): JSX.Element {
		const snapshot = this.#snapshot;
		return (
			<stack>
				<text wrap="clip" color="dim">
					{snapshot.pwd}
				</text>
				<row>
					<text shrink={1} wrap="none" overflow="ellipsis">
						{snapshot.parts.map((part, index) => (
							<span key={part.text} color={part.color}>
								{index > 0 ? " " : ""}
								{part.text}
							</span>
						))}
					</text>
					<text grow={1} wrap="none" />
					<text shrink={1} wrap="none" overflow="ellipsis" color="dim">
						{snapshot.thinking}
					</text>
				</row>
				{snapshot.statuses.map((status, index) => (
					<text key={index} wrap="clip">
						{status}
					</text>
				))}
			</stack>
		);
	}
}
