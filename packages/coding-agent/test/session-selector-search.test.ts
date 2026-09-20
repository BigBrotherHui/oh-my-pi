import { describe, expect, it } from "bun:test";
import {
	createSessionSelectorController,
	rankSessionSearchMatches,
	type SessionSelectorEntry,
} from "@oh-my-pi/pi-tui/overlays/session-selector";

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

describe("session picker search", () => {
	it("filters incrementally and resets the active selection", () => {
		const sessions = [
			session("deploy", { title: "Deploy release", modified: new Date(3) }),
			session("rollback", { title: "Rollback release", modified: new Date(2) }),
			session("notes", { title: "Meeting notes", modified: new Date(1) }),
		];
		const controller = createSessionSelectorController(
			sessions,
			() => {},
			() => {},
			() => {},
		);

		for (const character of "release") controller.handleInput(character);
		expect(controller.query()).toBe("release");
		expect(controller.sessions().map(item => item.id)).toEqual(["deploy", "rollback"]);
		controller.handleInput("\x1b[B");
		expect(controller.selectedIndex()).toBe(1);
		controller.handleInput("\x7f");
		expect(controller.selectedIndex()).toBe(0);
	});

	it("ranks exact and title matches ahead of body matches", () => {
		const sessions = [
			session("body", { firstMessage: "dashboard", modified: new Date(5) }),
			session("partial", { title: "Dashboard notes", modified: new Date(4) }),
			session("exact", { title: "dashboard", modified: new Date(2) }),
		];
		expect(rankSessionSearchMatches(sessions, "dashboard").map(item => item.id)).toEqual([
			"exact",
			"partial",
			"body",
		]);
	});
});
