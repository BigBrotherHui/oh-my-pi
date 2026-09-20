import { For, Show, type JSX } from "../reactive";
import type { ThemeBg, ThemeColor } from "../theme/schema";
import { Section } from "./section";

/** A labeled or separated region inside a card. */
export interface CardSection {
	readonly label?: string;
	readonly content: JSX.Element;
	readonly separator?: boolean;
}

/** Props for the shared framed or frameless card composition. */
export interface CardProps {
	readonly title?: JSX.Element;
	readonly titleInset?: number;
	readonly sections?: readonly CardSection[];
	readonly children?: JSX.Element;
	readonly footer?: string;
	readonly border?: boolean;
	readonly borderColor?: ThemeColor;
	readonly background?: ThemeBg;
	readonly backgroundBorder?: boolean;
	readonly recipe?: string;
	readonly fitContent?: boolean;
	readonly paddingX?: number;
	readonly paddingY?: number;
}

/** Render a frame and declarative sections without measuring content in the view. */
export function Card(props: CardProps): JSX.Element {
	return (
		<frame
			title={props.title}
			titleInset={props.titleInset ?? 3}
			titleBold={false}
			footer={props.footer}
			border={props.border ?? true}
			borderColor={props.borderColor}
			background={props.background}
			backgroundBorder={props.backgroundBorder ?? props.background !== undefined}
			recipe={props.recipe}
			fitContent={props.fitContent}
			paddingX={props.paddingX ?? 1}
			paddingY={props.paddingY ?? 0}
		>
			{props.children}
			<For each={props.sections}>
				{section => (
					<Show
						when={props.border ?? true}
						fallback={
							<>
								<Show when={section.separator}>
									<br />
								</Show>
								<Show when={section.label} fallback={section.content}>
									<Section label={section.label}>{section.content}</Section>
								</Show>
							</>
						}
					>
						<Show when={section.label !== undefined || section.separator}>
							<hr variant="frame" label={section.label} />
						</Show>
						{section.content}
					</Show>
				)}
			</For>
		</frame>
	);
}
