import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-tui/theme";
import { PsTopApp, type PsTopHost, type PsTopOptions } from "../src/apps/ps-top";
import type { PsDaemonRow, PsScopeReport } from "../src/apps/ps-data";
import type { DaemonSpec } from "../src/tools/hub-contract";
import { mountForTest, type TestRoot } from "../src/testing";
import { dispatchKey, HostKeyEvent } from "../src/host/input";
import type { HostElement } from "../src/host/types";

describe("PsTopApp", () => {
	let uiTheme: Theme;
	const roots: TestRoot[] = [];

	const sampleDaemon: PsDaemonRow = {
		snapshot: {
			id: "d1",
			name: "server",
			state: "running",
			pid: 12345,
			createdAt: Date.now() - 30_000,
			startedAt: Date.now() - 30_000,
			restartCount: 0,
			outputBytes: 256,
			persist: true,
			detached: false,
		},
		command: "bun run dev",
		cwd: "/work/pi",
		supervised: true,
	};

	const sampleReport: PsScopeReport = {
		scope: {
			kind: "project",
			runtimeDir: "/work/pi/.omp",
			projectDir: "/work/pi",
			brokerPid: 5432,
		},
		daemons: [sampleDaemon],
	};

	function createMockHost(): { host: PsTopHost; actions: string[] } {
		const actions: string[] = [];
		const host: PsTopHost = {
			async collectReports() {
				return [sampleReport];
			},
			async act(scope, name, verb) {
				actions.push(`${verb}:${name}`);
				return { ...sampleDaemon.snapshot, state: verb === "stop" ? "exited" : "running" };
			},
			async describe(scope, name) {
				const spec: DaemonSpec = {
					name: "server",
					application: "bun",
					args: ["run", "dev"],
					env: {},
					cwd: "/work/pi",
					pty: true,
					persist: true,
					detached: false,
					restart: "no",
				};
				return { daemon: sampleDaemon.snapshot, spec };
			},
			async logs(scope, name, lines) {
				return { text: "ready in 12ms\nwatching for file changes\n", state: "running" };
			},
			close() {
				actions.push("closed");
			},
		};
		return { host, actions };
	}

	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("Expected dark theme");
		uiTheme = loaded;
	});

	afterEach(() => {
		for (const root of roots.splice(0)) root.dispose();
	});

	it("mounts and renders process table with header and footer", async () => {
		const { host } = createMockHost();
		let doneCalled = false;
		const options: PsTopOptions = { all: false };

		const root = mountForTest(
			() => (
				<PsTopApp
					options={options}
					host={host}
					onDone={() => {
						doneCalled = true;
					}}
				/>
			),
			{ width: 100, theme: uiTheme },
		);
		roots.push(root);

		// Wait for initial async snapshot poll
		await Bun.sleep(10);
		root.flush();

		const text = root.text().join("\n");
		expect(text).toContain("omp ps");
		expect(text).toContain("server");
		expect(text).toContain("running");
		expect(text).toContain("bun run dev");
		expect(text).toContain("select");
	});

	it("handles info and logs navigation via key events", async () => {
		const { host, actions } = createMockHost();
		let doneCalled = false;
		const options: PsTopOptions = { all: false };

		const root = mountForTest(
			() => (
				<PsTopApp
					options={options}
					host={host}
					onDone={() => {
						doneCalled = true;
					}}
				/>
			),
			{ width: 100, theme: uiTheme },
		);
		roots.push(root);

		await Bun.sleep(10);
		root.flush();

		// Trigger info view with "i"
		const box = root.root.node.children[0]! as HostElement;
		const props = box.props as { onKey?: (event: HostKeyEvent) => void };
		const onKey = props.onKey;
		expect(onKey).toBeDefined();
		if (!onKey) throw new Error("Expected onKey handler on root box");

		onKey(new HostKeyEvent("i"));
		await Bun.sleep(10);
		root.flush();

		expect(root.text().join("\n")).toContain("process info");
		expect(root.text().join("\n")).toContain("command:");

		// Press escape to return
		onKey(new HostKeyEvent("\x1b"));
		root.flush();
		expect(root.text().join("\n")).toContain("1 process in 1 scope");

		// Trigger logs with "l"
		onKey(new HostKeyEvent("l"));
		await Bun.sleep(10);
		root.flush();
		expect(root.text().join("\n")).toContain("logs server");
		expect(root.text().join("\n")).toContain("ready in 12ms");

		// Press escape to return
		onKey(new HostKeyEvent("\x1b"));
		root.flush();

		// Trigger stop action with "s"
		onKey(new HostKeyEvent("s"));
		await Bun.sleep(10);
		expect(actions).toContain("stop:server");

		// Quit with "q"
		onKey(new HostKeyEvent("q"));
		expect(doneCalled).toBe(true);
	});

	it("keeps the selected process visible in a compact table viewport", async () => {
		const reports: PsScopeReport[] = [
			{
				...sampleReport,
				daemons: Array.from({ length: 8 }, (_, index) => ({
					...sampleDaemon,
					snapshot: {
						...sampleDaemon.snapshot,
						id: `d${index}`,
						name: `worker-${index + 1}`,
					},
				})),
			},
		];
		const { host } = createMockHost();
		host.collectReports = async () => reports;
		const root = mountForTest(() => <PsTopApp options={{ all: false }} host={host} onDone={() => {}} />, {
			width: 24,
			height: 6,
			theme: uiTheme,
		});
		roots.push(root);

		await Bun.sleep(10);
		root.flush();
		for (let index = 0; index < 7; index++) dispatchKey(root.root, new HostKeyEvent("\x1b[B"));
		root.flush();

		const text = root.text().join("\n");
		expect(text).toContain("❯ worker-8");
		expect(text).not.toContain("worker-1");
	});
});
