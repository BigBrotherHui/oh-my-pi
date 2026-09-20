import { describe, expect, it } from "bun:test";
import { flattenStatusLineText } from "../src/status-line/component";

describe("status-line text sanitation", () => {
	it("flattens LF and CRLF so a dynamic label cannot create another row", () => {
		const text = flattenStatusLineText("[router] $ set -e\ncat > /etc/apt/sources.list\r\nnext");
		expect(text).toBe("[router] $ set -e cat > /etc/apt/sources.list next");
		expect(text).not.toMatch(/[\r\n]/);
	});
});
