import { createSignal, useViewport, type Accessor, type JSX } from "../../reactive";
import { matchesKey } from "../../keys";
import { SignInSceneView } from "./sign-in";
import { WebSearchSceneView } from "./web-search";
import type { SetupHost, SetupScene, SetupSceneResult } from "./types";

type ProviderTab = "sign-in" | "web-search";

const PROVIDER_TABS = [
	{ id: "sign-in", label: "Sign in" },
	{ id: "web-search", label: "Web search" },
] as const satisfies readonly { readonly id: ProviderTab; readonly label: string }[];

interface TabChunk {
	readonly text: string;
	readonly id?: ProviderTab;
}

/**
 * Retains the tab bar's last painted geometry for pointer hit testing. This
 * mirrors the host `<tabs>` chunk/wrap policy so clicks remain accurate after
 * the label wraps on narrow terminals.
 */
function tabAt(width: number, row: number, col: number): ProviderTab | undefined {
	const safeWidth = Math.max(1, Math.trunc(width));
	const chunks: TabChunk[] = [{ text: "Providers:  " }];
	for (const [index, tab] of PROVIDER_TABS.entries()) {
		chunks.push({ text: ` ${tab.label} `, id: tab.id });
		if (index < PROVIDER_TABS.length - 1) chunks.push({ text: "  " });
	}
	chunks.push({ text: "  (tab to cycle)" });

	let line = 0;
	let used = 0;
	for (const chunk of chunks) {
		const chunkWidth = chunk.text.length;
		if (used > 0 && used + chunkWidth > safeWidth) {
			line++;
			used = 0;
		}
		const renderedWidth = Math.min(chunkWidth, safeWidth - used);
		if (chunk.id !== undefined && line === row && col >= used && col < used + renderedWidth) return chunk.id;
		used += renderedWidth;
	}
	return undefined;
}

function tabRows(width: number): number {
	const safeWidth = Math.max(1, Math.trunc(width));
	const chunks = ["Providers:  ", " Sign in ", "  ", " Web search ", "  (tab to cycle)"];
	let rows = 1;
	let used = 0;
	for (const chunk of chunks) {
		const chunkWidth = chunk.length;
		if (used > 0 && used + chunkWidth > safeWidth) {
			rows++;
			used = 0;
		}
		used += Math.min(chunkWidth, safeWidth - used);
	}
	return rows;
}

/** Provider scene geometry is supplied by the wizard after its chrome. */
export interface ProvidersSceneContext {
	readonly host: Pick<
		SetupHost,
		| "authStorage"
		| "captureBrowserSession"
		| "copyToClipboard"
		| "disabledProviders"
		| "isSearchProviderAvailable"
		| "openInBrowser"
		| "refreshProvider"
		| "saveWebSearchSelection"
		| "webSearchSelection"
	>;
	complete(result: SetupSceneResult): void;
	readonly availableRows?: Accessor<number>;
}

/**
 * Tabbed "Set up your providers" scene. Each panel owns its own selector and
 * side effects; this owner restores the shared tab navigation and mouse policy.
 */
export function ProvidersSceneView(context: ProvidersSceneContext): JSX.Element {
	const viewport = useViewport();
	const [tab, setTab] = createSignal<ProviderTab>("sign-in");
	const [modal, setModal] = createSignal(false);
	const [hovered, setHovered] = createSignal<ProviderTab>();
	const [tabWidth, setTabWidth] = createSignal(Math.max(1, viewport().columns - 6));

	const availableRows = (): number => Math.max(0, Math.trunc(context.availableRows?.() ?? viewport().rows));
	const panelRows = (): number => Math.max(0, availableRows() - tabRows(tabWidth()) - 1);
	const select = (next: ProviderTab): void => {
		if (modal() || next === tab()) return;
		setTab(next);
		setHovered(undefined);
	};
	const toggle = (direction: 1 | -1): void => {
		select(
			direction > 0
				? tab() === "sign-in"
					? "web-search"
					: "sign-in"
				: tab() === "sign-in"
					? "web-search"
					: "sign-in",
		);
	};
	const handleKey = (event: {
		readonly data: string;
		readonly defaultPrevented: boolean;
		preventDefault(): void;
		stopPropagation(): void;
	}): void => {
		if (event.defaultPrevented || modal()) return;
		if (matchesKey(event.data, "tab") || matchesKey(event.data, "right")) {
			toggle(1);
			event.preventDefault();
			event.stopPropagation();
		} else if (matchesKey(event.data, "shift+tab") || matchesKey(event.data, "left")) {
			toggle(-1);
			event.preventDefault();
			event.stopPropagation();
		}
	};
	const handleTabMouse = (event: {
		readonly action: "down" | "up" | "move" | "wheel";
		readonly button: number;
		readonly localRow: number;
		readonly localCol: number;
		preventDefault(): void;
		stopPropagation(): void;
	}): void => {
		if (modal()) {
			if (event.action === "move") setHovered(undefined);
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		const hit = tabAt(tabWidth(), event.localRow, event.localCol);
		if (event.action === "move") setHovered(hit);
		else if (event.action === "down" && event.button === 0 && hit !== undefined) select(hit);
		event.preventDefault();
		event.stopPropagation();
	};
	const paintTabs = (width: number): JSX.Element => {
		if (tabWidth() !== width) setTabWidth(width);
		return (
			<box onMouse={handleTabMouse}>
				<tabs
					{...{
						label: "Providers",
						tabs: PROVIDER_TABS,
						active: tab(),
						hovered: hovered(),
						showHint: true,
					}}
				/>
			</box>
		);
	};

	return (
		<box onKey={handleKey}>
			<stack>
				<sized paint={paintTabs} />
				<br />
				<scroll height={tab() === "sign-in" ? panelRows() : 0} scrollbar="never" shrinkToFit={false}>
					<SignInSceneView
						{...context}
						active={() => tab() === "sign-in"}
						availableRows={panelRows}
						setModal={setModal}
					/>
				</scroll>
				<scroll height={tab() === "web-search" ? panelRows() : 0} scrollbar="never" shrinkToFit={false}>
					<WebSearchSceneView {...context} active={() => tab() === "web-search"} availableRows={panelRows} />
				</scroll>
			</stack>
		</box>
	);
}

/** Setup step for provider authentication and web-search preference. */
export const providersSetupScene: SetupScene = {
	id: "providers",
	title: "Set up your providers",
	subtitle: "Sign in and pick a web search provider. Press Esc when you're done.",
	minVersion: 1,
	View: ProvidersSceneView,
};
