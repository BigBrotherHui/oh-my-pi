import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	createSessionSelectorController,
	mergeSessionRanking,
	rankSessionSearchMatches,
	type SessionSelectorEntry,
} from "../src/overlays/session-selector";

function session(id: string, overrides: Partial<SessionSelectorEntry> = {}): SessionSelectorEntry {
	return {
		id,
		path: `/sessions/${id}.jsonl`,
		cwd: "/work/project",
		title: id,
		modified: new Date(0),
		size: 1,
		firstMessage: "",
		allMessagesText: "",
		...overrides,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("session selector", () => {
	it("ranks exact titles before partial titles and lower-priority body matches", () => {
		const sessions = [
			session("body", { firstMessage: "dashboard", modified: new Date(5) }),
			session("partial", { title: "Dashboard notes", modified: new Date(4) }),
			session("exact", { title: "  DASHBOARD  ", modified: new Date(2) }),
		];

		expect(rankSessionSearchMatches(sessions, "dashboard").map(item => item.id)).toEqual([
			"exact",
			"partial",
			"body",
		]);
	});

	it("merges transcript-history matches without dropping metadata matches", () => {
		const alpha = session("alpha");
		const bravo = session("bravo");
		const charlie = session("charlie");

		expect(
			mergeSessionRanking([alpha, bravo, charlie], [bravo, alpha], ["charlie", "alpha", "charlie"]).map(
				item => item.id,
			),
		).toEqual(["charlie", "alpha", "bravo"]);
	});

	it("focuses the live session, resets to the top search hit, and restores live focus when the filter clears", () => {
		const alpha = session("alpha", { title: "Alpha work", modified: new Date(3) });
		const live = session("live", { title: "Beta live", modified: new Date(2) });
		const other = session("other", { title: "Alpha other", modified: new Date(1) });
		const controller = createSessionSelectorController(
			[alpha, live, other],
			() => {},
			() => {},
			() => {},
			{
				currentSessionPath: live.path,
			},
		);

		expect(controller.selectedIndex()).toBe(1);
		for (const character of "alpha") controller.handleInput(character);
		expect(controller.sessions().map(item => item.id)).toEqual(["alpha", "other"]);
		expect(controller.selectedIndex()).toBe(0);
		for (const character of "alpha") controller.handleInput("\x7f");
		expect(controller.query()).toBe("");
		expect(controller.selectedIndex()).toBe(1);
	});

	it("loads the all-projects scope once, keeps the returned records, and returns to folder scope", async () => {
		const local = session("local", { cwd: "/work/current" });
		const remote = session("remote", { cwd: "/work/other-project" });
		let loads = 0;
		const controller = createSessionSelectorController(
			[local],
			() => {},
			() => {},
			() => {},
			{
				loadAllSessions: async () => {
					loads++;
					return [local, remote];
				},
			},
		);

		controller.handleInput("\t");
		await Promise.resolve();
		expect(controller.scope()).toBe("all");
		expect(controller.sessions().map(item => item.cwd)).toEqual(["/work/current", "/work/other-project"]);
		expect(loads).toBe(1);

		controller.handleInput("\t");
		expect(controller.scope()).toBe("folder");
		controller.handleInput("\t");
		expect(controller.scope()).toBe("all");
		expect(loads).toBe(1);
	});

	it("requires confirmation before deletion and preserves the selected filtered neighbor after success", async () => {
		const alpha = session("alpha", { title: "Alpha one" });
		const bravo = session("bravo", { title: "Alpha two" });
		const charlie = session("charlie", { title: "Alpha three" });
		const deleted: string[] = [];
		const controller = createSessionSelectorController(
			[alpha, bravo, charlie],
			() => {},
			() => {},
			() => {},
			{
				onDelete: async item => {
					deleted.push(item.id);
					return true;
				},
			},
		);

		for (const character of "alpha") controller.handleInput(character);
		controller.handleInput("\x1b[B");
		// Backspace edits a nonempty search query; forward Delete requests the
		// historical destructive confirmation without discarding that filter.
		controller.handleInput("\x1b[3~");
		expect(controller.confirming()?.id).toBe("bravo");
		controller.handleInput("\n");
		await Promise.resolve();
		await Promise.resolve();

		expect(deleted).toEqual(["bravo"]);
		expect(controller.confirming()).toBeUndefined();
		expect(controller.sessions().map(item => item.id)).toEqual(["alpha", "charlie"]);
		expect(controller.selectedIndex()).toBe(1);
	});

	it("keeps the row when deletion fails and surfaces the failure after closing confirmation", async () => {
		const alpha = session("alpha");
		const controller = createSessionSelectorController(
			[alpha],
			() => {},
			() => {},
			() => {},
			{
				onDelete: async () => {
					throw new Error("disk failed");
				},
			},
		);

		controller.handleInput("\x7f");
		controller.handleInput("\n");
		await Promise.resolve();
		await Promise.resolve();

		expect(controller.confirming()).toBeUndefined();
		expect(controller.sessions()).toEqual([alpha]);
		expect(controller.error()).toBe("Error: disk failed");
	});

	it("ignores input while resume is locked and accepts the host's later retry", () => {
		const selected: string[] = [];
		const controller = createSessionSelectorController(
			[session("alpha")],
			item => selected.push(item.id),
			() => {},
			() => {},
		);

		controller.lockInput();
		controller.handleInput("\n");
		controller.handleInput("\x1b");
		expect(selected).toEqual([]);

		controller.unlockInput();
		controller.handleInput("\n");
		expect(selected).toEqual(["alpha"]);
	});

	it("cancels pending history work when dismissed", () => {
		vi.useFakeTimers();
		const matcher = vi.fn(() => ["alpha"]);
		const controller = createSessionSelectorController(
			[session("alpha", { title: "Alpha result" })],
			() => {},
			() => {},
			() => {},
			{
				historyMatcher: matcher,
			},
		);

		for (const character of "alpha") controller.handleInput(character);
		controller.cancel();
		vi.advanceTimersByTime(150);

		expect(matcher).not.toHaveBeenCalled();
	});
});
