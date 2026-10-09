import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("read repeat evidence", () => {
	let directory: TempDir;
	let tool: ReadTool;

	beforeEach(async () => {
		directory = TempDir.createSync("@pi-read-repeat-evidence-");
		const session: ToolSession = {
			cwd: directory.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "edit.mode": "patch" }),
		};
		tool = new ReadTool(session);
		await Bun.write(path.join(directory.path(), "evidence.txt"), "original evidence\n");
	});

	afterEach(() => {
		directory.removeSync();
	});

	it("keeps underlying evidence stable across changing repeat hints and detects a file change", async () => {
		const first = await tool.execute("first", { path: "evidence.txt" });
		const hash = first.details?.repeatReadEvidenceHash;
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
		expect(first.details?.displayContent?.text).toContain("original evidence");
		for (let count = 2; count <= 5; count++) {
			const result = await tool.execute(`repeat-${count}`, { path: "evidence.txt" });
			expect(result.details?.repeatReadEvidenceHash).toBe(hash);
			expect(result.details?.displayContent).toEqual(first.details?.displayContent);
			const text = result.content.find(block => block.type === "text")?.text ?? "";
			if (count >= 3) {
				expect(text).toContain(`You have received this identical output ${count} times`);
				expect(result.content).not.toEqual(first.content);
			}
		}
		await Bun.write(path.join(directory.path(), "evidence.txt"), "changed evidence\n");
		const changed = await tool.execute("changed", { path: "evidence.txt" });
		expect(changed.details?.repeatReadEvidenceHash).not.toBe(hash);
		expect(changed.content.find(block => block.type === "text")?.text).not.toContain("identical output");
	});

	it("records stable evidence when speculative reads commit despite changing repeat hints", async () => {
		const policy = tool.speculation.finalized;
		if (!policy?.commit) throw new Error("read tool has no speculative commit policy");
		const args = { path: "evidence.txt" };
		const assessment = await policy.assess({ args });
		if (!assessment.eligible) throw new Error("expected speculative read admission");
		const hashes: unknown[] = [];
		for (let count = 1; count <= 4; count++) {
			const context = {
				toolCall: { type: "toolCall" as const, id: `speculative-${count}`, name: "read", arguments: args },
				args,
				effect: assessment.effect,
			};
			const outcome = await policy.execute(context, new AbortController().signal);
			const result = await policy.commit({ ...context, physicalOutcome: outcome }, outcome);
			const details = result.details as { repeatReadEvidenceHash?: string } | undefined;
			hashes.push(details?.repeatReadEvidenceHash);
			if (count >= 3) {
				expect(result.content.find(block => block.type === "text")?.text).toContain(
					`You have received this identical output ${count} times`,
				);
			}
		}
		expect(hashes[0]).toMatch(/^[a-f0-9]{64}$/);
		expect(new Set(hashes).size).toBe(1);
	});
});
