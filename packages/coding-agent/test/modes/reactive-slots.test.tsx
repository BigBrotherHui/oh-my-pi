import { expect, test } from "bun:test";
import { createReactiveStack } from "@oh-my-pi/pi-coding-agent/modes/reactive-slots";
import { useViewport } from "@oh-my-pi/pi-tui/reactive";
import { mountForTest } from "@oh-my-pi/pi-tui/testing";

function ViewportEntry(props: { label: string }) {
	const viewport = useViewport();
	return (
		<text>
			{props.label}: {viewport().columns}
		</text>
	);
}

test("stack factories inherit the mounting root before and after session adoption", () => {
	const stack = createReactiveStack();
	const early = stack.append(() => <ViewportEntry label="early" />);
	const root = mountForTest(stack.view, { width: 42 });
	try {
		expect(root.text()).toEqual(["early: 42"]);
		stack.append(() => <ViewportEntry label="late" />);
		expect(root.text()).toEqual(["early: 42", "late: 42"]);
		stack.remove(early);
		expect(root.text()).toEqual(["late: 42"]);
	} finally {
		root.dispose();
	}
});
