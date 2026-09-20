import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/tools";
import { ReadTool } from "../src/tools/read";

await Settings.init({ inMemory: true });

async function benchStepAsync(reps: number, fn: () => Promise<unknown>): Promise<number> {
	const start = Bun.nanoseconds();
	for (let i = 0; i < reps; i++) await fn();
	return (Bun.nanoseconds() - start) / 1e6 / reps;
}

// ── E4: tool read/parse redundancy ──────────────────────────────────────────
//
// E4 root cause: the read tool re-parses (tree-sitter `summarizeCode`, ~12-18ms
// for a ~1500-line file) on every summary read of the same unchanged file. E4-ii
// memoizes the parse per session keyed on the content hash of the freshly-read
// bytes, so a repeat read of the same file reuses the parse (the file is still
// read fresh, so the result stays correct). A repeated same-session summary read
// should drop from ~17ms to a few ms; a fresh session each call stays full cost.
console.log("\ntoolReadReparse (E4: repeat summary read, memoized parse vs cold):");
try {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-e4-"));
	const file = path.join(dir, "big.ts");
	let src = "";
	for (let i = 0; i < 375; i++) {
		src += `export function fn${i}(a: number, b: string): boolean {\n  const x = a + ${i};\n  return x > 0 && b.length === ${i};\n}\n`;
	}
	fs.writeFileSync(file, src);
	const mkSession = (): ToolSession =>
		({
			cwd: dir,
			hasUI: false,
			getSessionFile: () => path.join(dir, "s.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(dir, "sess"),
			allocateOutputArtifact: async (t: string) => ({ id: "a", path: path.join(dir, `a.${t}.log`) }),
			settings: Settings.isolated(),
		}) as unknown as ToolSession;
	const sameSession = mkSession();
	const rt = new ReadTool(sameSession);
	for (let i = 0; i < 3; i++) await rt.execute("warm", { path: file });
	const repeatMs = await benchStepAsync(20, () => rt.execute("c", { path: file }));
	const coldMs = await benchStepAsync(20, () => new ReadTool(mkSession()).execute("c", { path: file }));
	console.log(`  same-session repeat read: ${repeatMs.toFixed(3)}ms/call (memoized parse)`);
	console.log(`  fresh-session each read:  ${coldMs.toFixed(3)}ms/call (cold parse)`);
	fs.rmSync(dir, { recursive: true, force: true });
} catch (err) {
	console.log(`  (skipped: ${(err as Error).message})`);
}
