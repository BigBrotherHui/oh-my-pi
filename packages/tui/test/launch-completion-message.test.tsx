import { describe, expect, test } from "bun:test";
import { LaunchCompletionMessageView } from "../src/chat/launch-completion-message";
import { mountForTest } from "../src/testing";
import "../src/host/elements/span";
import "../src/host/elements/stack";
import "../src/host/elements/text";

describe("launch completion message", () => {
	test("renders each completed daemon with its exit metadata", () => {
		const root = mountForTest(
			() => (
				<LaunchCompletionMessageView
					message={{
						role: "custom",
						customType: "launch-completion",
						content: "unused because daemon details are available",
						display: true,
						details: {
							daemons: [
								{ name: "web", state: "exited", startedAt: 1_000, exitedAt: 2_500, exitCode: 0 },
								{ name: "worker", state: "failed", startedAt: 1_000, exitedAt: 1_250, exitCode: 1 },
							],
						},
						timestamp: 0,
					}}
				/>
			),
			{ width: 120 },
		);
		try {
			const text = root.text().join("\n");
			expect(text).toContain(
				`${root.root.theme.symbol("status.done")} Supervised process completed web (exit 0) (1.5s)`,
			);
			expect(text).toContain(
				`${root.root.theme.symbol("status.error")} Supervised process failed worker (exit 1) (250ms)`,
			);
			expect(text).not.toContain("unused because daemon details are available");
		} finally {
			root.dispose();
		}
	});

	test("preserves the model-visible notification when legacy details are absent", () => {
		const root = mountForTest(
			() => (
				<LaunchCompletionMessageView
					message={{
						role: "custom",
						customType: "launch-completion",
						content: "Supervised process api exited with exit code 0.",
						display: true,
						timestamp: 0,
					}}
				/>
			),
			{ width: 120 },
		);
		try {
			expect(root.text().join("\n")).toContain(
				`${root.root.theme.symbol("status.done")} Supervised process api exited with exit code 0.`,
			);
		} finally {
			root.dispose();
		}
	});
});
