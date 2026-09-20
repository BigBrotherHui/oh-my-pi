import { beforeAll, describe, expect, it } from "bun:test";
import { allocateLayout } from "../../src/host/layout";
import { initTheme } from "../../src/theme/theme";
import { pathElement } from "../../src/host/elements/path";
import { rowElement } from "../../src/host/elements/row";
import { textElement } from "../../src/host/elements/text";
import { hrElement } from "../../src/host/elements/hr";
import { stackElement } from "../../src/host/elements/stack";
import { elementText, hostElement, hostText } from "./host-harness";

void pathElement;
void rowElement;
void textElement;
void hrElement;
void stackElement;

beforeAll(async () => {
	await initTheme(false);
});

describe("row allocation", () => {
	it("distributes growth by weight and respects maximums", () => {
		expect(allocateLayout([{ width: 2, grow: 1 }, { width: 2, grow: 2, maxWidth: 5 }, { width: 1 }], 10)).toEqual([
			4, 5, 1,
		]);
	});

	it("shrinks opted-in children to their minimum before fixed siblings", () => {
		expect(allocateLayout([{ width: 3 }, { width: 10, shrink: 1, minWidth: 4 }, { width: 2 }], 11)).toEqual([
			3, 6, 2,
		]);
	});

	it("collapses later minimums first only when constraints cannot fit", () => {
		expect(allocateLayout([{ minWidth: 4 }, { minWidth: 4 }, { minWidth: 4 }], 7)).toEqual([4, 3, 0]);
	});

	it("collapses lower-priority children before their higher-priority siblings", () => {
		expect(
			allocateLayout(
				[
					{ width: 4, shrink: 1, overflowPriority: 0 },
					{ width: 4, shrink: 1, overflowPriority: 2 },
				],
				5,
			),
		).toEqual([1, 4]);
	});

	it("keeps fixed siblings while a path shrinks with a middle ellipsis", () => {
		const left = hostElement("text", { width: 1, wrap: "none" }, [hostText("L")]);
		const path = hostElement(
			"path",
			{ value: "abcdefghij", target: "/tmp/abcdefghij", overflow: "middle", shrink: 1, minWidth: 3 },
			[],
		);
		const right = hostElement("text", { width: 1, wrap: "none" }, [hostText("R")]);
		const row = hostElement("row", { gap: 1 }, [left, path, right]);

		expect(elementText(row, 10)).toEqual(["L ab…hij R"]);
	});

	it("sizes aligned columns by content rather than their stretching divider", () => {
		const labels = hostElement("stack", { grow: 1 }, [
			hostElement("text", {}, [hostText("label-a")]),
			hostElement("hr", { char: "-" }),
			hostElement("text", {}, [hostText("label-b")]),
		]);
		const metrics = hostElement("stack", {}, [
			hostElement("text", { align: "right" }, [hostText("9")]),
			hostElement("hr", { char: "-" }),
			hostElement("text", { align: "right" }, [hostText("123")]),
		]);
		const row = hostElement("row", {}, [labels, metrics]);
		expect(elementText(row, 20)).toEqual(["label-a".padEnd(19) + "9", "-".repeat(20), "label-b".padEnd(17) + "123"]);
	});

	it("moves a growable detail to an indented continuation without clipping fixed siblings", () => {
		const status = hostElement("text", { wrap: "none" }, [hostText("*")]);
		const id = hostElement("text", { shrink: 1, wrap: "none" }, [hostText("job")]);
		const label = hostElement("text", { grow: 1, wrap: "none", overflow: "ellipsis" }, [hostText("LABEL")]);
		const duration = hostElement("text", { shrink: 0, wrap: "none" }, [hostText("1s")]);
		const row = hostElement("row", { gap: 1, pad: false, wrap: "continuation", continuationIndent: 2 }, [
			status,
			id,
			label,
			duration,
		]);

		expect(elementText(row, 9)).toEqual(["* job 1s", "  LABEL"]);
	});
});
