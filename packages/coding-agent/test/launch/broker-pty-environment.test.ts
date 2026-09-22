import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { procmgr, setProcessName, TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

const BASH = "/bin/bash";
const hasBash = await Bun.file(BASH).exists();

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

async function collect(client: DaemonBrokerClient, name: string): Promise<string> {
	const exited = await client.request({ op: "wait", name, for: "exit", timeoutMs: 5_000 });
	if (exited.op !== "wait" || exited.timedOut || exited.daemon.exitCode !== 0) {
		throw new Error(`Probe ${name} did not exit successfully: ${JSON.stringify(exited)}`);
	}
	const logs = await client.request({
		op: "logs",
		name,
		lines: 20,
		head: true,
		follow: false,
		timeoutMs: 1_000,
	});
	if (logs.op !== "logs") throw new Error("Expected logs result");
	return logs.text;
}

describe.skipIf(process.platform === "win32" || !hasBash)("daemon broker POSIX PTY environment", () => {
	it("preserves explicit overrides across launch and restart while allowing explicit login shells", async () => {
		using tempDir = TempDir.createSync("@omp-pty-environment-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const home = path.join(tempDir.path(), "home");
		const newBin = path.join(tempDir.path(), "new-bin");
		const oldBin = path.join(tempDir.path(), "old-bin");
		await Promise.all([projectDir, home, newBin, oldBin].map(directory => fs.mkdir(directory)));

		for (const [directory, label] of [
			[newBin, "NEW"],
			[oldBin, "OLD"],
		]) {
			const executable = path.join(directory, "omp-version-probe");
			await Bun.write(executable, `#!/bin/sh\nprintf '${label}\\n'\n`);
			await fs.chmod(executable, 0o755);
		}
		await Bun.write(
			path.join(home, ".bash_profile"),
			'export PATH="$HOME/../old-bin:$PATH"\nexport OMP_PROFILE_MARKER=loaded\nexport OMP_APP_MODE=profile\n',
		);
		const childScript = path.join(projectDir, "probe.ts");
		await Bun.write(
			childScript,
			`const child = Bun.spawnSync(["omp-version-probe"], { stdout: "pipe", stderr: "pipe" });
console.log("SELECTED=" + child.stdout.toString().trim());
console.log("PATH=" + process.env.PATH);
console.log("MODE=" + process.env.OMP_APP_MODE);
console.log("PROFILE=" + process.env.OMP_PROFILE_MARKER);
console.log("ARGV=" + JSON.stringify(process.argv.slice(2)));
`,
		);

		const requestedPath = `${newBin}:/usr/bin:/bin`;
		const suppliedEnv = {
			HOME: home,
			PATH: requestedPath,
			OMP_APP_MODE: "caller",
			OMP_PROFILE_MARKER: "absent",
		};
		const literalArgs = ["a b", "literal'$HOME;not-a-command"];
		const previousShell = procmgr.getShellConfig().shell;
		procmgr.getShellConfig(BASH);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);

		try {
			await client.request({
				op: "start",
				spec: {
					name: "pty",
					application: process.execPath,
					args: [childScript, ...literalArgs],
					env: suppliedEnv,
					cwd: projectDir,
					pty: true,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			const launched = await collect(client, "pty");
			expect(launched).toContain("SELECTED=NEW");
			expect(launched).toContain(`PATH=${requestedPath}`);
			expect(launched).toContain("MODE=caller");
			expect(launched).toContain("PROFILE=absent");
			expect(launched).toContain(`ARGV=${JSON.stringify(literalArgs)}`);

			await client.request({ op: "restart", name: "pty" });
			const restarted = await collect(client, "pty");
			expect(restarted).toContain("SELECTED=NEW");
			expect(restarted).toContain(`PATH=${requestedPath}`);
			expect(restarted).toContain("MODE=caller");
			expect(restarted).toContain("PROFILE=absent");

			await client.request({
				op: "start",
				spec: {
					name: "explicit-shell",
					application: BASH,
					args: ["-lc", 'exec "$@"', "probe-shell", process.execPath, childScript, ...literalArgs],
					env: suppliedEnv,
					cwd: projectDir,
					pty: true,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			const explicitShell = await collect(client, "explicit-shell");
			expect(explicitShell).toContain("SELECTED=OLD");
			expect(explicitShell).toContain("MODE=profile");
			expect(explicitShell).toContain("PROFILE=loaded");
			expect(explicitShell).toContain(`ARGV=${JSON.stringify(literalArgs)}`);
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
			procmgr.getShellConfig(previousShell);
		}
	}, 20_000);
});
