import type { TodoItem } from "../tools/todo";
import { Show, type Accessor, type JSX, useTheme } from "../reactive";

export interface TodoReminderViewProps {
	readonly todos: readonly TodoItem[];
	readonly attempt: number;
	readonly maxAttempts: number;
	/** Live transcript tool-activity visibility. */
	readonly visible: Accessor<boolean>;
}

/** Transcript reminder for unfinished todos, preserving the historical notice frame. */
export function TodoReminderView(props: TodoReminderViewProps): JSX.Element {
	const theme = useTheme();

	return (
		<Show when={props.visible()}>
			<stack>
				<text>{""}</text>
				<box color="warning" inverse padding={1}>
					<stack>
						<text>{`${theme.symbol("icon.warning")} ${props.todos.length} incomplete ${props.todos.length === 1 ? "todo" : "todos"} - reminder ${props.attempt}/${props.maxAttempts}`}</text>
						<text>{""}</text>
						<Show when={props.todos.length > 0}>
							<text italic>
								{props.todos.map(todo => `  ${theme.symbol("checkbox.unchecked")} ${todo.content}`).join("\n")}
							</text>
						</Show>
					</stack>
				</box>
			</stack>
		</Show>
	);
}
