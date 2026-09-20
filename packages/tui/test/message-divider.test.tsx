import { describe, expect, it } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { MessageDividerView } from "../src/chrome/message-divider";
import "../src/host/elements/br";
import "../src/host/elements/hr";
import "../src/host/elements/stack";
import { mountForTest } from "../src/testing";

describe("MessageDividerView", () => {
	it("restores the padded, left-aligned historical divider at wide and narrow widths", () => {
		const root = mountForTest(() => MessageDividerView({ label: "checkpoint" }), { width: 80 });
		try {
			expect(root.text()).toEqual(["", "────────── checkpoint", ""]);
			expect(root.text(8)).toEqual(["", "checkpo…", ""]);
		} finally {
			root.dispose();
		}
	});

	it("preserves deliberate narrow overflow and reacts to changing labels", () => {
		const [label, setLabel] = createSignal("checkpoint");
		const root = mountForTest(() =>
			createComponent(MessageDividerView, {
				get label() {
					return label();
				},
				color: "warning",
				ruleColor: "dim",
				ruleWidth: 4,
				truncateWhenNarrow: false,
			}),
		);
		try {
			expect(root.text(8)).toEqual(["", "checkpoint", ""]);
			setLabel("arrived at 12:04");
			expect(root.text()).toEqual(["", "──── arrived at 12:04", ""]);
		} finally {
			root.dispose();
		}
	});
});
