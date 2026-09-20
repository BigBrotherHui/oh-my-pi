/**
 * SSH Command Controller
 *
 * Handles /ssh subcommands for managing SSH host configurations.
 */
import { getProjectDir, getSSHConfigPath } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../../capability";
import { type SSHHost, sshCapability } from "../../capability/ssh";
import { loadCapability } from "../../discovery";
import { addSSHHost, readSSHConfigFile, removeSSHHost, type SSHHostConfig } from "../../ssh/config-writer";
import { parseCommandArgs } from "../../utils/command-args";
import type { InteractiveModeContext } from "../types";
import { SshAddedView, SshHelpView, SshHostListView, SshRemovedView } from "../components/ssh-command-views";
import { groupBySource, parseRemoveArgs, readScopeFlag, type ScopeValue } from "./command-controller-shared";

export class SSHCommandController {
	constructor(private ctx: InteractiveModeContext) {}

	/**
	 * Handle /ssh command and route to subcommands
	 */
	async handle(text: string): Promise<void> {
		const parts = text.trim().split(/\s+/);
		const subcommand = parts[1]?.toLowerCase();

		if (!subcommand || subcommand === "help") {
			this.#showHelp();
			return;
		}

		switch (subcommand) {
			case "add":
				await this.#handleAdd(text);
				break;
			case "list":
				await this.#handleList();
				break;
			case "remove":
			case "rm":
				await this.#handleRemove(text);
				break;
			default:
				this.ctx.showError(`Unknown subcommand: ${subcommand}. Type /ssh help for usage.`);
		}
	}

	/**
	 * Show help text
	 */
	#showHelp(): void {
		this.ctx.presentCommandOutput(SshHelpView());
	}

	/**
	 * Handle /ssh add - parse flags and add host to config
	 */
	async #handleAdd(text: string): Promise<void> {
		const prefixMatch = text.match(/^\/ssh\s+add\b\s*(.*)$/i);
		const rest = prefixMatch?.[1]?.trim() ?? "";
		if (!rest) {
			this.ctx.showError(
				"Usage: /ssh add <name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--desc <description>] [--compat] [--scope project|user]",
			);
			return;
		}

		const tokens = parseCommandArgs(rest);
		if (tokens.length === 0) {
			this.ctx.showError(
				"Usage: /ssh add <name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--desc <description>] [--compat] [--scope project|user]",
			);
			return;
		}

		let name: string | undefined;
		let scope: ScopeValue = "project";
		let host: string | undefined;
		let username: string | undefined;
		let port: number | undefined;
		let keyPath: string | undefined;
		let description: string | undefined;
		let compat = false;

		let i = 0;
		if (!tokens[0].startsWith("-")) {
			name = tokens[0];
			i = 1;
		}

		while (i < tokens.length) {
			const argToken = tokens[i];
			if (argToken === "--host") {
				const value = tokens[i + 1];
				if (!value) {
					this.ctx.showError("Missing value for --host.");
					return;
				}
				host = value;
				i += 2;
				continue;
			}
			if (argToken === "--user") {
				const value = tokens[i + 1];
				if (!value) {
					this.ctx.showError("Missing value for --user.");
					return;
				}
				username = value;
				i += 2;
				continue;
			}
			if (argToken === "--port") {
				const value = tokens[i + 1];
				if (!value) {
					this.ctx.showError("Missing value for --port.");
					return;
				}
				const parsed = Number.parseInt(value, 10);
				if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
					this.ctx.showError("Invalid --port value. Must be an integer between 1 and 65535.");
					return;
				}
				port = parsed;
				i += 2;
				continue;
			}
			if (argToken === "--key") {
				const value = tokens[i + 1];
				if (!value) {
					this.ctx.showError("Missing value for --key.");
					return;
				}
				keyPath = value;
				i += 2;
				continue;
			}
			if (argToken === "--desc") {
				const value = tokens[i + 1];
				if (!value) {
					this.ctx.showError("Missing value for --desc.");
					return;
				}
				description = value;
				i += 2;
				continue;
			}
			if (argToken === "--compat") {
				compat = true;
				i += 1;
				continue;
			}
			if (argToken === "--scope") {
				const r = readScopeFlag(tokens[i + 1]);
				if (!r.ok) {
					this.ctx.showError(r.error);
					return;
				}
				scope = r.scope;
				i += 2;
				continue;
			}
			this.ctx.showError(`Unknown option: ${argToken}`);
			return;
		}

		if (!name) {
			this.ctx.showError("Host name required. Usage: /ssh add <name> --host <host> ...");
			return;
		}

		if (!host) {
			this.ctx.showError("--host is required. Usage: /ssh add <name> --host <host> ...");
			return;
		}

		try {
			const cwd = getProjectDir();
			const filePath = getSSHConfigPath(scope, cwd);

			const hostConfig: SSHHostConfig = { host };
			if (username) hostConfig.username = username;
			if (port) hostConfig.port = port;
			if (keyPath) hostConfig.keyPath = keyPath;
			if (description) hostConfig.description = description;
			if (compat) hostConfig.compat = true;

			await addSSHHost(filePath, name, hostConfig);
			resetCapabilities();

			this.ctx.presentCommandOutput(
				SshAddedView({ name, scope, host, username, port, keyPath, description, compat }),
			);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);

			const helpText = errorMsg.includes("already exists")
				? " Tip: Use /ssh remove first, or choose a different name."
				: "";
			this.ctx.showError(`Failed to add host: ${errorMsg}${helpText}`);
		}
	}

	/**
	 * Handle /ssh list - show all configured SSH hosts
	 */
	async #handleList(): Promise<void> {
		try {
			const cwd = getProjectDir();

			// Load from both user and project configs
			const userPath = getSSHConfigPath("user", cwd);
			const projectPath = getSSHConfigPath("project", cwd);

			const [userConfig, projectConfig] = await Promise.all([
				readSSHConfigFile(userPath),
				readSSHConfigFile(projectPath),
			]);

			const userHosts = Object.keys(userConfig.hosts ?? {});
			const projectHosts = Object.keys(projectConfig.hosts ?? {});

			// Load discovered hosts via capability system
			const configHostNames = new Set([...userHosts, ...projectHosts]);
			let discoveredHosts: SSHHost[] = [];
			try {
				const result = await loadCapability<SSHHost>(sshCapability.id, { cwd });
				discoveredHosts = result.items.filter(h => !configHostNames.has(h.name));
			} catch {
				// Ignore discovery errors
			}

			if (userHosts.length === 0 && projectHosts.length === 0 && discoveredHosts.length === 0) {
				this.ctx.presentCommandOutput(SshHostListView({ groups: [] }));
				return;
			}

			const groups = [
				...(userHosts.length > 0
					? [
							{
								label: "User level",
								path: userPath,
								hosts: userHosts.map(name => ({ name, ...userConfig.hosts![name] })),
							},
						]
					: []),
				...(projectHosts.length > 0
					? [
							{
								label: "Project level",
								path: projectPath,
								hosts: projectHosts.map(name => ({ name, ...projectConfig.hosts![name] })),
							},
						]
					: []),
				...Array.from(
					groupBySource(discoveredHosts, host => host._source),
					({ providerName, shortPath, items: hosts }) => ({
						label: `Discovered · ${providerName}`,
						path: shortPath,
						readOnly: true,
						hosts: hosts.map(host => ({
							name: host.name,
							host: host.host,
							username: host.username,
							port: host.port,
						})),
					}),
				),
			];
			this.ctx.presentCommandOutput(SshHostListView({ groups }));
		} catch (error) {
			this.ctx.showError(`Failed to list hosts: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Handle /ssh remove <name> - remove a host from config
	 */
	async #handleRemove(text: string): Promise<void> {
		const match = text.match(/^\/ssh\s+(?:remove|rm)\b\s*(.*)$/i);
		const rest = match?.[1]?.trim() ?? "";
		const parsed = parseRemoveArgs(rest);
		if (!parsed.ok) {
			this.ctx.showError(parsed.error);
			return;
		}
		const { name, scope } = parsed.value;
		if (!name) {
			this.ctx.showError("Host name required. Usage: /ssh remove <name> [--scope project|user]");
			return;
		}

		try {
			const cwd = getProjectDir();
			const filePath = getSSHConfigPath(scope, cwd);
			const config = await readSSHConfigFile(filePath);
			if (!config.hosts?.[name]) {
				this.ctx.showError(`Host "${name}" not found in ${scope} config.`);
				return;
			}

			await removeSSHHost(filePath, name);
			resetCapabilities();

			this.ctx.presentCommandOutput(SshRemovedView({ name, scope }));
		} catch (error) {
			this.ctx.showError(`Failed to remove host: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
