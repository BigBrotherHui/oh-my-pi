import { type JSX } from "../reactive";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { SelectOption } from "../host/elements/select";
import type { SizeValue, TUI } from "../tui";
import { SelectOverlay } from "./select-overlay";

export interface PluginSelectorCallbacks {
	onSelect(pluginName: string, marketplace: string, scope?: "user" | "project"): void;
	onCancel(): void;
}

export interface PluginItem {
	plugin: { name: string; version?: string; description?: string };
	marketplace: string;
	scope?: "user" | "project";
}

export interface PluginSelectorProps {
	readonly marketplaceCount: number;
	readonly plugins: readonly PluginItem[];
	readonly installedIds: ReadonlySet<string>;
	readonly callbacks: PluginSelectorCallbacks;
	readonly width?: SizeValue;
}

function selectorOptions(
	marketplaceCount: number,
	plugins: readonly PluginItem[],
	installedIds: ReadonlySet<string>,
): readonly SelectOption[] {
	if (plugins.length === 0) {
		return [
			{
				value: "__empty__",
				label: "No plugins available",
				description:
					marketplaceCount === 0
						? "Add a marketplace first: /marketplace add <source>"
						: "Configured marketplaces have no plugins",
				disabled: true,
			},
		];
	}
	return plugins.map(({ plugin, marketplace, scope }) => {
		const id = scope ? `${plugin.name}@${marketplace}#${scope}` : `${plugin.name}@${marketplace}`;
		const version = plugin.version ? `@${plugin.version}` : "";
		const installed = installedIds.has(`${plugin.name}@${marketplace}`) ? " [installed]" : "";
		const scopeTag = scope ? ` [${scope}]` : "";
		return {
			value: id,
			label: `${plugin.name}${version}${installed}${scopeTag}`,
			description: plugin.description,
			hint: marketplace,
		};
	});
}

export function PluginSelector(props: PluginSelectorProps): JSX.Element {
	const options = selectorOptions(props.marketplaceCount, props.plugins, props.installedIds);
	const selectPlugin = (value: string): void => {
		const [name, marketplace, scope] = splitPluginId(value);
		if (name && marketplace) props.callbacks.onSelect(name, marketplace, scope);
	};
	return (
		<Portal to="overlay" anchor="bottom-center" width={props.width ?? "100%"}>
			<SelectOverlay
				title="Plugins"
				options={options}
				maxRows={20}
				onSelect={selectPlugin}
				onCancel={props.callbacks.onCancel}
			/>
		</Portal>
	);
}

export function openPluginSelector(tui: TUI, props: PluginSelectorProps): OverlayDisposer {
	return mountOverlay(tui, () => <PluginSelector {...props} />);
}

function splitPluginId(id: string): [string, string, "user" | "project" | undefined] | [null, null, null] {
	const hashIndex = id.indexOf("#");
	const base = hashIndex >= 0 ? id.slice(0, hashIndex) : id;
	const scope = hashIndex >= 0 ? (id.slice(hashIndex + 1) as "user" | "project") : undefined;
	const atIndex = base.lastIndexOf("@");
	if (atIndex <= 0) return [null, null, null];
	return [base.slice(0, atIndex), base.slice(atIndex + 1), scope];
}
