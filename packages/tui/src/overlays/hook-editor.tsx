import { createSignal, onCleanup, onMount, useFocus, type Accessor, type JSX } from "../reactive";
import { BracketedPasteHandler } from "../bracketed-paste";
import { Editor } from "../components/editor";
import { matchesKey } from "../keys";
import { matchesAppExternalEditor, matchesAppFollowUp, matchesAppInterrupt } from "../keybinding-matchers";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent } from "../host/input";
import { getEditorTheme } from "../theme/theme";
import type { SizeValue, TUI } from "../tui";

export interface HookEditorOptions {
	externalEditor?: (text: string) => Promise<string | null>;
	promptStyle?: boolean;
	maxHeight?: number;
	width?: SizeValue;
}

export interface HookEditorController {
	readonly value: Accessor<string>;
	readonly editor: Editor;
	handleInput(data: string): void;
	pasteText(text: string): void;
	beginPaste(): (text: string | undefined) => boolean;
	cancel(): void;
	dispose(): void;
}

function editorHint(promptStyle: boolean): string {
	return promptStyle
		? "enter or ctrl+q submit  esc cancel  ctrl+g external editor"
		: "ctrl+q/ctrl+enter submit  esc cancel  ctrl+g external editor";
}

function createHookEditorControllerInternal(
	tui: TUI,
	prefill: string | undefined,
	onSubmit: (value: string) => void,
	onCancel: () => void,
	options: HookEditorOptions,
	onDismiss?: () => void,
): HookEditorController {
	const editor = new Editor(getEditorTheme());
	const promptStyle = options.promptStyle ?? false;
	if (promptStyle) {
		editor.setBorderVisible(false);
		editor.setPromptGutter("> ");
		editor.disableSubmit = true;
	}
	const terminalRows = tui.terminal?.rows ?? process.stdout.rows ?? 40;
	editor.setMaxHeight(options.maxHeight ?? Math.max(3, terminalRows - 12));
	editor.setScrollbarVisible(true);
	if (prefill) editor.setText(prefill);

	const [value, setValue] = createSignal(editor.getExpandedText());
	const pasteHandler = new BracketedPasteHandler();
	const pendingPastes: { settled: boolean; text: string | undefined }[] = [];
	let submitQueued = false;
	let disposed = false;
	const sync = (): void => {
		setValue(editor.getExpandedText());
	};
	const finish = (callback: (text: string) => void, requireText = false): void => {
		if (disposed) return;
		if (pendingPastes.length > 0) {
			submitQueued = true;
			return;
		}
		const text = editor.getExpandedText();
		if (requireText && text.trim().length === 0) return;
		disposed = true;
		onDismiss?.();
		callback(text);
	};
	const cancel = (): void => {
		if (disposed) return;
		disposed = true;
		onDismiss?.();
		onCancel();
	};
	const pasteText = (text: string): void => {
		if (disposed) return;
		if (pendingPastes.length > 0) {
			controller.beginPaste()(text);
			return;
		}
		editor.pasteText(text);
		sync();
	};
	const openExternalEditor = async (): Promise<void> => {
		if (!options.externalEditor || disposed) return;
		const current = editor.getExpandedText();
		try {
			tui.stop();
			const replacement = await options.externalEditor(current);
			if (!disposed && replacement !== null) {
				editor.setText(replacement);
				sync();
			}
		} finally {
			tui.start();
		}
	};
	const handleInput = (data: string): void => {
		if (disposed) return;
		const paste = pasteHandler.process(data);
		if (paste.handled) {
			if (paste.pasteContent !== undefined) pasteText(paste.pasteContent);
			if (paste.remaining) handleInput(paste.remaining);
			return;
		}
		if (matchesAppFollowUp(data)) {
			finish(onSubmit);
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "esc") || matchesAppInterrupt(data)) {
			cancel();
			return;
		}
		if (matchesAppExternalEditor(data)) {
			void openExternalEditor();
			return;
		}
		if (promptStyle && (matchesKey(data, "enter") || matchesKey(data, "return"))) {
			finish(onSubmit);
			return;
		}
		if (!promptStyle && (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n")) {
			editor.handleInput("\n");
			sync();
			return;
		}
		editor.handleInput(data);
		sync();
	};
	const controller: HookEditorController = {
		value,
		editor,
		handleInput,
		pasteText,
		beginPaste(): (text: string | undefined) => boolean {
			if (disposed) return () => false;
			const pending = { settled: false, text: undefined as string | undefined };
			pendingPastes.push(pending);
			return text => {
				if (disposed || pending.settled) return false;
				pending.settled = true;
				pending.text = text;
				if (!text) submitQueued = false;
				let delivered = 0;
				for (const item of pendingPastes) {
					if (!item.settled) break;
					if (item.text) editor.pasteText(item.text);
					delivered++;
				}
				if (delivered) pendingPastes.splice(0, delivered);
				sync();
				if (pendingPastes.length === 0 && submitQueued) {
					submitQueued = false;
					finish(onSubmit, true);
				}
				return Boolean(text);
			};
		},
		cancel,
		dispose(): void {
			disposed = true;
			submitQueued = false;
			pendingPastes.length = 0;
		},
	};
	return controller;
}

/** Creates the state behind a multiline hook or ask-response editor. */
export function createHookEditorController(
	tui: TUI,
	prefill: string | undefined,
	onSubmit: (value: string) => void,
	onCancel: () => void,
	options: HookEditorOptions = {},
): HookEditorController {
	return createHookEditorControllerInternal(tui, prefill, onSubmit, onCancel, options);
}

export interface HookEditorViewProps {
	readonly title: string;
	readonly controller: HookEditorController;
	readonly promptStyle?: boolean;
}

/** Reactive multiline editor surface. */
export function HookEditorView(props: HookEditorViewProps): JSX.Element {
	const focus = useFocus();
	onMount(() => focus.focus());
	const [titleLine = "", ...details] = props.title.split("\n");
	const title = titleLine.replace(/\s+/g, " ").trim();
	const handleKey = (event: HostKeyEvent): void => {
		props.controller.handleInput(event.data);
		event.preventDefault();
	};
	return (
		<frame title={title ?? ""} paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
			<stack>
				{details.length > 0 ? (
					<>
						<text> </text>
						<scroll height={3} shrinkToFit>
							<stack>
								{details.map(detail =>
									detail.trim() ? (
										<text color="accent" wrap="word">
											{detail}
										</text>
									) : null,
								)}
							</stack>
						</scroll>
					</>
				) : null}
				<text> </text>
				<editor
					editor={props.controller.editor}
					inputTarget={props.controller}
					tabIndex={focus.tabIndex}
					onKey={handleKey}
				/>
				<text> </text>
				<text color="dim" wrap="word">
					{editorHint(props.promptStyle ?? false)}
				</text>
				<text> </text>
			</stack>
		</frame>
	);
}

export interface HookEditorOverlayProps {
	readonly title: string;
	readonly prefill?: string;
	readonly onSubmit: (value: string) => void;
	readonly onCancel: () => void;
	readonly options?: HookEditorOptions;
}

export function HookEditorOverlay(
	props: HookEditorOverlayProps & { readonly controller: HookEditorController },
): JSX.Element {
	onCleanup(() => props.controller.dispose());
	return (
		<Portal to="overlay" anchor="bottom-center" width={props.options?.width ?? "100%"}>
			<HookEditorView title={props.title} controller={props.controller} promptStyle={props.options?.promptStyle} />
		</Portal>
	);
}

export interface HookEditorHandle extends OverlayDisposer, HookEditorController {}

/** Mount a hook editor and return its reactive controller handle. */
export function openHookEditorOverlay(tui: TUI, props: HookEditorOverlayProps): HookEditorHandle {
	const controller = createHookEditorControllerInternal(
		tui,
		props.prefill,
		props.onSubmit,
		props.onCancel,
		props.options ?? {},
		() => dispose(),
	);
	const overlay = mountOverlay(tui, () => <HookEditorOverlay {...props} controller={controller} />);
	let disposed = false;
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		controller.dispose();
		overlay.dispose();
	};
	return Object.assign(dispose, controller, { hide: dispose, dispose });
}
