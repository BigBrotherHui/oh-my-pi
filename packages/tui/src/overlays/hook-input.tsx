import { createMemo, createSignal, onCleanup, type Accessor, type JSX } from "../reactive";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { SizeValue, TUI } from "../tui";

export interface HookInputOptions {
	timeout?: number;
	onTimeout?: () => void;
	width?: SizeValue;
}

export interface HookInputProps {
	readonly title: string;
	readonly placeholder?: string;
	readonly onSubmit: (value: string) => void;
	readonly onCancel: () => void;
	readonly options?: HookInputOptions;
}

export interface HookInputController {
	readonly title: Accessor<string>;
	reset(): void;
	dispose(): void;
}

/** Owns the historical millisecond countdown shown in a hook input title. */
export function createHookInputController(props: HookInputProps): HookInputController {
	const timeoutMs = props.options?.timeout ?? 0;
	const [remaining, setRemaining] = createSignal(timeoutMs > 0 ? Math.ceil(timeoutMs / 1000) : 0);
	const title = createMemo(() => (timeoutMs > 0 ? `${props.title} (${remaining()}s)` : props.title));
	let deadline = 0;
	let expiry: NodeJS.Timeout | undefined;
	let ticker: NodeJS.Timeout | undefined;
	let disposed = false;

	const clearTimers = (): void => {
		if (expiry !== undefined) {
			clearTimeout(expiry);
			expiry = undefined;
		}
		if (ticker !== undefined) {
			clearInterval(ticker);
			ticker = undefined;
		}
	};
	const updateRemaining = (): void => {
		setRemaining(Math.max(0, Math.ceil((deadline - performance.now()) / 1000)));
	};
	const expire = (): void => {
		if (disposed) return;
		clearTimers();
		setRemaining(0);
		props.options?.onTimeout?.();
		props.onCancel();
	};
	const reset = (): void => {
		if (disposed || timeoutMs <= 0) return;
		clearTimers();
		deadline = performance.now() + timeoutMs;
		setRemaining(Math.ceil(timeoutMs / 1000));
		expiry = setTimeout(expire, timeoutMs);
		ticker = setInterval(updateRemaining, 1_000);
	};
	reset();

	return {
		title,
		reset,
		dispose(): void {
			if (disposed) return;
			disposed = true;
			clearTimers();
		},
	};
}

export interface HookInputViewProps {
	readonly controller: HookInputController;
	readonly onSubmit: (value: string) => void;
	readonly onCancel: () => void;
}

/** Reactive single-line hook input surface. */
export function HookInputView(props: HookInputViewProps): JSX.Element {
	return (
		<frame title={props.controller.title()} paddingX={1} paddingY={0} borderPolicy="always" fitContent renderEmpty>
			<stack>
				<br />
				<input
					tabIndex={0}
					prompt="> "
					onKey={props.controller.reset}
					onSubmit={props.onSubmit}
					onEscape={props.onCancel}
				/>
				<br />
				<text color="dim" wrap="word">
					{"enter submit  esc cancel"}
				</text>
				<br />
			</stack>
		</frame>
	);
}

/** Reactive single-line hook input overlay. */
export function HookInput(props: HookInputProps): JSX.Element {
	const controller = createHookInputController(props);
	onCleanup(() => controller.dispose());
	return (
		<Portal to="overlay" anchor="bottom-center" width={props.options?.width ?? "100%"}>
			<HookInputView controller={controller} onSubmit={props.onSubmit} onCancel={props.onCancel} />
		</Portal>
	);
}

export function openHookInput(tui: TUI, props: HookInputProps): OverlayDisposer {
	return mountOverlay(tui, () => <HookInput {...props} />);
}
