import { fatal } from "@oh-my-pi/pi-utils/postmortem";
import { onMount, useFocus, type JSX } from "@oh-my-pi/pi-tui/reactive";

export function FatalTuiView(): JSX.Element {
	const focus = useFocus();
	onMount(() => focus.focus());
	return (
		<stack>
			<text>safe transcript</text>
			<input prompt="╰─ " tabIndex={focus.tabIndex} onSubmit={() => void fatal(new Error("fatal PTY fixture"))} />
		</stack>
	);
}
