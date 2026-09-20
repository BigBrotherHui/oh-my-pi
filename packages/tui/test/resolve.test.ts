import { describe, expect, it } from "bun:test";
import { mountForTest } from "../src/testing";
import { createToolCallModel } from "../src/tools/model";
import { visibleWidth } from "../src/utils";
import {
	PROPOSE_DEVICE_NAME,
	resolveToolView,
	resolveSummary,
	type ResolveInvocation,
	type ResolveDetails,
} from "../src/tools/resolve";

describe("resolve tool view", () => {
	it("preserves the historical five-row accepted result and unwraps a write dispatch", () => {
		const model = createToolCallModel<Partial<ResolveInvocation>, ResolveDetails>({
			id: "resolve-apply",
			toolName: "resolve",
			label: "Resolve",
		});
		model.applyArgsChunk({ action: "apply", reason: "All changes look good" });
		model.applyResult({
			content: [{ type: "text", text: "Successfully resolved" }],
			details: {
				xdev: {
					inner: {
						action: "apply",
						reason: "All changes look good",
						label: "AST Edit: 3 replacements in 2 files",
					},
				},
			},
		});

		const root = mountForTest(() => resolveToolView.view(model), { width: 80 });
		const rows = root.text(80);
		expect(rows).toHaveLength(5);
		expect(rows[1]).toContain("Accept:");
		expect(rows[1]).toContain("3 replacements in 2 files");
		expect(rows[1]).toContain("AST Edit");
		expect(rows[3]).toContain("All changes look good");

		const narrowRows = root.text(12);
		expect(narrowRows).toHaveLength(5);
		expect(narrowRows.every(row => visibleWidth(row) <= 12)).toBe(true);
		root.dispose();
	});

	it("keeps a streamed device write as its historical pending single-line preview", () => {
		const model = createToolCallModel<Partial<ResolveInvocation>, ResolveDetails>({
			id: "propose-stream",
			toolName: PROPOSE_DEVICE_NAME,
			label: "Propose",
		});
		model.applyArgsChunk({
			device: PROPOSE_DEVICE_NAME,
			__partialJson: "release-v1\nremaining streamed text",
		});
		model.markQueued();

		const root = mountForTest(() => resolveToolView.view(model), { width: 80 });
		const rows = root.text(80);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("Propose: release-v1");
		expect(rows[0]).not.toContain("Accept:");
		root.dispose();
	});

	it("switches an empty partial result to the merged result card", () => {
		const model = createToolCallModel<Partial<ResolveInvocation>, ResolveDetails>({
			id: "resolve-partial",
			toolName: "resolve",
			label: "Resolve",
		});
		model.applyArgsChunk({ action: "apply" });
		model.markRunning();
		model.applyResult({ content: [] }, { partial: true });

		const root = mountForTest(() => resolveToolView.view(model), { width: 80 });
		const rows = root.text(80);
		expect(rows).toHaveLength(5);
		expect(rows[1]).toContain("Accept:");
		expect(rows[3]).toContain("No reason provided");
		root.dispose();
	});

	it("renders failures and cancellations as distinct terminal outcomes", () => {
		const failed = createToolCallModel<Partial<ResolveInvocation>, ResolveDetails>({
			id: "resolve-failed",
			toolName: "resolve",
			label: "Resolve",
		});
		failed.applyArgsChunk({ action: "apply" });
		failed.applyResult({
			content: [{ type: "text", text: "Apply failed" }],
			details: { action: "apply", reason: "Patch no longer applies", label: "staged patch" },
			isError: true,
		});

		const failedRoot = mountForTest(() => resolveToolView.view(failed), { width: 80 });
		expect(failedRoot.text(80)[1]).toContain("Failed:");
		failedRoot.dispose();

		const aborted = createToolCallModel<Partial<ResolveInvocation>, ResolveDetails>({
			id: "resolve-aborted",
			toolName: "resolve",
			label: "Resolve",
		});
		aborted.applyArgsChunk({ action: "apply" });
		aborted.applyResult({
			content: [{ type: "text", text: "Interrupted" }],
			details: { action: "apply", reason: "Turn interrupted", label: "staged patch" },
			status: "cancelled",
		});

		const abortedRoot = mountForTest(() => resolveToolView.view(aborted), { width: 80 });
		expect(abortedRoot.text(80)[1]).toContain("Aborted:");
		abortedRoot.dispose();
	});

	it("reports compact state with the same lifecycle tones", () => {
		const discarded = createToolCallModel<Partial<ResolveInvocation>, ResolveDetails>({
			id: "resolve-summary",
			toolName: "reject",
			label: "Reject",
		});
		discarded.applyArgsChunk({ action: "discard", reason: "Tests failed" });
		discarded.applyResult({
			content: [{ type: "text", text: "Rejected" }],
			details: { action: "discard", reason: "Tests failed" },
		});

		const summary = resolveSummary(discarded);
		expect(summary.label).toBe("reject");
		expect(summary.detail).toBe("Tests failed");
		expect(summary.status).toBe("warning");
	});
});
