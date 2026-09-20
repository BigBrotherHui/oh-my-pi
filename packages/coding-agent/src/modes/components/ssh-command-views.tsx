import "@oh-my-pi/pi-tui/host/intrinsics";
import type { JSX } from "@oh-my-pi/pi-tui/reactive";

/** The retained help surface for `/ssh`. */
export function SshHelpView(): JSX.Element {
	const commands = [
		[
			"/ssh add <name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--desc <description>] [--compat] [--scope project|user]",
			"Add an SSH host",
		],
		["/ssh list", "List all configured SSH hosts"],
		["/ssh remove <name> [--scope project|user]", "Remove an SSH host (default: project)"],
		["/ssh help", "Show this help message"],
	];
	return (
		<stack gap={1}>
			<text bold>SSH Host Management</text>
			<text>Manage SSH host configurations for remote command execution.</text>
			<text color="accent" bold>
				Commands
			</text>
			<table
				columns={[
					{ grow: 3, minWidth: 26 },
					{ grow: 2, minWidth: 20 },
				]}
				rows={commands.map(([command, description]) => [
					{ text: command, color: "accent" },
					{ text: description, color: "dim" },
				])}
			/>
		</stack>
	);
}

/** The retained confirmation for a newly configured SSH host. */
export function SshAddedView(props: {
	readonly name: string;
	readonly scope: "user" | "project";
	readonly host: string;
	readonly username?: string;
	readonly port?: number;
	readonly keyPath?: string;
	readonly description?: string;
	readonly compat: boolean;
}): JSX.Element {
	const details: { label: string; value: string }[] = [{ label: "Host", value: props.host }];
	if (props.username) details.push({ label: "User", value: props.username });
	if (props.port) details.push({ label: "Port", value: String(props.port) });
	if (props.description) details.push({ label: "Desc", value: props.description });
	if (props.compat) details.push({ label: "Compat", value: "true" });
	return (
		<stack gap={1}>
			<row gap={1}>
				<status value="success" />
				<text color="success">{`Added SSH host “${props.name}” to ${props.scope} config`}</text>
			</row>
			<table
				columns={[{ minWidth: 8 }, { grow: 1 }]}
				rows={details.map(detail => [{ text: detail.label, color: "dim" }, detail.value])}
			/>
			{props.keyPath ? (
				<row gap={1}>
					<text color="dim" minWidth={8}>
						Key
					</text>
					<path value={props.keyPath} grow={1} overflow="middle" />
				</row>
			) : null}
			<text color="muted">
				Run <span color="accent">/ssh list</span> to see all configured hosts.
			</text>
		</stack>
	);
}

type SshHost = { readonly name: string; readonly host?: string; readonly username?: string; readonly port?: number };
type SshGroup = {
	readonly label: string;
	readonly path?: string;
	readonly readOnly?: boolean;
	readonly hosts: readonly SshHost[];
};

/** The retained SSH host list, with profile source and connection metadata. */
export function SshHostListView(props: { readonly groups: readonly SshGroup[] }): JSX.Element {
	return (
		<stack gap={1}>
			<text bold>Configured SSH Hosts</text>
			{props.groups.length === 0 ? (
				<stack gap={1}>
					<text color="muted">No SSH hosts configured.</text>
					<text>
						Use <span color="accent">/ssh add</span> to add a host.
					</text>
				</stack>
			) : (
				props.groups.map(group => (
					<stack gap={0}>
						<row gap={1}>
							<text color="accent" bold>
								{group.label}
							</text>
							{group.path ? <path value={group.path} color="muted" grow={1} overflow="middle" /> : null}
							{group.readOnly ? <text color="dim">read-only</text> : null}
						</row>
						{group.hosts.map(host => (
							<row gap={1}>
								<text color="accent" minWidth={16}>
									{host.name}
								</text>
								<text>{host.host ?? ""}</text>
								{host.username ? <text color="dim">{`user=${host.username}`}</text> : null}
								{host.port && host.port !== 22 ? <text color="dim">{`port=${host.port}`}</text> : null}
							</row>
						))}
					</stack>
				))
			)}
		</stack>
	);
}

/** The retained confirmation for a removed SSH profile. */
export function SshRemovedView(props: { readonly name: string; readonly scope: "user" | "project" }): JSX.Element {
	return (
		<row gap={1}>
			<status value="success" />
			<text color="success">{`Removed SSH host “${props.name}” from ${props.scope} config`}</text>
		</row>
	);
}
