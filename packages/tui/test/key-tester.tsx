#!/usr/bin/env bun
import { matchesKey } from "@oh-my-pi/pi-tui/keys";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import type { HostKeyEvent } from "../src/host/input";
import { For, createSignal } from "../src/reactive";
import { render } from "../src/root";
import { loadThemeSync } from "../src/theme/loader";

const maxLines = 20;
const terminal = new ProcessTerminal();
const [entries, setEntries] = createSignal<readonly string[]>([]);
let exiting = false;

function formatKey(data: string): string {
	const hex = Buffer.from(data).toString("hex");
	const charCodes = Array.from(data)
		.map(char => char.charCodeAt(0))
		.join(", ");
	const repr = data
		.replace(/\x1b/g, "\\x1b")
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n")
		.replace(/\t/g, "\\t")
		.replace(/\x7f/g, "\\x7f");

	return `Hex: ${hex.padEnd(20)} | Chars: [${charCodes.padEnd(15)}] | Repr: "${repr}"`;
}

function exit(): void {
	if (exiting) return;
	exiting = true;
	root?.dispose();
	console.log("\nExiting...");
	process.exit(0);
}

function logKey(event: HostKeyEvent): void {
	event.preventDefault();
	if (matchesKey(event.data, "ctrl+c")) {
		exit();
		return;
	}
	setEntries(current => [...current.slice(-(maxLines - 1)), formatKey(event.data)]);
}

const root = render(
	() => (
		<stack>
			<text>Key Code Tester — Press keys to see their codes (Ctrl+C to exit)</text>
			<text>{entries().length === 0 ? "Press a key to begin…" : ""}</text>
			<For each={entries()}>{entry => <text>{entry}</text>}</For>
			<input prompt="" placeholder="Press a key…" useTerminalCursor onKey={logKey} />
			<text>Test these:</text>
			<text> - Shift + Enter (should show: \x1b[13;2u with Kitty protocol)</text>
			<text> - Alt/Option + Enter</text>
			<text> - Option/Alt + Backspace</text>
			<text> - Cmd/Ctrl + Backspace</text>
			<text> - Regular Backspace</text>
		</stack>
	),
	{ terminal, theme: loadThemeSync("dark") },
);
root.tui.setShowHardwareCursor(true);

process.on("SIGINT", exit);
