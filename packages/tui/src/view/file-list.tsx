import { Show, type JSX } from "../reactive";
import { useTheme } from "../theme/reactive";
import { TreeList } from "./tree-list";
import { getLanguageFromPath } from "../lang-from-path";

/** One path displayed by FileList. */
export interface FileEntry {
	readonly path: string;
	readonly absPath?: string;
	readonly isDirectory?: boolean;
	readonly meta?: string;
}

/** Props for a themed file tree. */
export interface FileListProps {
	readonly files: readonly FileEntry[];
	readonly expanded?: boolean;
	readonly maxCollapsed?: number;
	readonly showIcons?: boolean;
	readonly fileIcon?: "generic" | "language";
	readonly pathOverflow?: "clip" | "ellipsis" | "middle";
}

/** Render files as keyed tree children with host-owned guide glyphs. */
export function FileList(props: FileListProps): JSX.Element {
	const theme = useTheme();
	return (
		<TreeList
			items={props.files}
			expanded={props.expanded}
			maxCollapsed={props.maxCollapsed}
			itemType="file"
			renderItem={entry => {
				const directory = (): boolean => entry.isDirectory ?? entry.path.endsWith("/");
				return (
					<row gap={1}>
						<Show when={props.showIcons ?? true}>
							<text color={directory() ? "accent" : "muted"} shrink={0}>
								{directory()
									? theme.symbol("icon.folder")
									: props.fileIcon === "language"
										? theme.theme().getLangIcon(getLanguageFromPath(entry.path))
										: theme.symbol("icon.file")}
							</text>
						</Show>
						<path
							value={entry.path}
							target={entry.absPath}
							overflow={props.pathOverflow ?? "middle"}
							grow={1}
							minWidth={1}
							color={directory() ? "accent" : "toolOutput"}
						/>
						<Show when={entry.meta}>
							<text color="dim" shrink={1}>
								{entry.meta}
							</text>
						</Show>
					</row>
				);
			}}
		/>
	);
}
