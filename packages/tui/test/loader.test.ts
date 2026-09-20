import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { createElement, insert, insertNode, setProp } from "../src/host/renderer";
import { createClock, createSignal, type Accessor, type JSX } from "../src/reactive";
import { mountForTest } from "../src/testing";
import { visibleWidth } from "../src/utils";

function SpinnerView(frame?: number): JSX.Element {
	const spinner = createElement("spinner");
	setProp(spinner, "type", "status");
	if (frame !== undefined) setProp(spinner, "frame", frame);
	return spinner;
}

function SpinnerMessageView(message: Accessor<string>): JSX.Element {
	const row = createElement("row");
	setProp(row, "gap", 1);
	insertNode(row, SpinnerView());
	const text = createElement("text");
	insert(text, message);
	insertNode(row, text);
	return row;
}

describe("native spinner", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("repaints on the shared root clock without exceeding the viewport width", () => {
		vi.useFakeTimers();
		setSystemTime(0);
		const clock = createClock();
		const root = mountForTest(SpinnerView, { width: 1, clock });
		try {
			const initial = root.text();
			for (const row of initial) expect(visibleWidth(row)).toBeLessThanOrEqual(1);

			vi.advanceTimersByTime(80);
			const advanced = root.text();
			for (const row of advanced) expect(visibleWidth(row)).toBeLessThanOrEqual(1);
			expect(advanced).not.toEqual(initial);
		} finally {
			root.dispose();
			clock.dispose();
		}
	});

	it("keeps a caller-controlled frame frozen without subscribing to the spinner clock", () => {
		vi.useFakeTimers();
		setSystemTime(0);
		const clock = createClock();
		const root = mountForTest(() => SpinnerView(2), { clock });
		try {
			const frozen = root.text();
			expect(root.counters().timers).toBe(0);

			vi.advanceTimersByTime(240);
			expect(root.text()).toEqual(frozen);
		} finally {
			root.dispose();
			clock.dispose();
		}
	});

	it("updates a dynamic loading message through the retained root", () => {
		const [message, setMessage] = createSignal("Checking");
		const clock = createClock();
		const root = mountForTest(() => SpinnerMessageView(message), { clock });
		try {
			expect(root.text().join("\n")).toContain("Checking");

			setMessage("Still checking");
			const updated = root.text().join("\n");
			expect(updated).toContain("Still checking");
			expect(updated).not.toContain("Checking");
		} finally {
			root.dispose();
			clock.dispose();
		}
	});

	it("releases its root-clock subscription when the retained view is disposed", () => {
		vi.useFakeTimers();
		setSystemTime(0);
		const clock = createClock();
		const root = mountForTest(SpinnerView, { clock });
		root.text();
		expect(root.counters().timers).toBe(1);

		root.dispose();
		expect(root.counters().timers).toBe(0);
		clock.dispose();
	});
});
