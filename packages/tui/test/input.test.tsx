import { afterEach, describe, expect, it } from "bun:test";
import { dispatchPaste } from "../src/host/input";
import { dispatchHostInput } from "../src/host/overlay";
import { createSignal, type Accessor } from "../src/reactive";
import { render } from "../src/root";
import { mountForTest, type TestRoot } from "../src/testing";
import { loadThemeSync } from "../src/theme/loader";
import { setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import {
	resetHangulCompatibilityJamoWidthForTests,
	setHangulCompatibilityJamoWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui/utils";
import { DEFAULT_TAB_WIDTH } from "@oh-my-pi/pi-utils";
import { cellGrid } from "./cell-grid";
import { VirtualTerminal } from "./virtual-terminal";

interface InputOptions {
	readonly value?: string;
	readonly width?: number;
	readonly prompt?: string;
	readonly mask?: boolean;
	readonly useTerminalCursor?: boolean;
	readonly onSubmit?: (value: string) => void;
}

interface MountedInput {
	readonly root: TestRoot;
	readonly value: Accessor<string>;
	send(data: string): void;
	paste(text: string): void;
}

interface TerminalInput {
	readonly terminal: VirtualTerminal;
	readonly value: Accessor<string>;
	send(data: string): void;
	render(): void;
}

describe("retained input", () => {
	const wordLeft = "\x1bb"; // ESC-b (alt+b)
	const wordRight = "\x1bf"; // ESC-f (alt+f)
	const dispose: (() => void)[] = [];

	function mountInput(options: InputOptions = {}): MountedInput {
		const [value, setValue] = createSignal(options.value ?? "");
		const root = mountForTest(
			() => (
				<input
					prompt={options.prompt}
					value={value()}
					mask={options.mask}
					useTerminalCursor={options.useTerminalCursor}
					onChange={setValue}
					onSubmit={options.onSubmit}
				/>
			),
			{ width: options.width },
		);
		dispose.push(() => root.dispose());
		return {
			root,
			value,
			send(data) {
				dispatchHostInput(root.root, data);
			},
			paste(text) {
				dispatchPaste(root.root, text);
			},
		};
	}

	function renderInput(options: InputOptions = {}): TerminalInput {
		const terminal = new VirtualTerminal(options.width ?? 80, 4);
		const [value, setValue] = createSignal(options.value ?? "");
		const root = render(
			() => (
				<input
					prompt={options.prompt}
					value={value()}
					mask={options.mask}
					useTerminalCursor={options.useTerminalCursor}
					onChange={setValue}
					onSubmit={options.onSubmit}
				/>
			),
			{ terminal, theme: loadThemeSync("dark") },
		);
		root.tui.setShowHardwareCursor(true);
		dispose.push(() => root.dispose());
		return {
			terminal,
			value,
			send(data) {
				terminal.sendInput(data);
			},
			render() {
				root.tui.renderNow();
			},
		};
	}

	function setupAtEnd(text: string): MountedInput {
		const input = mountInput({ value: text });
		input.send("\x05"); // Ctrl+E (end)
		return input;
	}

	function renderedWidth(input: MountedInput, width: number): number {
		return visibleWidth(input.root.rows(width)[0] ?? "");
	}

	afterEach(() => {
		while (dispose.length > 0) dispose.pop()?.();
		setKittyProtocolActive(false);
		resetHangulCompatibilityJamoWidthForTests();
	});

	it("moves by CJK and punctuation blocks backward", () => {
		const text = "天气不错，去散步吧！";
		const cases = [
			[1, "天气不错，去散步吧|！"],
			[2, "天气不错，|去散步吧！"],
			[3, "天气不错|，去散步吧！"],
			[4, "|天气不错，去散步吧！"],
		] as const;

		for (const [moves, expected] of cases) {
			const input = setupAtEnd(text);
			for (let move = 0; move < moves; move++) input.send(wordLeft);
			input.send("|");
			expect(input.value()).toBe(expected);
		}
	});

	it("moves by CJK and punctuation blocks forward", () => {
		const input = mountInput({ value: "天气不错，去散步吧！" });
		input.send("\x01"); // Ctrl+A (start)
		input.send(wordRight);
		input.send("|");
		expect(input.value()).toBe("天气不错|，去散步吧！");
	});

	it("treats NBSP as whitespace for word navigation", () => {
		const nbsp = "\u00A0";
		const input = setupAtEnd(`Hola${nbsp}mundo`);
		input.send(wordLeft);
		input.send("|");
		expect(input.value()).toBe(`Hola${nbsp}|mundo`);
	});

	it("keeps common joiners inside words", () => {
		const text = "co-operate l’été";
		const oneMove = setupAtEnd(text);
		oneMove.send(wordLeft);
		oneMove.send("|");
		expect(oneMove.value()).toBe("co-operate |l’été");

		const twoMoves = setupAtEnd(text);
		twoMoves.send(wordLeft);
		twoMoves.send(wordLeft);
		twoMoves.send("|");
		expect(twoMoves.value()).toBe("|co-operate l’été");
	});

	it("recognizes Unicode punctuation as delimiter blocks", () => {
		const text = "¿Cómo estás? ¡Muy bien!";
		const oneMove = setupAtEnd(text);
		oneMove.send(wordLeft);
		oneMove.send("|");
		expect(oneMove.value()).toBe("¿Cómo estás? ¡Muy bien|!");

		const twoMoves = setupAtEnd(text);
		twoMoves.send(wordLeft);
		twoMoves.send(wordLeft);
		twoMoves.send("|");
		expect(twoMoves.value()).toBe("¿Cómo estás? ¡Muy |bien!");
	});

	it("does not delete twice when Kitty sends backspace press and release", () => {
		setKittyProtocolActive(true);
		const input = setupAtEnd("ab");
		input.send("\x1b[127u");
		expect(input.value()).toBe("a");
		input.send("\x1b[127;1:3u");
		expect(input.value()).toBe("a");
	});

	it("inserts keypad digits from Kitty CSI-u input with or without NumLock modifier", () => {
		setKittyProtocolActive(true);
		const input = setupAtEnd("a");
		input.send("\x1b[57407u");
		input.send("\x1b[57407;129u");
		input.send("\x1b[57404u");
		expect(input.value()).toBe("a885");
	});

	it("inserts keypad operators from Kitty CSI-u input", () => {
		setKittyProtocolActive(true);
		const input = setupAtEnd("a");
		input.send("\x1b[57410u");
		expect(input.value()).toBe("a/");
	});

	it("normalizes tabs in buffered bracketed paste using the fixed display width", () => {
		const input = setupAtEnd("");
		input.send("\x1b[200~a\t");
		expect(input.value()).toBe("");
		input.send("b\r\n");
		expect(input.value()).toBe("");
		input.send("c\x1b[201~");
		expect(input.value()).toBe(`a${" ".repeat(DEFAULT_TAB_WIDTH)}bc`);
	});

	it("strips tmux re-encoded controls from bracketed paste", () => {
		const input = setupAtEnd("");
		input.send("\x1b[200~ab\x1b[27;5;106~cd\x1b[201~");
		expect(input.value()).toBe("abcd");

		const second = setupAtEnd("");
		second.send("\x1b[200~x\x1b[27;5;97~y\x1b[201~");
		expect(second.value()).toBe("xy");
	});

	it("never renders a wide line beyond the terminal viewport", () => {
		const input = setupAtEnd("天气不错，去散步吧！".repeat(50));
		expect(renderedWidth(input, 40)).toBeLessThanOrEqual(40);
	});

	it("clips an oversized prompt without losing the editable value after resize", () => {
		const input = mountInput({ value: "retained", prompt: "Prompt: " });
		expect(renderedWidth(input, 1)).toBeLessThanOrEqual(1);
		expect(Bun.stripANSI(input.root.rows(20)[0] ?? "")).toContain("retained");
	});

	it("masks one bullet per grapheme without changing the submitted value", () => {
		let submitted = "";
		const input = mountInput({
			value: "a😀e\u0301z",
			mask: true,
			onSubmit(value) {
				submitted = value;
			},
		});
		input.send("\x01"); // Ctrl+A (start)
		input.send("\x1b[C"); // after a
		input.send("\x1b[C"); // after emoji

		const [line] = input.root.rows(20);
		expect(Bun.stripANSI(line ?? "").trimEnd()).toBe("> ••••");
		expect(line).not.toContain(input.value());
		input.send("\n");
		expect(submitted).toBe("a😀e\u0301z");
	});

	it("does not disclose masked input on the terminal surface", () => {
		const value = crypto.randomUUID();
		const input = mountInput({ value, mask: true });
		expect(input.root.rows(80).join("\n")).not.toContain(value);
		expect(input.value()).toBe(value);
	});

	it("keeps masked Unicode input within narrow viewports", () => {
		const input = mountInput({ value: "😀e\u0301".repeat(20), mask: true });
		expect(renderedWidth(input, 12)).toBeLessThanOrEqual(12);
	});

	it("renders non-secret input unchanged when masking is disabled", () => {
		const input = setupAtEnd("visible-value");
		expect(Bun.stripANSI(input.root.rows(30)[0] ?? "")).toContain("visible-value");
	});

	it("normalizes NFD Korean pastes from macOS Finder drag-drop", () => {
		const nfcPath = "/Users/leo/Downloads/화면.mov";
		const nfdPath = nfcPath.normalize("NFD");
		expect(nfdPath).not.toBe(nfcPath);
		expect(nfdPath.length).toBeGreaterThan(nfcPath.length);

		const input = mountInput();
		input.send(`\x1b[200~${nfdPath}\x1b[201~`);
		expect(input.value()).toBe(nfcPath);
	});

	it("anchors the cursor at the NFC paste width", () => {
		const input = renderInput({ width: 120, useTerminalCursor: true });
		const nfdPath = "/Users/leo/화면\\ 기록.mov".normalize("NFD");
		input.send(`\x1b[200~${nfdPath}\x1b[201~`);
		input.render();

		const row = input.terminal.getViewport().findIndex(line => line.includes(input.value()));
		expect(row).toBeGreaterThanOrEqual(0);
		expect(input.terminal.getCursor()).toEqual({ row, col: 2 + visibleWidth(input.value()) });
	});

	it("uses a terminal cursor anchor without inverse-video software cursor", () => {
		const input = mountInput({ value: "abc", useTerminalCursor: true });
		input.send("\x01"); // Ctrl+A (start)
		const cells = cellGrid(input.root.rows(20), 20)[0] ?? [];
		expect(
			cells
				.slice(2, 5)
				.map(cell => cell.ch)
				.join(""),
		).toBe("abc");
		expect(cells.every(cell => !cell.attrs.inverse)).toBeTrue();

		const terminalInput = renderInput({ value: "abc", width: 20, useTerminalCursor: true });
		terminalInput.send("\x01");
		terminalInput.render();
		const row = terminalInput.terminal.getViewport().findIndex(line => line.includes("abc"));
		expect(terminalInput.terminal.isCursorVisible()).toBe(true);
		expect(terminalInput.terminal.getCursor()).toEqual({ row, col: 2 });
	});

	it("tracks the runtime jamo width in the terminal cursor anchor", () => {
		const jamo = "ㅁ".repeat(8);
		setHangulCompatibilityJamoWidth(1);
		const narrow = renderInput({ value: jamo, width: 80, useTerminalCursor: true });
		narrow.render();
		expect(narrow.terminal.getCursor().col).toBe(2 + 8);

		setHangulCompatibilityJamoWidth(2);
		const wide = renderInput({ value: jamo, width: 80, useTerminalCursor: true });
		wide.render();
		expect(wide.terminal.getCursor().col).toBe(2 + 16);
	});

	it("pastes non-bracketed clipboard text through the retained focused input", () => {
		const input = mountInput();
		input.paste("sk-line1\nsk-line2\r\nsk-line3");
		expect(input.value()).toBe("sk-line1sk-line2sk-line3");
	});
});
