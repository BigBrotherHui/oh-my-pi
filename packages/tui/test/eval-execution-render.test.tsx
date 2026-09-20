import { describe, expect, test } from "bun:test";
import { createSignal } from "../src/reactive";
import { EvalExecutionView } from "../src/chat/eval-execution";
import { mountForTest } from "../src/testing";
import "../src/host/elements/box";
import "../src/host/elements/br";
import "../src/host/elements/code";
import "../src/host/elements/hr";
import "../src/host/elements/pre";
import "../src/host/elements/rail";
import "../src/host/elements/row";
import "../src/host/elements/span";
import "../src/host/elements/spinner";
import "../src/host/elements/stack";
import "../src/host/elements/text";

describe("user Python execution transcript", () => {
	test("repaints streamed output in place before completing the historical execution frame", () => {
		const [output, setOutput] = createSignal("");
		const [running, setRunning] = createSignal(true);
		const [exitCode, setExitCode] = createSignal<number | undefined>();
		const [expanded, setExpanded] = createSignal(false);
		const rows = Array.from({ length: 26 }, (_, index) => `row-${index}`).join("\n");
		const root = mountForTest(
			() => (
				<EvalExecutionView
					language="python"
					code="print('ready')"
					output={output}
					exitCode={exitCode}
					cancelled={false}
					expanded={expanded}
					running={running}
				/>
			),
			{ width: 80 },
		);
		try {
			expect(root.text().join("\n")).toContain("Running… (esc to cancel)");

			setOutput(rows);
			setExitCode(0);
			setRunning(false);
			let rendered = root.text().join("\n");
			expect(rendered).toContain(">>> print('ready')");
			expect(rendered).toContain("row-25");
			expect(rendered).not.toContain("row-0");
			expect(rendered).toContain("… 6 more lines (ctrl+o to expand)");
			expect(rendered).not.toContain("Running… (esc to cancel)");
			expect(rendered).not.toContain("Completed");

			setExpanded(true);
			rendered = root.text().join("\n");
			expect(rendered).toContain("row-0");
			expect(rendered).not.toContain("… 6 more lines (ctrl+o to expand)");
		} finally {
			root.dispose();
		}
	});

	test("counts collapsed output in visual rows at narrow widths", () => {
		const output = Array.from(
			{ length: 8 },
			(_, index) => `${String.fromCharCode(97 + index)}${"x".repeat(29)}`,
		).join("\n");
		const root = mountForTest(
			() => (
				<EvalExecutionView
					language="python"
					code="print('rows')"
					output={output}
					exitCode={0}
					cancelled={false}
					expanded={false}
				/>
			),
			{ width: 12 },
		);
		try {
			expect(
				root
					.text()
					.map(line => line.trim())
					.join(" "),
			).toContain("… 4 more lines (ctrl+o to expand)");
		} finally {
			root.dispose();
		}
	});

	test("keeps cancellation precedence and failure/capture notices in the execution footer", () => {
		const [cancelled, setCancelled] = createSignal(true);
		const root = mountForTest(() => (
			<EvalExecutionView
				language="python"
				code="raise RuntimeError()"
				output="failure"
				exitCode={7}
				cancelled={cancelled}
				expanded={false}
				meta={{
					truncation: {
						direction: "tail",
						truncatedBy: "lines",
						totalLines: 10,
						totalBytes: 100,
						outputLines: 2,
						outputBytes: 20,
						shownRange: { start: 9, end: 10 },
					},
					artifactError: "flush",
				}}
			/>
		));
		try {
			let rendered = root.text().join("\n");
			expect(rendered).toContain("(cancelled)");
			expect(rendered).not.toContain("(exit 7)");
			expect(rendered).toContain("Showing lines 9-10 of 10");
			expect(rendered).toContain("Full output was not saved completely (artifact flush failed)");

			setCancelled(false);
			rendered = root.text().join("\n");
			expect(rendered).toContain("(exit 7)");
			expect(rendered).not.toContain("(cancelled)");
		} finally {
			root.dispose();
		}
	});
});
