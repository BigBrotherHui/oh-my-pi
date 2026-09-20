import "@oh-my-pi/pi-tui/host/intrinsics";
import { createSignal, For, type JSX } from "@oh-my-pi/pi-tui/reactive";

export interface ReactiveSlot {
	/** Mount slot content under the consuming view's reactive owner. */
	readonly view: () => JSX.Element;
	set(content: JSX.Element | undefined): void;
	clear(): void;
}

/** Slot content; factories create reactive resources under the mounted entry's owner. */
export type ReactiveContent = JSX.Element | (() => JSX.Element);

export interface ReactiveStack {
	/** Mount stack content under the consuming view's reactive owner. */
	readonly view: () => JSX.Element;
	readonly entries: () => readonly ReactiveStackEntry[];
	append(content: ReactiveContent): string;
	replace(id: string, content: ReactiveContent): boolean;
	remove(id: string): boolean;
	clear(): void;
}

export interface ReactiveStackEntry {
	readonly id: string;
	readonly content: ReactiveContent;
}

function SlotView(props: { readonly content: () => JSX.Element | undefined }): JSX.Element {
	return <>{props.content()}</>;
}

function StackView(props: { readonly entries: () => readonly ReactiveStackEntry[] }): JSX.Element {
	return (
		<stack>
			<For each={props.entries()}>
				{entry => (typeof entry.content === "function" ? entry.content() : entry.content)}
			</For>
		</stack>
	);
}

export function createReactiveSlot(): ReactiveSlot {
	const [content, setContent] = createSignal<JSX.Element | undefined>();
	return {
		view: () => <SlotView content={content} />,
		set: setContent,
		clear: () => setContent(undefined),
	};
}

export function createReactiveStack(): ReactiveStack {
	const [entries, setEntries] = createSignal<readonly ReactiveStackEntry[]>([]);
	let nextId = 0;
	return {
		view: () => <StackView entries={entries} />,
		entries,
		append(content): string {
			const id = `slot:${nextId++}`;
			setEntries(previous => [...previous, { id, content }]);
			return id;
		},
		replace(id, content): boolean {
			let found = false;
			setEntries(previous =>
				previous.map(entry => {
					if (entry.id !== id) return entry;
					found = true;
					return { id, content };
				}),
			);
			return found;
		},
		remove(id): boolean {
			let found = false;
			setEntries(previous => {
				const next = previous.filter(entry => {
					if (entry.id !== id) return true;
					found = true;
					return false;
				});
				return found ? next : previous;
			});
			return found;
		},
		clear(): void {
			setEntries([]);
		},
	};
}
