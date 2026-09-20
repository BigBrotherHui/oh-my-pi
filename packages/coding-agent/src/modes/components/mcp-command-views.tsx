import "@oh-my-pi/pi-tui/host/intrinsics";
import type { JSX } from "@oh-my-pi/pi-tui/reactive";
import type { ThemeColor } from "@oh-my-pi/pi-tui/theme";

/** A styled transient result for an MCP command. */
export function McpNoticeView(props: {
	readonly text: string;
	readonly color?: ThemeColor;
	readonly detail?: string;
	readonly command?: string;
}): JSX.Element {
	return (
		<stack gap={1}>
			<text color={props.color ?? "muted"}>{props.text}</text>
			{props.detail ? (
				<text color="dim" wrap="word">
					{props.detail}
				</text>
			) : null}
			{props.command ? <text color="accent">{props.command}</text> : null}
		</stack>
	);
}

/** The retained help surface for `/mcp`. */
export function McpHelpView(): JSX.Element {
	const commands = [
		["/mcp add", "Add a new MCP server (interactive wizard)"],
		[
			"/mcp add <name> [--scope project|user] [--url <url> --transport http|sse] [--token <token>] [-- <command…>]",
			"Quick add",
		],
		["/mcp list", "List all configured MCP servers"],
		["/mcp remove <name> [--scope project|user]", "Remove an MCP server (default: project)"],
		["/mcp test <name>", "Test connection to an MCP server"],
		["/mcp reauth <name>", "Reauthorize OAuth for an MCP server"],
		["/mcp unauth <name>", "Remove OAuth auth from an MCP server"],
		["/mcp enable <name>", "Enable an MCP server"],
		["/mcp disable <name>", "Disable an MCP server"],
		[
			"/mcp smithery-search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			"Search Smithery registry and deploy from picker",
		],
		["/mcp smithery-login", "Login to Smithery and cache API key"],
		["/mcp smithery-logout", "Remove cached Smithery API key"],
		["/mcp reconnect <name>", "Reconnect to a specific MCP server"],
		["/mcp reload", "Force reload and rediscover MCP runtime tools"],
		["/mcp resources", "List available resources from connected servers"],
		["/mcp prompts", "List available prompts from connected servers"],
		["/mcp notifications", "Show notification capabilities and subscription state"],
		["/mcp help", "Show this help message"],
	];
	return (
		<stack gap={1}>
			<text bold>MCP Server Management</text>
			<text>Manage Model Context Protocol (MCP) servers for external tool integrations.</text>
			<text color="accent" bold>
				Commands
			</text>
			<table
				columns={[
					{ grow: 3, minWidth: 24 },
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

/** The retained post-addition summary, including the connection state. */
export function McpAddedView(props: {
	readonly name: string;
	readonly scope: "user" | "project";
	readonly state: "connected" | "connecting" | "disconnected";
}): JSX.Element {
	const state = props.state;
	return (
		<stack gap={1}>
			<row gap={1}>
				<status value="success" />
				<text color="success">{`Added server “${props.name}” to ${props.scope} config`}</text>
			</row>
			{state === "connected" ? (
				<row gap={1}>
					<status value="success" />
					<text color="success">Successfully connected to server</text>
				</row>
			) : null}
			{state === "connecting" ? (
				<stack gap={0}>
					<row gap={1}>
						<status value="pending" />
						<text color="muted">Server is connecting in background…</text>
					</row>
					<text color="muted">
						Run <span color="accent">{`/mcp test ${props.name}`}</span> in a few seconds.
					</text>
				</stack>
			) : null}
			{state === "disconnected" ? (
				<stack gap={0}>
					<row gap={1}>
						<status value="warning" />
						<text color="warning">Server added but not yet connected</text>
					</row>
					<text color="muted">
						Run <span color="accent">{`/mcp test ${props.name}`}</span> to test the connection.
					</text>
				</stack>
			) : null}
			<text color="muted">
				Run <span color="accent">/mcp list</span> to see all configured servers.
			</text>
		</stack>
	);
}

type McpServerRow = { readonly name: string; readonly type?: string; readonly state: string };
type McpServerGroup = {
	readonly label: string;
	readonly path?: string;
	readonly readOnly?: boolean;
	readonly servers: readonly McpServerRow[];
};

function McpServerStatus(props: { readonly state: string }): JSX.Element {
	const label =
		props.state === "inactive"
			? "inactive"
			: props.state === "connected"
				? "connected"
				: props.state === "connecting"
					? "connecting"
					: props.state === "disabled"
						? "disabled"
						: "not connected";
	const value =
		props.state === "connected"
			? "success"
			: props.state === "inactive" || props.state === "disabled"
				? "warning"
				: props.state === "connecting"
					? "pending"
					: "info";
	return (
		<row gap={1}>
			<status value={value} />
			<text color={value === "success" ? "success" : value === "warning" ? "warning" : "muted"}>{label}</text>
		</row>
	);
}

/** The retained server list, preserving source, disabled, and connection distinctions. */
export function McpServerListView(props: { readonly groups: readonly McpServerGroup[] }): JSX.Element {
	return (
		<stack gap={1}>
			<text bold>Configured MCP Servers</text>
			{props.groups.map(group => (
				<stack gap={0}>
					<row gap={1}>
						<text color="accent" bold>
							{group.label}
						</text>
						{group.path ? <path value={group.path} color="muted" grow={1} overflow="middle" /> : null}
						{group.readOnly ? <text color="dim">read-only</text> : null}
					</row>
					{group.servers.map(server => (
						<row gap={1}>
							<text color="accent" minWidth={16}>
								{server.name}
							</text>
							<McpServerStatus state={server.state} />
							{server.type ? <text color="dim">{`[${server.type}]`}</text> : null}
						</row>
					))}
				</stack>
			))}
		</stack>
	);
}

/** The successful `/mcp test` result, including server metadata and tools. */
export function McpTestResultView(props: {
	readonly name: string;
	readonly serverName: string;
	readonly version: string;
	readonly tools: readonly string[];
}): JSX.Element {
	return (
		<stack gap={1}>
			<row gap={1}>
				<status value="success" />
				<text color="success">{`Successfully connected to “${props.name}”`}</text>
			</row>
			<table
				columns={[{ minWidth: 10 }, { grow: 1 }]}
				rows={[
					[{ text: "Server", color: "dim" }, props.serverName],
					[{ text: "Version", color: "dim" }, props.version],
					[{ text: "Tools", color: "dim" }, String(props.tools.length)],
				]}
			/>
			{props.tools.length > 0 && props.tools.length <= 10 ? (
				<stack gap={0}>
					<text color="muted">Available tools</text>
					{props.tools.map(tool => (
						<text color="accent">{tool}</text>
					))}
				</stack>
			) : null}
		</stack>
	);
}

/** The retained resource catalogue for connected MCP servers. */
export function McpResourcesView(props: {
	readonly groups: readonly {
		readonly name: string;
		readonly resources: readonly {
			readonly uri: string;
			readonly mimeType?: string;
			readonly description?: string;
		}[];
		readonly templates: readonly { readonly uriTemplate: string; readonly description?: string }[];
	}[];
}): JSX.Element {
	return (
		<stack gap={1}>
			<text bold>MCP Resources</text>
			{props.groups.length === 0 ? (
				<text color="muted">No resources available on connected servers.</text>
			) : (
				props.groups.map(group => (
					<stack gap={0}>
						<text color="accent" bold>
							{group.name}
						</text>
						{group.resources.map(resource => (
							<row gap={1}>
								<link href={resource.uri} color="success">
									{resource.uri}
								</link>
								{resource.mimeType ? <text color="dim">{`[${resource.mimeType}]`}</text> : null}
								{resource.description ? (
									<text color="dim" grow={1} wrap="word">
										{resource.description}
									</text>
								) : null}
							</row>
						))}
						{group.templates.length > 0 ? (
							<stack gap={0}>
								<text color="muted">Templates</text>
								{group.templates.map(template => (
									<row gap={1}>
										<text color="accent">{template.uriTemplate}</text>
										{template.description ? (
											<text color="dim" grow={1} wrap="word">
												{template.description}
											</text>
										) : null}
									</row>
								))}
							</stack>
						) : null}
					</stack>
				))
			)}
		</stack>
	);
}

/** The retained prompt catalogue for connected MCP servers. */
export function McpPromptsView(props: {
	readonly groups: readonly {
		readonly name: string;
		readonly prompts: readonly {
			readonly name: string;
			readonly description?: string;
			readonly arguments?: readonly {
				readonly name: string;
				readonly required?: boolean;
				readonly description?: string;
			}[];
		}[];
	}[];
}): JSX.Element {
	return (
		<stack gap={1}>
			<text bold>MCP Prompts</text>
			{props.groups.length === 0 ? (
				<text color="muted">No prompts available on connected servers.</text>
			) : (
				props.groups.map(group => (
					<stack gap={0}>
						<text color="accent" bold>
							{group.name}
						</text>
						{group.prompts.map(prompt => (
							<stack gap={0}>
								<row gap={1}>
									<text color="success">{`/${group.name}:${prompt.name}`}</text>
									{prompt.description ? (
										<text color="dim" grow={1} wrap="word">
											{prompt.description}
										</text>
									) : null}
								</row>
								{prompt.arguments?.map(argument => (
									<row gap={1}>
										<text>{`${argument.name}=`}</text>
										{argument.required ? (
											<text color="warning">required</text>
										) : (
											<text color="dim">optional</text>
										)}
										{argument.description ? (
											<text color="dim" grow={1} wrap="word">
												{argument.description}
											</text>
										) : null}
									</row>
								))}
							</stack>
						))}
					</stack>
				))
			)}
		</stack>
	);
}

/** The retained notification capability and subscription summary. */
export function McpNotificationsView(props: {
	readonly enabled: boolean;
	readonly groups: readonly {
		readonly name: string;
		readonly toolsChanged: boolean;
		readonly resourcesChanged: boolean;
		readonly promptsChanged: boolean;
		readonly supportsSubscribe: boolean;
		readonly supportsResources: boolean;
		readonly subscriptions: readonly string[];
	}[];
}): JSX.Element {
	return (
		<stack gap={1}>
			<row gap={1}>
				<text bold>MCP Notifications</text>
				<status value={props.enabled ? "success" : "warning"} />
				<text color={props.enabled ? "success" : "warning"}>{props.enabled ? "enabled" : "disabled"}</text>
				<text color="dim">mcp.notifications setting</text>
			</row>
			{props.groups.length === 0 ? (
				<text color="muted">No servers support notifications.</text>
			) : (
				props.groups.map(group => (
					<stack gap={0}>
						<text color="accent" bold>
							{group.name}
						</text>
						{group.toolsChanged ? (
							<row gap={1}>
								<status value="success" />
								<text>tools/list_changed</text>
							</row>
						) : null}
						{group.resourcesChanged ? (
							<row gap={1}>
								<status value="success" />
								<text>resources/list_changed</text>
							</row>
						) : null}
						{group.promptsChanged ? (
							<row gap={1}>
								<status value="success" />
								<text>prompts/list_changed</text>
							</row>
						) : null}
						{group.supportsSubscribe ? (
							<stack gap={0}>
								<row gap={1}>
									<status value="success" />
									<text>resources/subscribe</text>
									<text
										color={
											props.enabled && group.subscriptions.length > 0
												? "success"
												: props.enabled
													? "muted"
													: "dim"
										}
									>
										{props.enabled && group.subscriptions.length > 0
											? `subscribed (${group.subscriptions.length} URI${group.subscriptions.length === 1 ? "" : "s"})`
											: props.enabled
												? "no active subscriptions"
												: "inactive (notifications disabled)"}
									</text>
								</row>
								{props.enabled
									? group.subscriptions.map(uri => (
											<row gap={1}>
												<status value="success" />
												<link href={uri} color="muted">
													{uri}
												</link>
											</row>
										))
									: null}
							</stack>
						) : group.supportsResources ? (
							<row gap={1}>
								<status value="info" />
								<text>resources/subscribe</text>
								<text color="dim">not supported</text>
							</row>
						) : null}
					</stack>
				))
			)}
		</stack>
	);
}

/** The retained browser-login surface for Smithery. */
export function SmitheryBrowserLoginView(props: {
	readonly authorizationUrl: string;
	readonly fallbackUrl: string;
}): JSX.Element {
	return (
		<stack gap={1}>
			<text bold>Smithery Login</text>
			<text color="muted">Browser authorization started. Complete auth in your browser.</text>
			<text color="dim">Authorize URL</text>
			<link href={props.authorizationUrl} color="accent">
				{props.authorizationUrl}
			</link>
			<text color="dim">{`Fallback: ${props.fallbackUrl}`}</text>
		</stack>
	);
}
