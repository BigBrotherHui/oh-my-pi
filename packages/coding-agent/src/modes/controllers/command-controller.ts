import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CompactionCancelledError, type CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import { getEnvApiKey, getProviderDetails, type UsageReport } from "@oh-my-pi/pi-ai";
import { createSignal } from "@oh-my-pi/pi-tui/reactive";
import { logger, Snowflake, sanitizeText } from "@oh-my-pi/pi-utils";
import { shouldEnableAppendOnlyContext } from "../../config/append-only-context-mode";
import { type BashResult, isPersistentShellCdCommand } from "../../exec/bash-executor";
import { type LoadedCustomShare, loadCustomShare } from "../../export/custom-share";
import { parseExportArgs } from "../../export/html/args";
import { shareSession } from "../../export/share";
import type { CompactOptions } from "../../extensibility/extensions/types";
import {
	diffMentalModelContent,
	type HindsightApi,
	type HindsightSessionState,
	loadHindsightConfig,
	reloadMentalModelsForSession,
	resolveSeedsForScope,
	seedAlreadyExists,
	summarizeMentalModel,
} from "../../hindsight";
import { memoryStatsUnavailableMessage, resolveMemoryBackend } from "../../memory-backend";
import { BashExecutionStream, BashExecutionView } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { openBorderedLoader } from "@oh-my-pi/pi-tui/overlays/bordered-loader";
import type { OverlayDisposer } from "@oh-my-pi/pi-tui/host/overlay";
import { EvalExecutionView } from "@oh-my-pi/pi-tui/chat/eval-execution";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { outputMeta } from "../../tools/output-meta";
import { openMoveOverlay, type MoveOverlayResult } from "@oh-my-pi/pi-tui/overlays/move-overlay";
import { moveDirectorySource } from "../move-directory-source";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext, PendingExecution } from "../../modes/types";
import { renderContextUsage } from "@oh-my-pi/pi-tui/status-line/context-usage";
import {
	BusyView,
	CommandMarkdownPanelView,
	CommandNoticeView,
	CommandPanelView,
} from "../components/reactive-controller-views";
import { AdvisorStatusView, JobsView, SessionInfoView } from "../components/command-feedback-views";
import { computeSessionContextBreakdown } from "../../session/context-usage-runtime";
import { buildHotkeysMarkdown } from "@oh-my-pi/pi-tui/hotkeys-markdown";
import { buildToolsMarkdown } from "@oh-my-pi/pi-tui/prompt/tools-markdown";
import type { AuthStorage } from "../../session/auth-storage";
import type { CompactMode } from "../../session/compact-modes";
import type { NewSessionOptions } from "../../session/session-entries";
import {
	cleanSourceCheckoutIfConfigured,
	createSessionWorktree,
	defaultSessionWorktreeBranch,
	formatSessionWorktreeSummary,
	type SessionWorktree,
} from "../../session/session-worktree";
import { formatShakeSummary, type ShakeMode, type ShakeResult } from "../../session/shake-types";
import { limitMatchesActiveAccount } from "../../slash-commands/helpers/active-oauth-account";
import { formatCompactQuota } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { resolveToCwd, stripOuterDoubleQuotes } from "../../tools/path-utils";
import {
	getChangelogPath,
	parseChangelog,
	RECENT_CHANGELOG_ENTRY_LIMIT,
	renderChangelogEntries,
} from "../../utils/changelog";
import { copyToClipboard } from "../../utils/clipboard";
import { openPath } from "../../utils/open";
import { setSessionTerminalTitle } from "../../utils/title-generator";
import { collapseSharedUsageReports } from "@oh-my-pi/pi-tui/overlays/usage-display";

function showMarkdownPanel(ctx: InteractiveModeContext, title: string, markdown: string): void {
	ctx.presentCommandOutput(CommandMarkdownPanelView({ title, markdown }));
}

export class CommandController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	async #restoreAfterMoveFailure(
		previousState: Parameters<InteractiveModeContext["sessionManager"]["rollbackMove"]>[0],
		initialError?: unknown,
	): Promise<void> {
		if (initialError !== undefined) {
			this.ctx.showError(
				`Failed to switch workspace: ${initialError instanceof Error ? initialError.message : String(initialError)}`,
			);
		}

		try {
			await this.ctx.sessionManager.rollbackMove(previousState);
		} catch (rollbackError) {
			const actual = this.ctx.sessionManager.getCwd();
			let realigned = false;
			try {
				realigned = await this.ctx.applyCwdChange(actual);
			} catch {}
			if (!realigned) {
				this.ctx.showError(
					`Failed to roll back move: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)} (failed to re-align workspace to ${actual})`,
				);
				await this.ctx.shutdown();
				return;
			}
			this.ctx.showError(
				`Failed to roll back move: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)} (workspace remains at ${actual})`,
			);
			return;
		}

		let sourceRestored = false;
		try {
			sourceRestored = await this.ctx.applyCwdChange(previousState.cwd);
		} catch {}
		if (sourceRestored) return;

		const actual = this.ctx.sessionManager.getCwd();
		let realigned = false;
		try {
			realigned = await this.ctx.applyCwdChange(actual);
		} catch {}
		if (!realigned) {
			this.ctx.showError(`Failed to restore source workspace after rollback: workspace remains at ${actual}`);
			await this.ctx.shutdown();
			return;
		}
		this.ctx.showError(`Failed to restore source workspace after rollback: workspace remains at ${actual}`);
	}

	openInBrowser(urlOrPath: string): void {
		openPath(urlOrPath);
	}

	async handleExportCommand(text: string): Promise<void> {
		try {
			const { outputPath, useUserThemes } = parseExportArgs(text.slice("/export".length));
			if (outputPath === "--copy" || outputPath === "clipboard" || outputPath === "copy") {
				this.ctx.showWarning("Use /dump to copy the session to clipboard.");
				return;
			}

			const filePath = await this.ctx.session.exportToHtml(outputPath, useUserThemes);
			this.ctx.showStatus(`Session exported to: ${filePath}`);
			this.openInBrowser(filePath);
		} catch (error: unknown) {
			this.ctx.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}
	async handleTraceCommand(): Promise<void> {
		const sessionFile = this.ctx.session.sessionFile;
		if (!sessionFile) {
			this.ctx.showWarning("No session file yet — send a message first.");
			return;
		}
		try {
			// Lazy: the stats dashboard (server + sqlite) loads on demand only,
			// matching src/cli/stats-cli.ts, to keep CLI startup fast.
			const { formatStatsDashboardUrl, startServer } = await import("@oh-my-pi/omp-stats");
			const { hostname, port } = await startServer();
			const url = `${formatStatsDashboardUrl(hostname, port)}/#/traces?s=${encodeURIComponent(sessionFile)}`;
			this.openInBrowser(url);
			this.ctx.showStatus(`Trace: ${url}`);
		} catch (error: unknown) {
			this.ctx.showError(`Failed to open trace: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	async handleDumpCommand(): Promise<void> {
		try {
			const formatted = this.ctx.session.formatSessionAsText();
			if (!formatted) {
				this.ctx.showError("No messages to dump yet.");
				return;
			}
			// Build the LLM request JSON sidecar first so its path (and a
			// raw-context warning) can be appended to the copied transcript.
			let sidecarPath: string | undefined;
			let sidecarError: string | undefined;
			try {
				sidecarPath = await this.ctx.session.dumpLlmRequestToTmpDir();
			} catch (error: unknown) {
				sidecarError = error instanceof Error ? error.message : "Unknown error";
			}
			const doc = sidecarPath
				? `${formatted}\n\n---\nLLM request JSON: ${sidecarPath}\nThis file persists on disk and may contain raw context/secrets — treat accordingly.`
				: formatted;
			await copyToClipboard(doc);
			const statusParts = ["Session copied to clipboard"];
			if (sidecarPath) statusParts.push(`LLM request JSON: ${sidecarPath}`);
			if (sidecarError) statusParts.push(`LLM request JSON unavailable: ${sidecarError}`);
			this.ctx.showStatus(statusParts.join("\n"));
		} catch (error: unknown) {
			this.ctx.showError(`Failed to copy session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	handleAdvisorDumpCommand(isRaw = false) {
		try {
			const advisorHistory = this.ctx.session.formatAdvisorHistoryAsText({ compact: !isRaw });
			if (advisorHistory === null) {
				this.ctx.showError("Advisor is not active for this session.");
				return;
			}
			if (!advisorHistory) {
				this.ctx.showError("Advisor has no history yet.");
				return;
			}
			copyToClipboard(advisorHistory);
			this.ctx.showStatus("Advisor history copied to clipboard");
		} catch (error: unknown) {
			this.ctx.showError(
				`Failed to copy advisor history: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	async handleDebugTranscriptCommand(): Promise<void> {
		try {
			const rendered = this.ctx.chatContainer
				.entries()
				.map(entry => entry.id)
				.join("\n");
			if (!rendered) {
				this.ctx.showError("No messages to dump yet.");
				return;
			}
			const tmpPath = path.join(os.tmpdir(), `${Snowflake.next()}-tmp.txt`);
			await Bun.write(tmpPath, `${rendered}\n`);
			this.ctx.showStatus(`Debug transcript written to:\n${tmpPath}`);
		} catch (error: unknown) {
			this.ctx.showError(
				`Failed to write debug transcript: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	async handleShareCommand(): Promise<void> {
		let customShare: LoadedCustomShare | null;
		try {
			customShare = await loadCustomShare();
		} catch (err) {
			this.ctx.showError(err instanceof Error ? err.message : String(err));
			return;
		}

		let cancelled = false;
		const loader: OverlayDisposer = openBorderedLoader(this.ctx.ui, "Sharing session...", () => {
			cancelled = true;
			loader.dispose();
			this.ctx.showStatus("Share cancelled");
		});

		// Custom share scripts keep their legacy contract: they receive a path
		// to a standalone HTML export. No fallback to the default flow on error.
		if (customShare) {
			const tmpFile = path.join(os.tmpdir(), `${Snowflake.next()}.html`);
			try {
				await this.ctx.session.exportToHtml(tmpFile);
				const result = await customShare.fn(tmpFile);
				if (cancelled) return;
				loader.dispose();

				if (typeof result === "string") {
					this.ctx.showStatus(`Share URL: ${result}`);
					this.openInBrowser(result);
				} else if (result) {
					const parts: string[] = [];
					if (result.url) parts.push(`Share URL: ${result.url}`);
					if (result.message) parts.push(result.message);
					if (parts.length > 0) this.ctx.showStatus(parts.join("\n"));
					if (result.url) this.openInBrowser(result.url);
				} else {
					this.ctx.showStatus("Session shared");
				}
			} catch (err) {
				if (!cancelled) {
					loader.dispose();
					this.ctx.showError(`Custom share failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			} finally {
				await fs.rm(tmpFile, { force: true }).catch(() => {});
			}
			return;
		}

		// Default: encrypted snapshot to a secret gist (preferred) or the share
		// server; the key rides in the link fragment and never leaves the client.
		try {
			const result = await shareSession(this.ctx.session.sessionManager, {
				serverUrl: this.ctx.settings.get("share.serverUrl"),
				store: this.ctx.settings.get("share.store"),
				state: this.ctx.session.state,
				obfuscator: this.ctx.settings.get("share.redactSecrets") ? this.ctx.session.obfuscator : undefined,
			});
			if (cancelled) return;
			loader.dispose();

			const lines = [`Share URL: ${result.url}`];
			if (result.gistUrl) lines.push(`Gist: ${result.gistUrl}`);
			if (result.truncated) lines.push("Note: large content was trimmed to fit the share size limit.");
			this.ctx.showStatus(lines.join("\n"));
			this.openInBrowser(result.url);
		} catch (error: unknown) {
			if (!cancelled) {
				loader.dispose();
				this.ctx.showError(`Failed to share session: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		}
	}

	async handleSessionCommand(): Promise<void> {
		const stats = this.ctx.session.getSessionStats();
		const model = this.ctx.session.model;
		const providerDetails = model
			? getProviderDetails({
					model,
					sessionId: stats.sessionId,
					authMode: resolveProviderAuthMode(this.ctx.session.modelRegistry.authStorage, model.provider),
					credentialSource: this.ctx.session.modelRegistry.authStorage.describeCredentialSource(
						model.provider,
						stats.sessionId,
					),
					preferWebsockets: (() => {
						const setting = this.ctx.settings.get("providers.openaiWebsockets") ?? "auto";
						return setting === "on" ? true : setting === "off" ? false : undefined;
					})(),
					providerSessionState: this.ctx.session.providerSessionState,
				})
			: undefined;
		const appendOnlySetting = this.ctx.settings.get("provider.appendOnlyContext") ?? "auto";
		const appendOnly = shouldEnableAppendOnlyContext(appendOnlySetting, model);
		const mcpServers = this.ctx.mcpManager?.getConnectedServers().map(name => ({
			name,
			toolCount: this.ctx.mcpManager?.getConnection(name)?.tools?.length ?? 0,
		}));
		this.ctx.presentCommandOutput(
			SessionInfoView({
				stats,
				providerDetails,
				routedModels: Object.entries(stats.routedModels ?? {})
					.sort(([aId, aCount], [bId, bCount]) => bCount - aCount || aId.localeCompare(bId))
					.map(([id, count]) => ({ id: sanitizeText(id), count })),
				appendOnly: {
					active: appendOnly,
					setting:
						appendOnlySetting === "auto" ? `${appendOnlySetting} (${model?.provider ?? "?"})` : appendOnlySetting,
				},
				lspServers: this.ctx.lspServers ?? [],
				mcpServers,
			}),
		);
	}

	async handleAdvisorStatusCommand(): Promise<void> {
		const stats = this.ctx.session.getAdvisorStats();
		if (!stats.configured) {
			this.ctx.presentCommandOutput(CommandNoticeView({ text: "Advisor is disabled." }));
			return;
		}
		const usageProvider = this.ctx.session as { fetchUsageReports?: () => Promise<UsageReport[] | null> };
		let usageReports: UsageReport[] | null = null;
		if (usageProvider.fetchUsageReports) {
			try {
				usageReports = await usageProvider.fetchUsageReports();
			} catch {
				// Network/auth failure is non-fatal — just omit quota details.
			}
		}
		const now = Date.now();
		const quotas = new Map<string, string>();
		if (usageReports) {
			const collapsed = collapseSharedUsageReports(usageReports);
			for (const advisor of stats.advisors) {
				if (!advisor.model) continue;
				const identity = this.ctx.session.modelRegistry.authStorage.getOAuthAccountIdentity(
					advisor.model.provider,
					advisor.sessionId ?? this.ctx.session.sessionId,
				);
				const quota = formatCompactQuota(
					advisor.model.provider,
					collapsed,
					now,
					(report, limit) => !identity || limitMatchesActiveAccount(report, limit, identity),
				);
				if (quota) quotas.set(advisor.name, quota);
			}
		}
		this.ctx.presentCommandOutput(AdvisorStatusView({ stats, quotas }));
	}

	async handleJobsCommand(): Promise<void> {
		const snapshot = this.ctx.session.getAsyncJobSnapshot({ recentLimit: 5 });
		if (!snapshot) {
			this.ctx.showWarning("Async background jobs are unavailable in this session.");
			return;
		}
		this.ctx.presentCommandOutput(JobsView({ ...snapshot, now: Date.now() }));
	}

	async handleUsageCommand(reports?: UsageReport[] | null): Promise<void> {
		let usageReports = reports ?? null;
		if (!usageReports) {
			const provider = this.ctx.session as { fetchUsageReports?: () => Promise<UsageReport[] | null> };
			if (!provider.fetchUsageReports) {
				this.ctx.showWarning("Usage reporting is not configured for this session.");
				return;
			}
			try {
				usageReports = await provider.fetchUsageReports();
			} catch (error) {
				this.ctx.showError(`Failed to fetch usage data: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
		}

		if (!usageReports || usageReports.length === 0) {
			this.ctx.showWarning("No usage data available.");
			return;
		}

		this.ctx.showUsageDashboard(usageReports);
	}

	async handleChangelogCommand(showFull = false): Promise<void> {
		const changelogPath = getChangelogPath();
		const allEntries = await parseChangelog(changelogPath);
		const entriesToShow = showFull ? allEntries : allEntries.slice(0, RECENT_CHANGELOG_ENTRY_LIMIT);
		const changelogMarkdown =
			entriesToShow.length > 0 ? renderChangelogEntries(entriesToShow).markdown : "No changelog entries found.";
		const title = showFull ? "Full Changelog" : "Recent Changes";
		const hint = showFull ? "" : "\n\nUse `/changelog full` to view the complete changelog.";

		this.ctx.presentCommandOutput(CommandMarkdownPanelView({ title, markdown: changelogMarkdown + hint }));
	}

	handleHotkeysCommand(): void {
		const hotkeys = buildHotkeysMarkdown({ keybindings: this.ctx.keybindings });
		showMarkdownPanel(this.ctx, "Keyboard Shortcuts", hotkeys);
	}

	handleToolsCommand(): void {
		const tools = buildToolsMarkdown({
			tools: this.ctx.session.agent.state.tools,
			xdevTools: this.ctx.session.getXdevToolEntries(),
		});
		showMarkdownPanel(this.ctx, "Available Tools", tools);
	}

	handleContextCommand(): void {
		const breakdown = computeSessionContextBreakdown(this.ctx.session, { snapcompactSavings: true });
		if (breakdown.contextWindow <= 0) {
			this.ctx.showWarning("Context usage is unavailable: no model is selected for this session.");
			return;
		}
		this.ctx.presentCommandOutput(
			CommandPanelView({ title: "Context Usage", content: renderContextUsage(breakdown, theme) }),
		);
	}

	async handleMemoryCommand(text: string): Promise<void> {
		const argumentText = text.slice(7).trim();
		const action = argumentText.split(/\s+/, 1)[0]?.toLowerCase() || "view";
		const agentDir = this.ctx.settings.getAgentDir();
		const backend = await resolveMemoryBackend(this.ctx.settings);

		if (action === "view") {
			const payload = await backend.buildDeveloperInstructions(agentDir, this.ctx.settings, this.ctx.session);
			if (!payload) {
				this.ctx.showWarning("Memory payload is empty (memory backend off, disabled, or no memory available).");
				return;
			}
			this.ctx.presentCommandOutput(
				CommandMarkdownPanelView({ title: "Memory Injection Payload", markdown: payload }),
			);
			return;
		}

		if (action === "reset" || action === "clear") {
			try {
				await backend.clear(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				await this.ctx.session.refreshBaseSystemPrompt();
				this.ctx.showStatus("Memory data cleared and system prompt refreshed.");
			} catch (error) {
				this.ctx.showError(`Memory clear failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (action === "enqueue" || action === "rebuild") {
			try {
				await backend.enqueue(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				this.ctx.showStatus("Memory consolidation enqueued.");
			} catch (error) {
				this.ctx.showError(`Memory enqueue failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}
		if (action === "queue") {
			try {
				const payload = await backend.queuePreview?.({
					agentDir,
					cwd: this.ctx.sessionManager.getCwd(),
					session: this.ctx.session,
				});
				if (!payload) {
					this.ctx.showWarning(`Memory queue is not available for the ${backend.id} backend.`);
					return;
				}
				showMarkdownPanel(this.ctx, "Memory Queue", payload);
			} catch (error) {
				this.ctx.showError(`Memory queue failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (action === "sync") {
			try {
				await backend.enqueue(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				this.ctx.showStatus("Memory consolidation ran.");
			} catch (error) {
				this.ctx.showError(`Memory sync failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (action === "stats" || action === "diagnose") {
			const hook = action === "stats" ? backend.stats : backend.diagnose;
			try {
				const payload = await hook?.(agentDir, this.ctx.sessionManager.getCwd(), this.ctx.session);
				if (!payload) {
					this.ctx.showWarning(memoryStatsUnavailableMessage(backend.id, action));
					return;
				}
				showMarkdownPanel(this.ctx, `Memory ${action === "stats" ? "Stats" : "Diagnostics"}`, payload);
			} catch (error) {
				this.ctx.showError(`Memory ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (action === "mm") {
			await this.#handleMentalModelsSubcommand(argumentText);
			return;
		}

		this.ctx.showError("Usage: /memory <view|stats|diagnose|clear|reset|enqueue|rebuild|queue|sync|mm ...>");
	}

	async #handleMentalModelsSubcommand(argumentText: string): Promise<void> {
		// Parse: "mm <verb> [arg]"
		const parts = argumentText.split(/\s+/).slice(1);
		const verb = parts[0]?.toLowerCase() ?? "list";
		const arg = parts[1];

		const state = this.ctx.session.getHindsightSessionState();
		const primary = state && !state.aliasOf ? state : undefined;
		if (!primary) {
			this.ctx.showError("Hindsight backend is not active for this session.");
			return;
		}
		if (!primary.config.mentalModelsEnabled) {
			this.ctx.showError("Mental models are disabled (hindsight.mentalModelsEnabled = false).");
			return;
		}

		switch (verb) {
			case "list":
				await this.#mmList(primary);
				return;
			case "show":
				if (!arg) return this.ctx.showError("Usage: /memory mm show <id>");
				await this.#mmShow(primary, arg);
				return;
			case "refresh":
				await this.#mmRefresh(primary, arg);
				return;
			case "history":
				if (!arg) return this.ctx.showError("Usage: /memory mm history <id>");
				await this.#mmHistory(primary, arg);
				return;
			case "seed":
				await this.#mmSeed(primary);
				return;
			case "reload":
				await this.#mmReload(primary);
				return;
			case "delete":
			case "remove":
				if (!arg) return this.ctx.showError("Usage: /memory mm delete <id>");
				await this.#mmDelete(primary, arg);
				return;
			default:
				this.ctx.showError("Usage: /memory mm <list|show|refresh|history|seed|reload|delete>");
		}
	}

	async #mmList(state: HindsightSessionState): Promise<void> {
		const client: HindsightApi = state.client;
		try {
			const response = await client.listMentalModels(state.bankId, { detail: "metadata" });
			const items = response.items ?? [];
			if (items.length === 0) {
				this.ctx.showStatus(`No mental models on bank ${state.bankId}.`);
				return;
			}
			const lines = items
				.slice()
				.sort((a, b) => a.id.localeCompare(b.id))
				.map(summarizeMentalModel);
			showMarkdownPanel(this.ctx, `Mental Models — ${state.bankId}`, lines.join("\n"));
		} catch (error) {
			this.ctx.showError(`mm list failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmShow(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const model = await state.client.getMentalModel(state.bankId, id, { detail: "content" });
			if (!model) {
				this.ctx.showError(`Mental model not found: ${id}`);
				return;
			}
			const tags = model.tags && model.tags.length > 0 ? `\n_tags: ${model.tags.join(", ")}_` : "";
			const refreshed = model.last_refreshed_at ? `\n_last refreshed: ${model.last_refreshed_at}_` : "";
			const sourceQuery = model.source_query ? `\n\n**Source query:** ${model.source_query}` : "";
			const content = (model.content ?? "_(empty — background reflect may still be running)_").trim();
			showMarkdownPanel(
				this.ctx,
				model.name,
				`**id:** \`${model.id}\`${tags}${refreshed}${sourceQuery}\n\n${content}`,
			);
		} catch (error) {
			this.ctx.showError(`mm show failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmRefresh(state: HindsightSessionState, id: string | undefined): Promise<void> {
		try {
			if (id) {
				// Single-model refresh is explicit operator intent: bypass the
				// auto-refresh filter so curated/manual models can still be
				// refreshed on demand.
				await state.client.refreshMentalModel(state.bankId, id);
				this.ctx.showStatus(`Refresh queued for mental model ${id}.`);
			} else {
				// Bulk refresh: only touch models that opted into automatic
				// refresh via `trigger.refresh_after_consolidation`. Curated
				// models are reviewed before publishing and must not be
				// silently regenerated by a bank-wide refresh sweep. Reading
				// `detail: "content"` here is required because the trigger
				// field is excluded from `detail: "metadata"`.
				const list = await state.client.listMentalModels(state.bankId, { detail: "content" });
				const items = list.items ?? [];
				if (items.length === 0) {
					this.ctx.showStatus(`No mental models on bank ${state.bankId}.`);
					return;
				}
				const targets = items.filter(m => m.trigger?.refresh_after_consolidation === true);
				const skipped = items.length - targets.length;
				if (targets.length === 0) {
					this.ctx.showStatus(
						`No mental models opted into auto-refresh; ${skipped} curated model(s) left untouched. Pass an explicit id to refresh one of them.`,
					);
					return;
				}
				let queued = 0;
				for (const item of targets) {
					try {
						await state.client.refreshMentalModel(state.bankId, item.id);
						queued++;
					} catch (error) {
						this.ctx.showWarning(
							`Refresh failed for ${item.id}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
				const skippedSuffix = skipped > 0 ? `; skipped ${skipped} curated model(s)` : "";
				this.ctx.showStatus(
					`Refresh queued for ${queued}/${targets.length} auto-refresh model(s)${skippedSuffix}.`,
				);
			}
			// Reload the cache after a brief grace so the new content (if the refresh
			// completes synchronously on the server) flows into the system prompt.
			await Bun.sleep(500);
			await reloadMentalModelsForSession(state.session);
		} catch (error) {
			this.ctx.showError(`mm refresh failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmHistory(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const [model, history] = await Promise.all([
				state.client.getMentalModel(state.bankId, id, { detail: "content" }),
				state.client.getMentalModelHistory(state.bankId, id),
			]);
			if (!model) {
				this.ctx.showError(`Mental model not found: ${id}`);
				return;
			}
			if (history.length === 0) {
				this.ctx.showStatus(`No history recorded for ${id}.`);
				return;
			}
			// History is most-recent first. Each entry stores the content BEFORE that
			// change. To diff "what changed at entry N", compare entry N's
			// previous_content (= state before that change) with entry N-1's
			// previous_content (= state after that change, which was state before
			// the next change). For the most recent change, compare against the
			// model's CURRENT content.
			const sections: string[] = [];
			for (let i = 0; i < history.length; i++) {
				const before = history[i].previous_content ?? "";
				const after = i === 0 ? (model.content ?? "") : (history[i - 1].previous_content ?? "");
				const diff = diffMentalModelContent(before, after);
				sections.push(`### ${history[i].changed_at}\n\n\`\`\`diff\n${diff}\n\`\`\``);
			}
			showMarkdownPanel(this.ctx, `History — ${model.name}`, sections.join("\n\n"));
		} catch (error) {
			this.ctx.showError(`mm history failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmSeed(state: HindsightSessionState): Promise<void> {
		try {
			const config = loadHindsightConfig(this.ctx.settings);
			const seeds = resolveSeedsForScope(
				{
					bankId: state.bankId,
					retainTags: state.retainTags,
					recallTags: state.recallTags,
					recallTagsMatch: state.recallTagsMatch,
				},
				config.scoping,
			);
			if (seeds.length === 0) {
				this.ctx.showStatus(`No built-in seeds apply to scoping=${config.scoping}.`);
				return;
			}
			const list = await state.client.listMentalModels(state.bankId, { detail: "metadata" });
			const existing = list.items ?? [];
			let created = 0;
			let skipped = 0;
			for (const seed of seeds) {
				if (seedAlreadyExists(seed, existing)) {
					skipped++;
					continue;
				}
				try {
					await state.client.createMentalModel(state.bankId, seed.name, seed.sourceQuery, {
						id: seed.id,
						tags: seed.tags.length > 0 ? seed.tags : undefined,
						maxTokens: seed.maxTokens,
						trigger: seed.trigger,
					});
					created++;
				} catch (error) {
					this.ctx.showWarning(
						`Seed failed for ${seed.id}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			this.ctx.showStatus(`Seeded ${created} new mental model(s); ${skipped} already present.`);
		} catch (error) {
			this.ctx.showError(`mm seed failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #mmReload(state: HindsightSessionState): Promise<void> {
		const ok = await reloadMentalModelsForSession(state.session);
		if (ok) {
			this.ctx.showStatus("Mental-model cache reloaded.");
		} else {
			this.ctx.showError("Reload failed (Hindsight backend not active or mental models disabled).");
		}
	}

	async #mmDelete(state: HindsightSessionState, id: string): Promise<void> {
		try {
			const removed = await state.client.deleteMentalModel(state.bankId, id);
			if (!removed) {
				this.ctx.showError(`Mental model not found: ${id}`);
				return;
			}
			// Drop the cached snippet so the closing tag does not silently keep
			// stale content in the system prompt until the next agent_end TTL.
			await reloadMentalModelsForSession(state.session);
			this.ctx.showStatus(`Deleted mental model ${id} from bank ${state.bankId}.`);
		} catch (error) {
			this.ctx.showError(`mm delete failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #runNewSessionFlow(options?: NewSessionOptions, label: string = "New session started"): Promise<void> {
		this.ctx.clearTransientSessionUi();

		if (this.ctx.session.isCompacting) {
			this.ctx.session.abortCompaction();
			while (this.ctx.session.isCompacting) {
				await Bun.sleep(10);
			}
		}
		if (!(await this.ctx.session.newSession(options))) return;
		// A focused subagent view keeps its own history: return to the main session
		// first so the transcript below cannot rebuild from the subagent's surviving
		// conversation, then drop any turn-scoped anchors (coalescing timers,
		// in-flight dispatches) the session boundary orphaned.
		if (this.ctx.focusedAgentId) await this.ctx.unfocusSession();
		this.ctx.eventController.resetTranscriptAnchors();
		this.ctx.resetObserverRegistry();
		setSessionTerminalTitle(this.ctx.sessionManager.getSessionName(), this.ctx.sessionManager.getCwd());

		this.ctx.statusLine.ingestSession();
		this.ctx.statusLine.resetActiveTime();
		this.ctx.updateEditorBorderColor();
		this.ctx.clearTransientSessionUi();
		this.ctx.resetTranscript();

		this.ctx.present(CommandNoticeView({ text: label, color: "success" }));
		await this.ctx.reloadTodos();
		this.ctx.ui.resetDisplay();
	}

	async handleClearCommand(): Promise<void> {
		await this.#runNewSessionFlow();
	}

	async handleFreshCommand(): Promise<void> {
		const result = this.ctx.session.freshSession();
		if (!result) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before refreshing provider state.");
			return;
		}
		const stateLabel = result.closedProviderSessions === 1 ? "provider state" : "provider states";
		this.ctx.statusLine.ingestSession();
		this.ctx.showStatus(`Fresh provider session started (${result.closedProviderSessions} ${stateLabel} pruned).`);
	}

	async handleResetContextCommand(): Promise<void> {
		if (this.ctx.session.isCompacting) {
			this.ctx.session.abortCompaction();
			while (this.ctx.session.isCompacting) {
				await Bun.sleep(10);
			}
		}
		const result = await this.ctx.session.resetSessionContext();
		if (!result) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before resetting the context.");
			return;
		}
		// Drop the rendered transcript so the UI matches the now-empty model
		// context (mirrors #runNewSessionFlow's teardown, minus the new session —
		// the session id, title, and transcript file all survive).
		this.ctx.clearTransientSessionUi();
		this.ctx.resetTranscript();
		this.ctx.statusLine.ingestSession();
		this.ctx.updateEditorBorderColor();
		const noun = result.droppedCount === 1 ? "message" : "messages";
		this.ctx.present(
			CommandNoticeView({
				text: `Context reset — ${result.droppedCount} ${noun} dropped; session continues.`,
				color: "success",
			}),
		);
		this.ctx.ui.resetDisplay();
	}

	async handleDeleteCommand(): Promise<void> {
		if (!this.ctx.sessionManager.getSessionFile()) {
			this.ctx.showError("Nothing to delete (in-memory session)");
			return;
		}
		await this.#runNewSessionFlow({ drop: true }, "Session deleted");
	}

	async handleForkCommand(): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before forking.");
			return;
		}
		this.ctx.loadingAnimation = undefined;
		this.ctx.statusContainer.clear();

		const success = await this.ctx.session.fork();
		if (!success) {
			this.ctx.showError("Fork failed (session not persisted or cancelled)");
			return;
		}

		this.ctx.statusLine.ingestSession();

		const sessionFile = this.ctx.session.sessionFile;
		const shortPath = sessionFile ? sessionFile.split("/").pop() : "new session";
		this.ctx.present(CommandNoticeView({ text: `Session forked to ${shortPath}`, color: "success" }));
	}

	/**
	 * `/move` — relocate the current session to a different directory.
	 *
	 * With no `targetPath` (TUI only), opens an autocomplete overlay so the user
	 * can pick or type a directory. With a `targetPath`, resolves it directly.
	 * If the target directory does not exist, the user is asked whether to create
	 * it. The active session file and artifacts are moved into the target
	 * directory's session bucket so `/resume` from that directory can find it.
	 */
	async handleMoveCommand(targetPath?: string): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before moving.");
			return;
		}

		let input: string | undefined = targetPath?.trim() || undefined;

		// No argument in TUI mode: open the path autocomplete overlay.
		if (!input) {
			const result = await this.ctx.showHookCustom<MoveOverlayResult | undefined>(
				(tui, _theme, _keybindings, done) =>
					openMoveOverlay(tui, this.ctx.sessionManager.getCwd(), done, moveDirectorySource),
				{ overlay: true },
			);
			if (!result) return; // cancelled
			input = result.directory;
		}

		const unquoted = stripOuterDoubleQuotes(input);
		if (!unquoted) {
			this.ctx.showError("Usage: /move <path>");
			return;
		}

		const cwd = this.ctx.sessionManager.getCwd();
		const resolvedPath = resolveToCwd(unquoted, cwd);

		// If the directory doesn't exist, offer to create it.
		let isDirectory: boolean;
		try {
			isDirectory = (await fs.stat(resolvedPath)).isDirectory();
		} catch {
			isDirectory = false;
		}

		if (!isDirectory) {
			const parentDir = path.dirname(resolvedPath);
			let parentExists = false;
			try {
				parentExists = (await fs.stat(parentDir)).isDirectory();
			} catch {
				parentExists = false;
			}
			if (!parentExists) {
				this.ctx.showError(`Cannot create "${path.basename(resolvedPath)}": parent directory does not exist`);
				return;
			}
		}
		const moved = await this.#withSessionMove(async () => {
			if (!isDirectory) {
				const confirmed = await this.ctx.showHookConfirm(
					"Create directory?",
					`"${path.basename(resolvedPath)}" does not exist. Create it?`,
				);
				if (!confirmed) return false;
				try {
					await fs.mkdir(resolvedPath, { recursive: true });
				} catch (err) {
					this.ctx.showError(`Failed to create directory: ${err instanceof Error ? err.message : String(err)}`);
					return false;
				}
			}
			return this.#relocateSession(resolvedPath);
		});
		if (moved) {
			this.ctx.present(CommandNoticeView({ text: `Moved to ${resolvedPath}`, color: "success" }));
		}
	}

	/**
	 * `/wt [<branch>]` — fork the checkout into a new linked git worktree on
	 * `branch` (default `wt/<timestamp>`), carrying uncommitted changes along,
	 * then relocate the session there like `/move`.
	 */
	async handleWorktreeCommand(branch?: string): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before creating a worktree.");
			return;
		}
		await this.#withSessionMove(async () => {
			const branchName = branch?.trim() || defaultSessionWorktreeBranch();
			const cwd = this.ctx.sessionManager.getCwd();
			this.ctx.statusContainer.clear();
			const loader = this.ctx.statusContainer.append(BusyView({ message: `Creating worktree on ${branchName}…` }));
			let worktree: SessionWorktree;
			try {
				worktree = await createSessionWorktree(cwd, this.ctx.settings, branchName);
			} catch (err) {
				this.ctx.showError(`Worktree creation failed: ${err instanceof Error ? err.message : String(err)}`);
				return false;
			} finally {
				this.ctx.statusContainer.remove(loader);
			}
			if (worktree.cloneError) {
				logger.warn("worktree clone fell back to plain checkout", {
					path: worktree.path,
					error: worktree.cloneError,
				});
			}
			if (!(await this.#relocateSession(worktree.path))) return false;
			const cleanup = await cleanSourceCheckoutIfConfigured(cwd, this.ctx.settings);
			if (cleanup.errorMessage !== undefined) {
				this.ctx.showWarning(`Worktree created, but cleaning source checkout failed: ${cleanup.errorMessage}`);
			}
			this.ctx.present(
				CommandNoticeView({ text: formatSessionWorktreeSummary(worktree, cleanup.cleaned), color: "success" }),
			);
			return true;
		});
	}

	/** Save source settings before acquiring the gate for a complete relocation operation. */
	async #withSessionMove(operation: () => Promise<boolean>): Promise<boolean> {
		try {
			await this.ctx.settings.flush();
		} catch (err) {
			this.ctx.showError(`Failed to save pending settings: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}

		return this.ctx.withBtwSessionMove(operation);
	}

	/** Relocate only while #withSessionMove holds the BTW gate; false means no successful move. */
	async #relocateSession(resolvedPath: string): Promise<boolean> {
		if (resolvedPath === path.resolve(this.ctx.sessionManager.getCwd())) return false;

		const previousState = this.ctx.sessionManager.captureState();
		try {
			await this.ctx.session.moveSession(resolvedPath);
		} catch (err) {
			this.ctx.showError(`Move failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
		let applied = false;
		try {
			applied = await this.ctx.applyCwdChange(resolvedPath);
		} catch (error) {
			await this.#restoreAfterMoveFailure(previousState, error);
			return false;
		}
		if (!applied) {
			await this.#restoreAfterMoveFailure(previousState);
			return false;
		}

		this.ctx.updateEditorBorderColor();
		await this.ctx.reloadTodos();
		return true;
	}

	async handleRenameCommand(title: string): Promise<void> {
		const session = this.ctx.session;
		const sessionManager = this.ctx.sessionManager;
		const sessionId = sessionManager.getSessionId();
		const signal = session.titleGenerationSignal;
		let titleRevision = sessionManager.titleRevision;
		const isCurrent = () =>
			this.ctx.session === session &&
			this.ctx.sessionManager === sessionManager &&
			!signal.aborted &&
			sessionManager.getSessionId() === sessionId &&
			sessionManager.titleRevision === titleRevision;
		try {
			const persistence = sessionManager.setSessionName(title, "user");
			titleRevision = sessionManager.titleRevision;
			const stored = await persistence;
			if (!isCurrent()) return;
			if (!stored) {
				this.ctx.showError("Session name cannot be empty.");
				return;
			}
			const name = sessionManager.getSessionName()!;
			this.ctx.showStatus(`Session renamed to "${name}".`);
		} catch (err) {
			if (!isCurrent()) return;
			this.ctx.showError(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const isDeferred = this.ctx.session.isStreaming;
		const shouldPersistCwd = isPersistentShellCdCommand(command);
		if (isDeferred && shouldPersistCwd) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before changing directories.");
			return;
		}

		if (shouldPersistCwd) {
			await this.#withSessionMove(() => this.#executeBashCommand(command, excludeFromContext, isDeferred, true));
		} else {
			await this.#executeBashCommand(command, excludeFromContext, isDeferred, false);
		}
	}

	/** Returns whether shell execution committed a cwd relocation, not whether the shell command succeeded. */
	async #executeBashCommand(
		command: string,
		excludeFromContext: boolean,
		isDeferred: boolean,
		shouldPersistCwd: boolean,
	): Promise<boolean> {
		const stream = new BashExecutionStream();
		stream.setPtyViewport((this.ctx.ui.terminal.columns ?? 80) - 2, (this.ctx.ui.terminal.rows ?? 24) - 4);
		const entryId = `bash:${Snowflake.next()}`;
		const view = () =>
			BashExecutionView({
				command,
				stream,
				expanded: () => this.ctx.toolOutputExpanded,
				excludeFromContext,
			});
		const pendingId = isDeferred ? this.ctx.pendingMessagesContainer.append(view) : undefined;
		const pendingExecution: PendingExecution | undefined =
			pendingId === undefined
				? undefined
				: {
						id: entryId,
						pendingId,
						sessionId: this.ctx.sessionManager.getSessionId(),
						view,
						state: "active",
					};
		if (pendingExecution) this.ctx.pendingExecutions.push(pendingExecution);
		if (!isDeferred) {
			this.ctx.chatContainer.append({
				id: entryId,
				state: "active",
				view,
			});
		}

		try {
			const result = await this.ctx.session.executeBash(command, chunk => stream.appendOutput(chunk), {
				excludeFromContext,
				useUserShell: true,
				pty: {
					...stream.getPtyViewport(),
					onChunk: chunk => stream.appendPtyChunk(chunk),
				},
			});
			await stream.setComplete(result.exitCode, result.cancelled, {
				output: result.output,
				meta: outputMeta().truncationFromSummary(result, { direction: "tail" }).get(),
				images: result.images,
				showImages: this.ctx.settings.get("terminal.showImages"),
			});
			if (pendingExecution) pendingExecution.state = "settled";
			this.ctx.chatContainer.replace(entryId, { state: "settled" });
			try {
				if (shouldPersistCwd) return await this.#applyBashResultCwd(result);
			} catch (error) {
				this.ctx.showError(
					`Bash command completed, but OMP failed to update its working directory: ${
						error instanceof Error ? error.message : "Unknown error"
					}`,
				);
			}
		} catch (error) {
			await stream.setComplete(undefined, false);
			if (pendingExecution) pendingExecution.state = "settled";
			this.ctx.chatContainer.replace(entryId, { state: "settled" });
			this.ctx.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
		return false;
	}

	async #applyBashResultCwd(result: BashResult): Promise<boolean> {
		if (result.cancelled || result.exitCode !== 0 || !result.workingDir) return false;
		if (!path.isAbsolute(result.workingDir)) return false;

		const resolvedPath = path.resolve(result.workingDir);
		if (resolvedPath === path.resolve(this.ctx.sessionManager.getCwd())) return false;

		let isDirectory = false;
		try {
			isDirectory = (await fs.stat(resolvedPath)).isDirectory();
		} catch {
			isDirectory = false;
		}
		if (!isDirectory) return false;

		return this.#relocateSession(resolvedPath);
	}

	async handlePythonCommand(code: string, excludeFromContext = false): Promise<void> {
		const [output, setOutput] = createSignal("");
		const [exitCode, setExitCode] = createSignal<number | undefined>();
		const [cancelled, setCancelled] = createSignal(false);
		const [completed, setCompleted] = createSignal(false);
		const [meta, setMeta] = createSignal<OutputMeta | undefined>();
		const entryId = `python:${Snowflake.next()}`;
		const isDeferred = this.ctx.session.isStreaming;
		const view = () =>
			EvalExecutionView({
				language: "python",
				code,
				output,
				exitCode,
				cancelled,
				running: () => !completed(),
				expanded: () => this.ctx.toolOutputExpanded,
				excludeFromContext,
				meta,
			});
		const pendingId = isDeferred ? this.ctx.pendingMessagesContainer.append(view) : undefined;
		const pendingExecution: PendingExecution | undefined =
			pendingId === undefined
				? undefined
				: {
						id: entryId,
						pendingId,
						sessionId: this.ctx.sessionManager.getSessionId(),
						view,
						state: "active",
					};
		if (pendingExecution) this.ctx.pendingExecutions.push(pendingExecution);
		if (!isDeferred) {
			this.ctx.chatContainer.append({
				id: entryId,
				state: "active",
				view,
			});
		}

		try {
			const result = await this.ctx.session.executePython(code, chunk => setOutput(previous => previous + chunk), {
				excludeFromContext,
			});
			setOutput(result.output);
			setExitCode(result.exitCode);
			setCancelled(result.cancelled);
			setMeta(outputMeta().truncationFromSummary(result, { direction: "tail" }).get());
			setCompleted(true);
			if (pendingExecution) pendingExecution.state = "settled";
			this.ctx.chatContainer.replace(entryId, { state: "settled" });
		} catch (error) {
			setCompleted(true);
			if (pendingExecution) pendingExecution.state = "settled";
			this.ctx.chatContainer.replace(entryId, { state: "settled" });
			this.ctx.showError(`Python execution failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	async handleCompactCommand(
		customInstructions?: string,
		mode?: CompactMode,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		internalGuidance?: string,
	): Promise<CompactionOutcome> {
		const entries = this.ctx.sessionManager.getEntries();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			this.ctx.showWarning("Nothing to compact (no messages yet)");
			return "ok";
		}

		// `internalGuidance` is a private summarizer directive (plan-mode
		// "Approve and compact context") that MUST stay off the public
		// `customInstructions` channel of the `session_before_compact` extension
		// hook — extensions treat that field as user focus and would otherwise
		// bias the summary toward the plan boilerplate (issue #4359). Ride it
		// through as a CompactOptions field instead. That caller also dispatches
		// the execution turn itself, so the compaction must not resume the
		// plan-approval turn it aborted.
		if (internalGuidance) {
			return this.executeCompaction(
				{ internalGuidance, suppressContinuation: true, ...(mode ? { mode } : {}) },
				false,
				beforeFlush,
				mode,
			);
		}
		return this.executeCompaction(customInstructions, false, beforeFlush, mode);
	}

	/**
	 * TUI handler for `/shake`. `elide` drops heavy structural content,
	 * `images` strips image blocks, and `thinking` drops all thinking blocks.
	 * Rebuilds the chat and reports counts.
	 */
	async handleShakeCommand(mode: ShakeMode): Promise<void> {
		let result: ShakeResult;
		try {
			result = await this.ctx.session.shake(mode);
		} catch (error) {
			this.ctx.showError(`Shake failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		const dropped =
			result.toolResultsDropped +
			result.blocksDropped +
			(result.imagesDropped ?? 0) +
			(result.thinkingBlocksDropped ?? 0);
		if (dropped === 0) {
			this.ctx.showStatus("Nothing to shake.");
			return;
		}
		this.ctx.rebuildChatFromMessages();
		this.ctx.statusLine.ingestSession();
		this.ctx.showStatus(formatShakeSummary(result));
	}

	async executeCompaction(
		customInstructionsOrOptions?: string | CompactOptions,
		isAuto = false,
		beforeFlush?: (outcome: CompactionOutcome) => void | Promise<void>,
		mode?: CompactMode,
	): Promise<CompactionOutcome> {
		this.ctx.loadingAnimation = undefined;
		this.ctx.statusContainer.clear();

		const label = isAuto ? "Auto-compacting context… esc to cancel" : "Compacting context… esc to cancel";
		const compactingLoader = this.ctx.statusContainer.append(BusyView({ message: label }));

		let outcome: CompactionOutcome = "ok";
		try {
			const instructions = typeof customInstructionsOrOptions === "string" ? customInstructionsOrOptions : undefined;
			const baseOptions =
				customInstructionsOrOptions && typeof customInstructionsOrOptions === "object"
					? customInstructionsOrOptions
					: undefined;
			// The slash path passes `mode` positionally; the extension path carries
			// it inside the options object. Either source wins over no mode.
			const effectiveMode = mode ?? baseOptions?.mode;
			const options =
				baseOptions || effectiveMode
					? { ...baseOptions, ...(effectiveMode ? { mode: effectiveMode } : {}) }
					: undefined;
			await this.ctx.session.compact(instructions, options);

			this.ctx.statusContainer.remove(compactingLoader);
			this.ctx.rebuildChatFromMessages();

			this.ctx.statusLine.ingestSession();
			// Same as the auto-compaction rebuild: a collapsed transcript is an
			// intentional replacement, so drop the stale pre-compaction scrollback
			// instead of repainting the shrunken frame below it. With collapse
			// disabled the full history stays inline and scrollback is kept.
			if (this.ctx.settings.get("display.collapseCompacted")) {
				this.ctx.ui.resetDisplay();
			}
		} catch (error) {
			if (error instanceof CompactionCancelledError) {
				outcome = "cancelled";
				this.ctx.showError("Compaction cancelled");
			} else {
				outcome = "failed";
				const message = error instanceof Error ? error.message : String(error);
				this.ctx.showError(`Compaction failed: ${message}`);
			}
		} finally {
			this.ctx.statusContainer.remove(compactingLoader);
		}
		// Run the caller's pre-flush hook (e.g. the plan-approval model transition)
		// before queued user input is dispatched, so any turn queued during
		// compaction executes on the post-compaction model rather than the model
		// compaction itself ran on.
		if (beforeFlush) await beforeFlush(outcome);
		await this.ctx.flushCompactionQueue({ willRetry: false });
		return outcome;
	}

	async handleHandoffCommand(customInstructions?: string): Promise<void> {
		if (this.ctx.session.isStreaming) {
			this.ctx.showWarning("Wait for the current response to finish or abort it before handing off.");
			return;
		}
		if (this.ctx.session.isCompacting) {
			this.ctx.showWarning("Wait for context compaction to finish or cancel it before handing off.");
			return;
		}

		const entries = this.ctx.sessionManager.getEntries();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			this.ctx.showWarning("Nothing to hand off (no messages yet)");
			return;
		}

		this.ctx.loadingAnimation = undefined;
		this.ctx.statusContainer.clear();

		const handoffLoader = this.ctx.statusContainer.append(BusyView({ message: "Generating handoff… esc to cancel" }));
		let replacedDisplay = false;

		try {
			// Handoff generation runs as a oneshot request; the document is then
			// committed as a compaction entry on this session.
			const result = await this.ctx.session.handoff(customInstructions);

			if (!result) {
				this.ctx.showError("Handoff cancelled");
				return;
			}

			// Rebuild chat from the session, which now shows the handoff compaction divider.
			this.ctx.clearTransientSessionUi();
			await this.ctx.renderInitialMessages();
			replacedDisplay = true;
			this.ctx.statusLine.ingestSession();
			this.ctx.updateEditorBorderColor();
			await this.ctx.reloadTodos();

			this.ctx.present(CommandNoticeView({ text: "Context handed off and compacted in place", color: "success" }));
			if (result.savedPath) {
				this.ctx.showStatus(`Handoff document saved to: ${result.savedPath}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// `session.handoff()` normalizes genuine cancellations to this exact message; a
			// provider error (even one named AbortError) is re-thrown verbatim so it surfaces
			// as a real failure instead of a false "cancelled".
			if (message === "Handoff cancelled") {
				this.ctx.showError("Handoff cancelled");
			} else {
				// Persist the real failure so it is debuggable after the transient
				// TUI error clears (#7993).
				logger.error("Handoff failed", { error: message });
				this.ctx.showError(`Handoff failed: ${message}`);
			}
		} finally {
			this.#finishHandoffUi(handoffLoader);
		}
		if (replacedDisplay) this.ctx.ui.resetDisplay();
	}

	#finishHandoffUi(handoffLoader: string): void {
		this.ctx.statusContainer.remove(handoffLoader);
		const maintenanceLoader = this.ctx.autoCompactionLoader ?? this.ctx.retryLoader;
		if (maintenanceLoader && this.ctx.statusContainer.entries().some(entry => entry.id === maintenanceLoader)) return;
		this.ctx.statusContainer.clear();
		this.ctx.loadingAnimation = undefined;
		if (this.ctx.session.isStreaming) this.ctx.ensureLoadingAnimation();
	}
}

function resolveProviderAuthMode(authStorage: AuthStorage, provider: string): string {
	if (authStorage.hasOAuth(provider)) return "oauth";
	if (authStorage.has(provider)) return "api key";
	if (getEnvApiKey(provider)) return "env api key";
	if (authStorage.hasAuth(provider)) return "runtime/fallback";
	return "unknown";
}
