import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	markdownToPhases,
	nextActionableTask,
	phasesToMarkdown,
	resolveTodoMarkdownPath,
	TodoTool,
} from "@oh-my-pi/pi-coding-agent/tools";
import {
	selectCollapsedTodos,
	type TodoItem,
	type TodoPhase,
	todoMatchesAnyDescription,
} from "@oh-my-pi/pi-tui/tools/todo";

function createSession(initialPhases: TodoPhase[] = []): ToolSession {
	let phases = initialPhases;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
}

describe("resolveTodoMarkdownPath", () => {
	it("defaults to TODO.md under cwd", () => {
		const cwd = path.resolve("tmp", "todo-workspace");

		expect(resolveTodoMarkdownPath("", cwd)).toBe(path.join(cwd, "TODO.md"));
	});

	it("strips surrounding double quotes before resolving", () => {
		const cwd = path.resolve("tmp", "todo-workspace");

		expect(resolveTodoMarkdownPath('"my todos.md"', cwd)).toBe(path.join(cwd, "my todos.md"));
	});

	it("rejects internal URL schemes", () => {
		const cwd = path.resolve("tmp", "todo-workspace");

		expect(() => resolveTodoMarkdownPath("artifact://todo", cwd)).toThrow("internal scheme");
	});
});

describe("TodoTool auto-start behavior", () => {
	it("auto-starts the first task after init", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo");
		expect(summary.text).toContain("Remaining items (2):");
		expect(summary.text).toContain("status [in_progress] (Execution)");
		expect(summary.text).toContain("diagnostics [pending] (Execution)");
	});

	it("auto-promotes the next pending task when current task is completed", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
		});

		const result = await tool.execute("call-2", { op: "done", task: "status" });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
		expect(result.details?.completedTasks).toEqual([{ phase: "Execution", content: "status" }]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo");
		expect(summary.text).toContain("Remaining items (1):");
		expect(summary.text).toContain("diagnostics [in_progress] (Execution)");
		const completedResult = await tool.execute("call-3", { op: "done", task: "diagnostics" });
		const completedSummary = completedResult.content.find(part => part.type === "text");
		if (completedSummary?.type !== "text") {
			throw new Error("Expected text summary from todo");
		}
		expect(completedSummary.text).toContain("Remaining items: none.");
	});
});

describe("nextActionableTask", () => {
	it("returns the in-progress task before the first pending task across phases", () => {
		const task = nextActionableTask([
			{
				name: "First",
				tasks: [{ content: "queued first", status: "pending" }],
			},
			{
				name: "Second",
				tasks: [{ content: "active second", status: "in_progress" }],
			},
		]);

		expect(task?.content).toBe("active second");
	});

	it("falls back to the first pending task when nothing is in progress", () => {
		const task = nextActionableTask([
			{
				name: "Done",
				tasks: [{ content: "finished", status: "completed" }],
			},
			{
				name: "Next",
				tasks: [{ content: "first pending", status: "pending" }],
			},
		]);

		expect(task?.content).toBe("first pending");
	});
});

describe("TodoTool operations", () => {
	it("jumps to a specific task out of order", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Phase A", items: ["first", "second", "third"] }],
		});

		const result = await tool.execute("call-2", { op: "start", task: "third" });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
		expect(result.details?.op).toBe("start");
	});

	it("demotes the current in_progress task when starting another", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [
				{ phase: "A", items: ["a1", "a2"] },
				{ phase: "B", items: ["b1"] },
			],
		});

		const result = await tool.execute("call-2", { op: "start", task: "b1" });

		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
	});

	it("appends items to an existing phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = await tool.execute("call-2", {
			op: "append",
			phase: "Work",
			items: ["Second"],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => ({ content: task.content, status: task.status }))).toEqual([
			{ content: "First", status: "in_progress" },
			{ content: "Second", status: "pending" },
		]);
	});

	it("blocks a task (excluded from remaining, counted distinctly) and unblocks it", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["a", "b"] }] });

		const blocked = await tool.execute("call-2", { op: "block", task: "b", reason: "waiting on sign-off" });
		const bTask = blocked.details?.phases[0]?.tasks.find(task => task.content === "b");
		expect(bTask?.status).toBe("blocked");
		expect(bTask?.blocker).toBe("waiting on sign-off");
		const summary = blocked.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo");
		// `a` stays the only open item; `b` leaves the remaining/open set but is surfaced as blocked.
		expect(summary.text).toContain("Remaining items (1):");
		expect(summary.text).toContain("1 blocked");

		const unblocked = await tool.execute("call-3", { op: "unblock", task: "b" });
		const bAfter = unblocked.details?.phases[0]?.tasks.find(task => task.content === "b");
		expect(bAfter?.status).toBe("pending");
		expect(bAfter?.blocker).toBeUndefined();
	});

	it("does not auto-promote a blocked task to in_progress", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["only"] }] });

		const result = await tool.execute("call-2", { op: "block", task: "only" });

		// `only` was in_progress; blocking it leaves no pending/in_progress, so normalization must not revive it.
		expect(result.details?.phases[0]?.tasks[0]?.status).toBe("blocked");
	});

	it("blocking a phase leaves completed/abandoned tasks closed", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["a", "b", "c"] }] });
		await tool.execute("call-2", { op: "done", task: "a" });
		await tool.execute("call-3", { op: "drop", task: "c" });

		const result = await tool.execute("call-4", { op: "block", phase: "Work", reason: "waiting on infra" });
		const tasks = result.details?.phases[0]?.tasks ?? [];
		const byContent = (content: string) => tasks.find(task => task.content === content);
		// Completed/abandoned work is untouched; only the open task becomes blocked.
		expect(byContent("a")?.status).toBe("completed");
		expect(byContent("c")?.status).toBe("abandoned");
		expect(byContent("b")?.status).toBe("blocked");
		expect(byContent("b")?.blocker).toBe("waiting on infra");
		// A completed task must never carry a blocker note.
		expect(byContent("a")?.blocker).toBeUndefined();
	});

	it("re-blocking an already-blocked task refines its blocker note", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["a", "b"] }] });
		// First block with no reason, then block again to add one — the agent often
		// learns what it's waiting on only after the initial block.
		await tool.execute("call-2", { op: "block", task: "b" });
		const first = await tool.execute("call-3", { op: "block", task: "b" });
		expect(first.details?.phases[0]?.tasks.find(task => task.content === "b")?.blocker).toBeUndefined();

		const refined = await tool.execute("call-4", { op: "block", task: "b", reason: "waiting on user" });
		const bTask = refined.details?.phases[0]?.tasks.find(task => task.content === "b");
		expect(bTask?.status).toBe("blocked");
		expect(bTask?.blocker).toBe("waiting on user");
	});

	it("rejects a block with neither task nor phase target", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["a", "b"] }] });

		const result = await tool.execute("call-2", { op: "block", reason: "oops" });
		expect(result.isError).toBe(true);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo");
		expect(summary.text).toContain("block requires a task or phase target");
		// Nothing was blocked — state is unchanged.
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.every(task => task.status !== "blocked")).toBe(true);
	});

	it("rejects an unblock with neither task nor phase target", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["a"] }] });
		await tool.execute("call-2", { op: "block", task: "a", reason: "x" });

		const result = await tool.execute("call-3", { op: "unblock" });
		expect(result.isError).toBe(true);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo");
		expect(summary.text).toContain("unblock requires a task or phase target");
		// The blocked task stays blocked — the targetless unblock was rejected.
		expect(result.details?.phases[0]?.tasks[0]?.status).toBe("blocked");
	});

	it("preserves blocked status across the markdown round-trip", () => {
		const phases: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "a", status: "blocked", blocker: "x" },
					{ content: "b", status: "completed" },
				],
			},
		];
		const md = phasesToMarkdown(phases);
		expect(md).toContain("- [!] a");

		const { phases: parsed, errors } = markdownToPhases(md);
		expect(errors).toEqual([]);
		const parsedA = parsed[0]?.tasks.find(task => task.content === "a");
		expect(parsedA?.status).toBe("blocked");
		// The blocker reason must survive the round-trip, not just the status.
		expect(parsedA?.blocker).toBe("x");
	});

	it("parses checklist items with backslash-escaped brackets from /todo edit", () => {
		// Editors/serializers (e.g. content pasted from a markdown renderer) escape
		// `[` and `]`; the line still renders as a checkbox, so it must parse rather
		// than error out and drop the user's edits (issue #9188).
		const md = ["# Todos", "* \\[x] first", "- \\[ \\] second", "+ \\[/\\] third"].join("\n");
		const { phases, errors } = markdownToPhases(md);
		expect(errors).toEqual([]);
		const tasks = phases[0]?.tasks ?? [];
		expect(tasks).toEqual([
			{ content: "first", status: "completed" },
			{ content: "second", status: "pending" },
			{ content: "third", status: "in_progress" },
		]);
	});

	it("normalizes a multi-line blocker reason so the markdown round-trip survives", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["a"] }] });
		// A blocker reason lifted from a multi-line external error or user question.
		const blocked = await tool.execute("call-2", {
			op: "block",
			task: "a",
			reason: "waiting on user:\nline two\n\tindented three",
		});
		const phases = blocked.details?.phases ?? [];
		const stored = phases[0]?.tasks.find(task => task.content === "a");
		// Normalized at the source: whitespace runs (incl. newlines) collapse to
		// single spaces, so every one-line consumer stays intact.
		expect(stored?.blocker).toBe("waiting on user: line two indented three");

		// Without normalization the embedded newline splits the HTML comment across
		// two markdown lines: line one is an unclosed `<!-- blocker: …` and line two
		// parses as unrecognized syntax, losing the reason and adding an error.
		const md = phasesToMarkdown(phases);
		expect(md.split("\n").filter(line => line.includes("- [!]"))).toHaveLength(1);
		const { phases: parsed, errors } = markdownToPhases(md);
		expect(errors).toEqual([]);
		const parsedA = parsed[0]?.tasks.find(task => task.content === "a");
		expect(parsedA?.status).toBe("blocked");
		expect(parsedA?.blocker).toBe("waiting on user: line two indented three");
	});

	it("creates a phase when append targets a missing phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = await tool.execute("call-2", {
			op: "append",
			phase: "Cleanup",
			items: ["Remove dead code"],
		});

		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Work", "Cleanup"]);
		expect(result.details?.phases[1]?.tasks.map(task => task.content)).toEqual(["Remove dead code"]);
	});

	it("marks all tasks in a phase done", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [
				{ phase: "Work", items: ["First", "Second"] },
				{ phase: "Later", items: ["Third"] },
			],
		});

		const result = await tool.execute("call-2", { op: "done", phase: "Work" });
		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["completed", "completed", "in_progress"]);
	});

	it("removes all tasks when rm omits task and phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Work", items: ["First", "Second"] }],
		});

		const result = await tool.execute("call-2", { op: "rm" });
		expect(result.details?.phases[0]?.tasks).toEqual([]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Todo list cleared.");
	});

	it("drops all tasks in a phase", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", {
			op: "init",
			list: [{ phase: "Work", items: ["First", "Second"] }],
		});

		const result = await tool.execute("call-2", { op: "drop", phase: "Work" });
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["abandoned", "abandoned"]);
	});

	it("view echoes state without mutating it", async () => {
		const session = createSession([
			{
				name: "Work",
				tasks: [
					{ content: "First", status: "pending" },
					{ content: "Second", status: "pending" },
				],
			},
		]);
		const tool = new TodoTool(session);

		const result = await tool.execute("call-1", { op: "view" });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["pending", "pending"]);
		// A read never normalizes or writes session state back.
		expect(session.getTodoPhases?.()?.[0]?.tasks.map(task => task.status)).toEqual(["pending", "pending"]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("First");
		expect(summary.text).toContain("Second");
	});

	it("view on an empty list reports empty, not cleared", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { op: "view" });
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Todo list is empty.");
		expect(result.isError).toBeUndefined();
	});
});

describe("TodoTool provider schema", () => {
	it("advertises items for single-phase init and append", () => {
		expect(toolWireSchema(new TodoTool(createSession()))).toMatchObject({
			properties: {
				items: {
					description: "tasks for single-phase init or append",
				},
			},
		});
	});
});

describe("TodoTool lenient init shapes", () => {
	it("accepts a flattened init with bare items and no phase", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { op: "init", items: ["First", "Second"] });

		expect(result.isError).toBeUndefined();
		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Tasks"]);
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => ({ content: task.content, status: task.status }))).toEqual([
			{ content: "First", status: "in_progress" },
			{ content: "Second", status: "pending" },
		]);
	});

	it("honors a bare phase on a flattened init", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { op: "init", phase: "Cleanup", items: ["Remove dead code"] });

		expect(result.isError).toBeUndefined();
		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Cleanup"]);
		expect(result.details?.phases[0]?.tasks.map(task => task.content)).toEqual(["Remove dead code"]);
	});

	it("still errors when init has neither list nor items", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { op: "init" });

		expect(result.isError).toBe(true);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Missing list for init operation");
	});
});
describe("TodoTool lenient op recovery", () => {
	// Regression: models occasionally drop `op` while sending an otherwise
	// valid payload (e.g. `{list:[...]}`). The schema keeps `op` required, but
	// `lenientArgValidation` routes the raw args to execute(), which infers
	// the op for unambiguous shapes instead of failing the call.
	it("keeps op required at the schema boundary but lenient at execute", () => {
		const tool = new TodoTool(createSession());
		expect(tool.parameters({ list: [{ phase: "Fixes", items: ["One"] }] }) instanceof type.errors).toBe(true);
		expect(tool.lenientArgValidation).toBe(true);
	});

	it("infers init from a bare list payload", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", {
			list: [{ phase: "Fixes", items: ["Bytecompiler ordering", "Posix path fd handling"] }],
		} as never);

		expect(result.isError).toBeUndefined();
		expect(result.details?.op).toBe("init");
		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Fixes"]);
		expect(result.details?.phases[0]?.tasks.map(task => task.content)).toEqual([
			"Bytecompiler ordering",
			"Posix path fd handling",
		]);
	});

	it("infers append from phase plus items", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = await tool.execute("call-2", { phase: "Work", items: ["Second"] } as never);

		expect(result.isError).toBeUndefined();
		expect(result.details?.op).toBe("append");
		expect(result.details?.phases[0]?.tasks.map(task => task.content)).toEqual(["First", "Second"]);
	});

	it("infers init from bare items only when no todos exist", async () => {
		const fresh = new TodoTool(createSession());
		const initialized = await fresh.execute("call-1", { items: ["Only task"] } as never);
		expect(initialized.isError).toBeUndefined();
		expect(initialized.details?.op).toBe("init");

		// With existing todos the same shape is ambiguous (flat init would wipe
		// the list; append lacks a phase) and must error instead of guessing.
		const populated = new TodoTool(
			createSession([{ name: "Work", tasks: [{ content: "First", status: "pending" }] }]),
		);
		const ambiguous = await populated.execute("call-2", { items: ["Second"] } as never);
		expect(ambiguous.isError).toBe(true);
	});

	it("surfaces the schema error when op is missing and not inferable", async () => {
		const tool = new TodoTool(createSession());
		const result = await tool.execute("call-1", { task: "Something" } as never);

		expect(result.isError).toBe(true);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Invalid todo arguments");
		expect(summary.text).toContain("op");
	});
});

describe("TodoTool empty items tolerance", () => {
	// Regression: a stray `items: []` on an op that ignores items (here `view`)
	// must not be a hard schema rejection. The top-level `items` array dropped
	// its `atLeastLength(1)` so callers don't get "items must be tasks to append"
	// for an irrelevant empty array; length is enforced per-op at runtime.
	it("accepts op:view with an empty items array at the schema boundary", () => {
		const schema = new TodoTool(createSession()).parameters;
		expect(schema({ op: "view", items: [] }) instanceof type.errors).toBe(false);
	});

	it("defers empty append items to an op-specific runtime error", async () => {
		const tool = new TodoTool(createSession());
		await tool.execute("call-1", { op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = await tool.execute("call-2", { op: "append", phase: "Work", items: [] });

		expect(result.isError).toBe(true);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Missing items for append operation");
	});
});

describe("todoMatchesAnyDescription", () => {
	it("matches identical strings", () => {
		expect(todoMatchesAnyDescription("Sonnet #1: AGENTS audit", ["Sonnet #1: AGENTS audit"])).toBe(true);
	});

	it("matches case- and whitespace-insensitively", () => {
		expect(todoMatchesAnyDescription("  Sonnet  #1: AGENTS Audit  ", ["sonnet #1: agents audit"])).toBe(true);
	});

	it("matches when description is a long-enough substring of the todo", () => {
		expect(todoMatchesAnyDescription("Sonnet #2: shallow bug scan of diff", ["Sonnet #2"])).toBe(true);
	});

	it("matches when the todo is a long-enough substring of a description", () => {
		expect(todoMatchesAnyDescription("Sonnet #3", ["Sonnet #3: git blame / history check"])).toBe(true);
	});

	it("rejects substring matches below the minimum overlap", () => {
		// "Fix" is 3 chars — too short to qualify on either side.
		expect(todoMatchesAnyDescription("Fix", ["Fix the auth module bug"])).toBe(false);
		expect(todoMatchesAnyDescription("Fix the auth module bug", ["Fix"])).toBe(false);
	});

	it("ignores empty inputs without throwing", () => {
		expect(todoMatchesAnyDescription("", ["Sonnet #1"])).toBe(false);
		expect(todoMatchesAnyDescription("Sonnet #1", [""])).toBe(false);
		expect(todoMatchesAnyDescription("Sonnet #1", [])).toBe(false);
	});

	it("returns true on the first match without scanning further descriptions", () => {
		expect(
			todoMatchesAnyDescription("Sonnet #2: shallow bug scan", ["unrelated agent task", "Sonnet #2", "Sonnet #3"]),
		).toBe(true);
	});

	it("returns false when no description overlaps the todo", () => {
		expect(todoMatchesAnyDescription("Sonnet #2: shallow bug scan", ["Reviewer1AgentsAdherence", "git blame"])).toBe(
			false,
		);
	});

	it("ignores punctuation differences in identifiers", () => {
		// One side has a method-prefix '#', the other doesn't. Reproduced
		// from a real run where 3 subagents were spawned but only 2 of 3
		// matched todos lit up because the matcher's normalizer collapsed
		// whitespace but left punctuation intact.
		expect(
			todoMatchesAnyDescription("Audit integration site in renderTodoList", [
				"Audit integration site in #renderTodoList",
			]),
		).toBe(true);
		// Dotted abbreviations like AGENTS.md collapse to a space too.
		expect(todoMatchesAnyDescription("Audit AGENTS.md compliance", ["Audit AGENTS md compliance"])).toBe(true);
	});
});
describe("selectCollapsedTodos walking viewport (#5873)", () => {
	const mk = (n: number, inProgress: number[]): TodoItem[] =>
		Array.from({ length: n }, (_, i) => ({
			content: `Task ${i + 1}`,
			status: inProgress.includes(i + 1) ? "in_progress" : "pending",
		}));
	const never = () => false;
	const contents = (sel: { items: readonly TodoItem[] }) => sel.items.map(t => t.content);

	it("starts at the sole in-progress task and fills with following tasks", () => {
		const sel = selectCollapsedTodos(mk(14, [6]), never, 8);
		expect(contents(sel)).toEqual([
			"Task 6",
			"Task 7",
			"Task 8",
			"Task 9",
			"Task 10",
			"Task 11",
			"Task 12",
			"Task 13",
		]);
		expect(sel.summary).toContain("6 more todos");
	});

	it("leads with the last closed task and omits the rest in collapsed mode", () => {
		const tasks: TodoItem[] = [
			{ content: "done", status: "completed" },
			{ content: "dropped", status: "abandoned" },
			{ content: "current", status: "in_progress" },
			{ content: "next", status: "pending" },
		];
		const sel = selectCollapsedTodos(tasks, never, 5);
		// One closed row survives so a completion is visible as it lands; earlier
		// closed work stays hidden.
		expect(contents(sel)).toEqual(["dropped", "current", "next"]);
		expect(sel.summary).toBe("");
	});

	it("keeps an out-of-order completion as the closed lead row", () => {
		const tasks: TodoItem[] = [
			{ content: "current", status: "in_progress" },
			{ content: "next", status: "pending" },
			{ content: "finished early", status: "completed" },
		];
		const sel = selectCollapsedTodos(tasks, never, 5);
		expect(contents(sel)).toEqual(["finished early", "current", "next"]);
	});

	it("keeps the closed lead row additive to the open-task cap", () => {
		const tasks: TodoItem[] = [{ content: "closed", status: "completed" }, ...mk(5, [1])];
		const sel = selectCollapsedTodos(tasks, never, 5);
		// All 5 open tasks fit the cap; the closed context row does not evict one.
		expect(contents(sel)).toEqual(["closed", "Task 1", "Task 2", "Task 3", "Task 4", "Task 5"]);
		expect(sel.summary).toBe("");
	});

	it("places every subagent-matched todo at the head in todo order", () => {
		const tasks = mk(14, []); // all pending
		const matched = (t: TodoItem) => t.content === "Task 3" || t.content === "Task 9";
		const sel = selectCollapsedTodos(tasks, matched, 5);
		// Both matched actives lead, then following pending fill from the first active.
		expect(contents(sel).slice(0, 2)).toEqual(["Task 3", "Task 9"]);
		expect(contents(sel)).toHaveLength(5);
	});

	it("caps active todos and counts the hidden actives in the summary", () => {
		const tasks = mk(10, []);
		const matched = (t: TodoItem) =>
			["Task 1", "Task 2", "Task 3", "Task 4", "Task 5", "Task 6", "Task 7"].includes(t.content);
		const sel = selectCollapsedTodos(tasks, matched, 5);
		expect(contents(sel)).toEqual(["Task 1", "Task 2", "Task 3", "Task 4", "Task 5"]);
		expect(sel.summary).toBe("… 2 more active todos");
		// No unrelated pending rows leak in.
		expect(contents(sel).some(c => ["Task 8", "Task 9", "Task 10"].includes(c))).toBe(false);
	});

	it("keeps a summary when actives exactly fill the cap but pending remains", () => {
		// 5 matched actives + 1 trailing pending, cap 5. The active-overflow branch
		// must NOT swallow the hidden pending work with an empty summary (#5878).
		const tasks = mk(6, []);
		const matched = (t: TodoItem) => ["Task 1", "Task 2", "Task 3", "Task 4", "Task 5"].includes(t.content);
		const sel = selectCollapsedTodos(tasks, matched, 5);
		expect(contents(sel)).toEqual(["Task 1", "Task 2", "Task 3", "Task 4", "Task 5"]);
		expect(sel.summary).toBe("… 1 more todo");
	});

	it("returns the whole open set with no summary when it fits", () => {
		const sel = selectCollapsedTodos(mk(3, [2]), never, 5);
		expect(contents(sel)).toEqual(["Task 1", "Task 2", "Task 3"]);
		expect(sel.summary).toBe("");
	});

	it("falls back to closed tasks when the phase has no open work", () => {
		const tasks: TodoItem[] = [
			{ content: "done a", status: "completed" },
			{ content: "done b", status: "completed" },
		];
		const sel = selectCollapsedTodos(tasks, never, 5);
		expect(contents(sel)).toEqual(["done a", "done b"]);
	});
});
