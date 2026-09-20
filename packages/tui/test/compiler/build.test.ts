import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { createSolidJsxEntrypointPlugin, solidJsxPlugin } from "../../src/compiler/solid-jsx-plugin";

const memoryRendererPath = join(import.meta.dir, "memory-renderer.ts");

async function execute(command: string[], cwd: string): Promise<string> {
	const child = Bun.spawn(command, { cwd, stderr: "pipe", stdout: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	assert.equal(exitCode, 0, stderr);
	return stdout;
}

test("plugin bundles, compiles, and embeds runtime TSX registration", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-tui-solid-build-"));
	const entrypoint = join(directory, "entry.tsx");
	const executable = join(directory, "compiled-entry");
	const dynamicExtensionPath = join(directory, "dynamic-extension.tsx");
	const packageRoot = join(directory, "node_modules", "@oh-my-pi", "pi-tui");
	const rendererAlias: BunPlugin = {
		name: "compiler-test-renderer",
		setup(build) {
			build.onResolve({ filter: /^@oh-my-pi\/pi-tui\/host\/renderer$/ }, () => ({
				path: memoryRendererPath,
			}));
		},
	};
	const source = `
import { createSignal } from "solid-js";
import { createMemoryRoot, renderMemory } from ${JSON.stringify(memoryRendererPath)};
async function main() {
const root = createMemoryRoot();
const [count, setCount] = createSignal(0);
let viewRuns = 0;
const dispose = renderMemory(() => {
	viewRuns++;
	return <compiler-fixture>{count()}</compiler-fixture>;
}, root);
const text = root.children[0]?.children[0];
setCount(1);
if (!text || text.text !== "1" || root.children[0]?.children[0] !== text || viewRuns !== 1) {
	throw new Error("built TSX did not retain its reactive text node");
}
dispose();
// Runtime-selected by design: the compiled graph must use its embedded Bun.plugin registration.
const extensionPath = [${JSON.stringify(dynamicExtensionPath)}].join("");
const extension = await import(extensionPath);
if (extension.node?.type !== "probe") throw new Error("runtime TSX was not transformed");
// Bun folds import.meta.main to false in non-entry modules; a wrapper entry would break launch guards.
if (!import.meta.main) throw new Error("entry module lost import.meta.main");
console.log("SOLID_BUILD_OK");
}
void main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
`;
	try {
		await mkdir(join(packageRoot, "host"), { recursive: true });
		await Promise.all([
			writeFile(entrypoint, source),
			writeFile(dynamicExtensionPath, "export const node = <probe>runtime extension</probe>;\n"),
			writeFile(
				join(packageRoot, "package.json"),
				JSON.stringify({
					name: "@oh-my-pi/pi-tui",
					type: "module",
					exports: { "./host/renderer": "./host/renderer.js" },
				}),
			),
			writeFile(
				join(packageRoot, "host", "renderer.js"),
				[
					"export const createElement = type => ({ type, children: [] });",
					"export const createTextNode = text => ({ type: '#text', text: String(text), children: [] });",
					"export const insertNode = (parent, child) => parent.children.push(child);",
				].join("\n"),
			),
		]);
		const bundle = await Bun.build({
			entrypoints: [entrypoint],
			outdir: directory,
			target: "bun",
			conditions: ["browser"],
			plugins: [createSolidJsxEntrypointPlugin(entrypoint), rendererAlias, solidJsxPlugin],
			throw: false,
		});
		expect(bundle.success).toBe(true);
		expect(bundle.outputs).toHaveLength(1);
		expect(await execute([process.execPath, bundle.outputs[0]!.path], directory)).toContain("SOLID_BUILD_OK");

		const compiled = await Bun.build({
			entrypoints: [entrypoint],
			target: "bun",
			conditions: ["browser"],
			bytecode: true,
			plugins: [createSolidJsxEntrypointPlugin(entrypoint), rendererAlias, solidJsxPlugin],
			compile: {
				autoloadBunfig: false,
				autoloadDotenv: false,
				autoloadPackageJson: false,
				autoloadTsconfig: false,
				outfile: executable,
			},
			throw: false,
		});
		assert.equal(compiled.success, true, compiled.logs.map(log => log.message).join("\n"));
		expect(await execute([executable], directory)).toContain("SOLID_BUILD_OK");
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});
