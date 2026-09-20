import { describe, expect, it } from "bun:test";
import {
	collapseCommand,
	daemonLabel,
	flagsCell,
	formatCommand,
	PsReportView,
	ScopeHeaderView,
	stateCellText,
	stateColor,
	TABLE_HEADER,
	tableCellsPlain,
	uptimeCell,
	type PsDaemonRow,
	type PsScope,
} from "../src/apps/ps-data";
import { mountForTest } from "../src/testing";

describe("ps-data", () => {
	const sampleDaemon: PsDaemonRow = {
		snapshot: {
			id: "d1",
			name: "server",
			state: "running",
			pid: 12345,
			createdAt: Date.now() - 60_000,
			startedAt: Date.now() - 60_000,
			restartCount: 2,
			outputBytes: 1024,
			persist: true,
			detached: false,
		},
		command: "bun --watch\nrun src/index.ts",
		cwd: "/work/pi",
		supervised: true,
	};

	const sampleScope: PsScope = {
		kind: "project",
		runtimeDir: "/work/pi/.omp",
		projectDir: "/work/pi",
		brokerPid: 9876,
	};

	it("formats and collapses commands", () => {
		expect(
			formatCommand({
				name: "server",
				application: "bun",
				args: ["run", "dev"],
				env: {},
				cwd: "/work/pi",
				pty: true,
				restart: "no",
				persist: true,
				detached: false,
			}),
		).toBe("bun run dev");
		expect(collapseCommand("bun  --watch\n  run   src/index.ts  ")).toBe("bun --watch run src/index.ts");
	});

	it("formats daemon labels with pid and exit", () => {
		expect(daemonLabel(sampleDaemon.snapshot)).toBe("server: running pid=12345");
		expect(daemonLabel({ ...sampleDaemon.snapshot, pid: undefined, exitCode: 1, state: "failed" })).toBe(
			"server: failed exit=1",
		);
	});

	it("derives state cell text and colors", () => {
		expect(stateCellText(sampleDaemon)).toBe("running");
		expect(stateColor(sampleDaemon)).toBe("success");

		const failedDaemon: PsDaemonRow = {
			...sampleDaemon,
			snapshot: { ...sampleDaemon.snapshot, state: "failed", exitCode: 143 },
		};
		expect(stateCellText(failedDaemon)).toBe("failed(143)");
		expect(stateColor(failedDaemon)).toBe("error");

		const exitedDaemon: PsDaemonRow = {
			...sampleDaemon,
			snapshot: { ...sampleDaemon.snapshot, state: "exited", exitCode: 0 },
		};
		expect(stateCellText(exitedDaemon)).toBe("exited(0)");
		expect(stateColor(exitedDaemon)).toBe("dim");
	});

	it("renders a retained report with semantic process state", () => {
		const root = mountForTest(() =>
			PsReportView({
				reports: [{ scope: sampleScope, daemons: [sampleDaemon] }],
				now: sampleDaemon.snapshot.startedAt + 10_000,
				includeAll: false,
			}),
		);
		expect(root.text().join("\n")).toContain("running");
		expect(root.text().join("\n")).toContain("Use --all");
		root.dispose();
	});

	it("formats flags and uptime", () => {
		expect(flagsCell(sampleDaemon)).toBe("persist");
		const unsupervised = { ...sampleDaemon, supervised: false };
		expect(flagsCell(unsupervised)).toBe("persist,unsupervised");

		expect(uptimeCell(sampleDaemon.snapshot, sampleDaemon.snapshot.startedAt + 5000)).toBe("5.0s");
		expect(uptimeCell({ ...sampleDaemon.snapshot, state: "exited" }, sampleDaemon.snapshot.startedAt + 5000)).toBe(
			"-",
		);
	});

	it("formats table cells aligned with TABLE_HEADER", () => {
		expect(TABLE_HEADER).toEqual(["NAME", "STATE", "PID", "UPTIME", "RESTARTS", "FLAGS", "COMMAND"]);
		const plain = tableCellsPlain(sampleDaemon, sampleDaemon.snapshot.startedAt + 10_000);
		expect(plain).toEqual(["server", "running", "12345", "10.0s", "2", "persist", "bun --watch run src/index.ts"]);
	});

	it("renders ScopeHeaderView through the retained host", () => {
		const root = mountForTest(() => <ScopeHeaderView scope={sampleScope} />);
		expect(root.text().join("")).toContain("project");
		expect(root.text().join("")).toContain("/work/pi");
		expect(root.text().join("")).toContain("broker pid 9876");
		root.dispose();
	});
});
