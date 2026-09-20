import { describe, expect, test } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import { createSignal } from "../src/reactive";
import { TERMINAL } from "../src/terminal-capabilities";
import { AdvisorMessageView } from "../src/chat/advisor-message";
import { AsyncResultMessageView } from "../src/chat/async-result-message";
import { ChatTranscriptBuilder } from "../src/chat/chat-transcript-builder";
import { textContent, type TranscriptEntryLike } from "../src/chat/transcript-entry";
import { BackgroundTanDispatchView } from "../src/chat/background-tan-message";
import { AssistantMessageView } from "../src/chat/assistant-message";
import { BashExecutionView } from "../src/chat/bash-execution";
import { CacheInvalidationMarkerView } from "../src/chat/cache-invalidation-marker";
import { BranchSummaryView } from "../src/chat/branch-summary";
import { CompactionSummaryMessageView, HandoffSummaryMessageView } from "../src/chat/compaction-summary-message";
import { CollabPromptMessageView } from "../src/chat/collab-prompt-message";
import { CustomMessageView } from "../src/chat/custom-message";
import { HookMessageView } from "../src/chat/hook-message";
import { EvalExecutionView } from "../src/chat/eval-execution";
import { LateDiagnosticsMessageView } from "../src/chat/late-diagnostics-message";
import { ReadToolGroupView, type ReadToolGroupItem } from "../src/chat/read-tool-group";
import { ServedModelMarkerView } from "../src/chat/served-model-marker";
import { SkillMessageView } from "../src/chat/skill-message";
import { TodoReminderView } from "../src/chat/todo-reminder";
import { TtsrNotificationView } from "../src/chat/ttsr-notification";
import { CollapsedSyntheticMessageView, UserMessageView } from "../src/chat/user-message";
import { ComposerView } from "../src/prompt/composer-view";
import { createTranscriptStore } from "../src/chat/transcript-store";
import { createToolCallModel } from "../src/tools/model";
import { mountForTest } from "../src/testing";
import "../src/host/elements/badge";
import "../src/host/elements/box";
import "../src/host/elements/code";
import "../src/host/elements/frame";
import "../src/host/elements/image";
import "../src/host/elements/link";
import "../src/host/elements/preview";
import "../src/host/elements/span";
import "../src/host/elements/markdown";
import "../src/host/elements/rail";
import "../src/host/elements/raw";
import "../src/host/elements/row";
import "../src/host/elements/stack";
import "../src/host/elements/status";
import "../src/host/elements/text";
import "../src/host/elements/transcript";
import "../src/host/elements/transcript-block";

describe("reactive chat message views", () => {
	test("mounts a user bubble and expands its synthetic transcript counterpart", () => {
		const root = mountForTest(() => (
			<stack>
				<UserMessageView text="Hello **world**" reaction="👍" />
				<CollapsedSyntheticMessageView text="# Session update\nbody" expanded />
			</stack>
		));
		try {
			expect(root.text()).toEqual(
				expect.arrayContaining([expect.stringContaining("Hello"), expect.stringContaining("Session update")]),
			);
		} finally {
			root.dispose();
		}
	});

	test("restores the historical collaborator attribution and user bubble spacing", () => {
		const root = mountForTest(
			() => (
				<CollabPromptMessageView
					message={{
						role: "custom",
						customType: "collab-prompt",
						content: [
							{ type: "text", text: "before" },
							{ type: "image", data: "opaque-attachment", mimeType: "image/png" },
							{ type: "text", text: "after" },
						],
						display: true,
						details: { from: "  guest  " },
						timestamp: 0,
					}}
				/>
			),
			{ width: 48 },
		);
		try {
			const wide = root.text();
			expect(wide[0]).toBe(" «guest» › ");
			expect(wide[1]?.trim()).toBe("");
			expect(wide[2]).toContain("beforeafter");
			expect(wide[2]).not.toContain("opaque-attachment");
			expect(wide.at(-1)?.trim()).toBe("");

			for (const row of root.text(8)) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(8);
		} finally {
			root.dispose();
		}
	});

	test("exports document-backed views for every transcript message family", () => {
		expect([
			AdvisorMessageView,
			AsyncResultMessageView,
			AssistantMessageView,
			BackgroundTanDispatchView,
			BashExecutionView,
			BranchSummaryView,
			CacheInvalidationMarkerView,
			CollabPromptMessageView,
			CompactionSummaryMessageView,
			CustomMessageView,
			EvalExecutionView,
			HookMessageView,
			HandoffSummaryMessageView,
			LateDiagnosticsMessageView,
			ReadToolGroupView,
			ServedModelMarkerView,
			SkillMessageView,
			TodoReminderView,
			TtsrNotificationView,
		]).toHaveLength(19);
	});

	test("groups selector rows and keeps request usage after the corresponding reads", () => {
		const read = createToolCallModel({ id: "read", toolName: "read", label: "read" });
		read.applyArgsChunk({ path: "src/one.ts:1-2,src/two.ts:4-6" });
		read.applyResult({ content: [{ type: "text", text: "combined result" }] });
		const [items, setItems] = createSignal<readonly ReadToolGroupItem[]>([{ kind: "tool", model: read }]);
		const usage = {
			input: 111,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 114,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		} satisfies Usage;
		const root = mountForTest(() => (
			<ReadToolGroupView items={items} expanded={() => false} showContentPreview={false} />
		));
		try {
			expect(root.text().join("\n")).toContain("Read (2)");
			expect(root.text().join("\n")).toContain("src/one.ts:1-2");
			expect(root.text().join("\n")).toContain("src/two.ts:4-6");

			setItems(current => [...current, { kind: "usage", usage }]);
			root.flush();
			const text = root.text().join("\n");
			expect(text.indexOf("src/two.ts:4-6")).toBeLessThan(text.indexOf("111"));
		} finally {
			root.dispose();
		}
	});

	test("keeps grouped read graphics owned by the model visibility preference", () => {
		const read = createToolCallModel({ id: "read-image", toolName: "read", label: "read" });
		read.applyArgsChunk({ path: "preview.png" });
		read.applyResult({
			content: [
				{
					type: "image",
					mimeType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLkVwAAAABJRU5ErkJggg==",
				},
			],
		});
		read.setUi({ showImages: false });
		const [items] = createSignal<readonly ReadToolGroupItem[]>([{ kind: "tool", model: read }]);
		const root = mountForTest(() => (
			<ReadToolGroupView items={items} expanded={() => false} showContentPreview={false} />
		));
		const hasImage = () =>
			root.rows().some(row => TERMINAL.isImageLine(row) || Bun.stripANSI(row).includes("[Image:"));
		try {
			expect(hasImage()).toBe(false);
			read.setUi({ showImages: true });
			expect(hasImage()).toBe(true);
			read.setUi({ showImages: false });
			expect(hasImage()).toBe(false);
		} finally {
			root.dispose();
		}
	});

	test("collapses grouped previews to three lines and expands the complete result", () => {
		const read = createToolCallModel({ id: "preview", toolName: "read", label: "read" });
		read.applyArgsChunk({ path: "src/preview.ts" });
		read.applyResult({ content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4" }] });
		const [expanded, setExpanded] = createSignal(false);
		const [items] = createSignal<readonly ReadToolGroupItem[]>([{ kind: "tool", model: read }]);
		const root = mountForTest(() => <ReadToolGroupView items={items} expanded={expanded} showContentPreview />);
		try {
			const collapsed = root.text().join("\n");
			expect(collapsed).toContain("line 3");
			expect(collapsed).not.toContain("line 4");
			expect(collapsed).toContain("… 1 more line");

			setExpanded(true);
			root.flush();
			expect(root.text().join("\n")).toContain("line 4");
		} finally {
			root.dispose();
		}
	});

	test("reveals branch summary content only while expanded and retains it across toggles", () => {
		const [expanded, setExpanded] = createSignal(false);
		const root = mountForTest(() => (
			<BranchSummaryView
				message={{
					role: "branchSummary",
					summary: "Completed the implementation.",
					fromId: "branch",
					timestamp: 0,
				}}
				expanded={expanded()}
			/>
		));
		try {
			expect(root.text().join("\n")).not.toContain("Completed the implementation.");
			setExpanded(true);
			expect(root.text().map(row => row.trim())).toContain("Completed the implementation.");
			setExpanded(false);
			expect(root.text().join("\n")).not.toContain("Completed the implementation.");
			setExpanded(true);
			expect(root.text().map(row => row.trim())).toContain("Completed the implementation.");
		} finally {
			root.dispose();
		}
	});

	test("renders each async completion and its capture warning", () => {
		const root = mountForTest(() => (
			<AsyncResultMessageView
				message={{
					role: "custom",
					customType: "async-result",
					content: "",
					display: true,
					details: {
						jobs: [
							{ jobId: "compile", type: "bash", durationMs: 1_200, meta: { artifactError: "write" } },
							{ jobId: "review", type: "task", durationMs: 400 },
						],
						meta: { artifactError: "flush" },
					},
					timestamp: 0,
				}}
			/>
		));
		try {
			const rendered = root.text().join("\n");
			expect(rendered).toContain("Background job completed [bash] compile (1.2s)");
			expect(rendered).toContain("Background job completed [task] review (400ms)");
			expect(rendered.match(/Full output was not saved completely/g)).toHaveLength(2);
		} finally {
			root.dispose();
		}
	});

	test("mounts the compositor-backed composer shell", () => {
		const transcript = createTranscriptStore();
		transcript.append({ id: "message", state: "settled", view: () => <text>message</text> });
		const root = mountForTest(() => <ComposerView transcript={transcript} editor={<text>editor</text>} />);
		try {
			expect(root.text()).toEqual(["message", "editor"]);
		} finally {
			root.dispose();
		}
	});

	test("publishes builder entries through the reactive store", () => {
		const builder = new ChatTranscriptBuilder();
		builder.rebuild([]);
		const root = mountForTest(builder.view);
		try {
			expect(root.text()).toEqual([]);
		} finally {
			root.dispose();
		}
	});

	test("anchors persisted entries after layout while appending and expanding in place", () => {
		const first: TranscriptEntryLike = {
			type: "custom_message",
			id: "first",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "notice",
			content: "first",
			display: true,
		};
		const second: TranscriptEntryLike = {
			type: "custom_message",
			id: "second",
			parentId: "first",
			timestamp: "2026-01-01T00:00:01.000Z",
			customType: "notice",
			content: "second",
			display: true,
		};
		const builder = new ChatTranscriptBuilder({
			getMessageView: () => props => (
				<text>
					{props.expanded ? "expanded" : "collapsed"}: {textContent(props.message.content)}
				</text>
			),
		});
		builder.rebuild([first]);
		const root = mountForTest(builder.view);
		try {
			expect(root.text().join("\n")).toContain("collapsed");
			expect(builder.rowForEntry("first")).toBe(0);

			builder.append([second]);
			expect(root.text().join("\n")).toContain("second");
			expect(builder.rowForEntry("second")).toBeGreaterThan(0);

			builder.setExpanded(true);
			expect(root.text().join("\n")).toContain("expanded");
		} finally {
			root.dispose();
		}
	});
});
