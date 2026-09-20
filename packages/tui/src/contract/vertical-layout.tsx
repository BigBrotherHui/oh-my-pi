import type { JSX } from "../reactive";

/** Full-height dialog fixture: native layout reserves its header and footer around scrolling content. */
export function VerticalLayoutFixture(props: { readonly header: string; readonly children: JSX.Element }): JSX.Element {
	return (
		<frame height="fill" paddingY={0}>
			<stack height="fill">
				<text>{props.header}</text>
				<scroll grow={1} scrollbar="never">
					{props.children}
				</scroll>
				<text>Footer</text>
			</stack>
		</frame>
	);
}
