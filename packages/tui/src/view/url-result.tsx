import { createMemo, Show, type Accessor, type JSX } from "../reactive";
import { getDomain } from "../render/render-utils";
import { useTheme } from "../theme/reactive";

/** Reactive destination and inline label shared by URL-bearing tool views. */
export interface UrlLinkProps {
	readonly href: Accessor<string | undefined>;
	readonly children: JSX.Element;
}

/** Render children as a link when the caller supplies a destination. */
export function UrlLink(props: UrlLinkProps): JSX.Element {
	return (
		<Show when={props.href()} fallback={props.children}>
			{(href: Accessor<string>) => <link href={href()}>{props.children}</link>}
		</Show>
	);
}

/** Linked result title and inline source metadata. */
export interface UrlResultViewProps {
	readonly href: Accessor<string | undefined>;
	readonly title: Accessor<string>;
	readonly source?: Accessor<string | undefined>;
	readonly metadata?: Accessor<string | undefined>;
	readonly prefix?: Accessor<string | undefined>;
}

/** Render one compact URL result row without separating metadata into flex columns. */
export function UrlResultView(props: UrlResultViewProps): JSX.Element {
	const { theme } = useTheme();
	const source = createMemo(() => props.source?.() || getDomain(props.href() ?? ""));
	const metadata = createMemo(() => props.metadata?.() ?? "");

	return (
		<text
			fit="prefix"
			fitMinWidth={12}
			ellipsisColor="accent"
			wrap="word"
			leading={
				<Show when={props.prefix?.()}>
					{(prefix: Accessor<string>) => (
						<>
							<span color="dim">{prefix()}</span>
							<span> </span>
						</>
					)}
				</Show>
			}
			prefix={
				<UrlLink href={props.href}>
					<span color="accent">{props.title()}</span>
				</UrlLink>
			}
			suffix={
				<>
					<Show when={source()}>
						<span> </span>
						<span color="dim">({source()})</span>
					</Show>
					<Show when={source() && metadata()}>
						<span color="dim">{theme().sep.dot}</span>
					</Show>
					<Show when={metadata()}>
						<span color="muted">{metadata()}</span>
					</Show>
				</>
			}
		/>
	);
}
