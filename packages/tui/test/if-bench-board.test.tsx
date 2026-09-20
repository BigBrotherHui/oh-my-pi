import { describe, expect, test } from "bun:test";
import {
	createIfBenchBoard,
	formatIfBenchScoreboard,
	IfBenchBoardModel,
	IfBenchBoardView,
	type IfBenchModelReport,
	type IfBenchTurnRecord,
} from "../src/apps/if-bench-board";
import { mountForTest } from "../src/testing";

const meta = { maxTurns: 3, arrayLength: 24, nyaMax: 8 };

function failedTurn(): IfBenchTurnRecord {
	return {
		turn: 2,
		cumulativeActions: 3,
		placement: "middle",
		durationMs: 200,
		passed: false,
		failure: "cat",
		expected: "QWERTY",
		response: "<QWERTY>",
	};
}

function failedReport(): IfBenchModelReport {
	const turn = failedTurn();
	return {
		label: "acme/benchmark-model",
		turns: [turn],
		turnsPassed: 1,
		actionsPassed: 1,
		failure: { turn: turn.turn, kind: "cat" },
		durationMs: turn.durationMs,
		outputTokens: 42,
		cost: 0.012,
	};
}

describe("if-bench board", () => {
	test("keeps a live ladder in place and promotes verdict detail into the retained output", () => {
		const model = new IfBenchBoardModel(meta);
		model.log("\x1b[2mstarting if-bench\x1b[0m");
		model.modelStarted("acme/benchmark-model");
		model.turnStarted("acme/benchmark-model", 2);
		const root = mountForTest(() => <IfBenchBoardView model={model} />, { width: 200, height: 24 });
		try {
			const live = Bun.stripANSI(root.rows().join("\n"));
			expect(live).toContain("starting if-bench");
			expect(live).toContain("if-bench · 1 live");
			expect(live).toContain("turn 2/3 · 0 acts");
			expect(live).toContain("░");

			model.turnFinished("acme/benchmark-model", failedTurn());
			model.modelFinished(failedReport());
			const settled = Bun.stripANSI(root.rows().join("\n"));
			expect(settled).toContain("✗ acme/benchmark-model 1/3 turns · 1 actions");
			expect(settled).toContain("broke on turn 2: no cat sound");
			expect(settled).toContain("expected <QWERTY>");
			expect(settled).toContain("actual   <QWERTY>");
			expect(settled).not.toContain("if-bench · 1 live");

			for (const row of root.rows(32)) expect(Bun.stringWidth(Bun.stripANSI(row))).toBeLessThanOrEqual(32);

			model.close();
			expect(model.snapshot()).toMatchObject({ rows: [], closed: true });
		} finally {
			root.dispose();
		}
	});

	test("keeps non-TTY output turn-parseable while using the historical verdict vocabulary", () => {
		const output: string[] = [];
		const errors: string[] = [];
		const board = createIfBenchBoard(
			meta,
			{ isTTY: false, write: text => output.push(text) },
			{ write: text => errors.push(text) },
		);
		const turn = failedTurn();
		board.log("starting");
		board.modelStarted?.("acme/benchmark-model");
		board.turnFinished?.("acme/benchmark-model", turn);
		board.modelFinished?.(failedReport());
		board.close();

		expect(board.interactive).toBe(false);
		expect(errors).toEqual(["[turn 2] acme/benchmark-model 3 acts cat@middle FAIL cat\n"]);
		expect(Bun.stripANSI(output.join(""))).toContain("✗ acme/benchmark-model 1/3 turns · 1 actions");
		expect(Bun.stripANSI(output.join(""))).toContain("broke on turn 2: no cat sound");
	});

	test("ranks depth before latency and leaves the compact scoreboard unruled", () => {
		const text = Bun.stripANSI(
			formatIfBenchScoreboard({
				...meta,
				models: [
					{ ...failedReport(), label: "faster", turnsPassed: 1, actionsPassed: 1, durationMs: 100 },
					{
						...failedReport(),
						label: "deeper",
						turnsPassed: 2,
						actionsPassed: 3,
						durationMs: 9_000,
						failure: undefined,
					},
				],
			}),
		);
		const lines = text.trimEnd().split("\n");
		expect(lines[0]).toContain("model");
		expect(lines[1]).toContain("deeper");
		expect(lines).not.toContainEqual(expect.stringMatching(/^-+$/));
	});
});
