import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	cleanupRuntimeResources,
	connectMcpServer,
	parseMcpServerConfigs,
	registerRuntimeResource,
	type McpServerConfig,
} from "./runtime-resources.ts";

export function toolName(server: string, name: string): string {
	return `mcp_${`${server}_${name}`.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 128);
}

function resultText(result: unknown): string {
	if (!result || typeof result !== "object") return String(result ?? "");
	const value = result as { content?: unknown; structuredContent?: unknown };
	if (Array.isArray(value.content)) {
		return value.content
			.map((block) => {
				if (block && typeof block === "object" && "text" in block)
					return String((block as { text?: unknown }).text ?? "");
				return JSON.stringify(block);
			})
			.join("\n");
	}
	return value.structuredContent
		? JSON.stringify(value.structuredContent, null, 2)
		: JSON.stringify(result);
}

function childConfigs(): Record<string, McpServerConfig> {
	try {
		return parseMcpServerConfigs(JSON.parse(process.env.PI_SUBAGENT_MCP_CONFIG ?? "{}"));
	} catch {
		return {};
	}
}

export default function mcpBridge(pi: ExtensionAPI): void {
	if (!process.env.PI_SUBAGENT_MCP_CONFIG) return;
	const runId = process.env.PI_SUBAGENT_RUN_ID ?? `mcp:${process.pid}`;
	const configs = childConfigs();
	const clients = new Map<string, Awaited<ReturnType<typeof connectMcpServer>>>();
	const activated = new Set<string>();
	const activationNames = new Map<string, string[]>();
	const registeredNames = new Map<string, { server: string; tool: string }>();
	const generations = new Map<string, number>();
	const pending = new Map<string, Promise<string[]>>();

	async function activateOnce(server: string): Promise<string[]> {
		if (!configs[server]) throw new Error(`Unknown MCP server ${server}`);
		const connection = await connectMcpServer(server, configs[server], runId);
		const generation = (generations.get(server) ?? 0) + 1;
		generations.set(server, generation);
		let unregisterResource: (() => void) | undefined;
		try {
			const listed = await connection.client.listTools();
			const names: string[] = [];
			const localNames = new Set<string>();
			for (const tool of listed.tools) {
				const registeredName = toolName(server, tool.name);
				const previous = registeredNames.get(registeredName);
				if (previous || localNames.has(registeredName)) {
					const owner = previous ? `${previous.server}/${previous.tool}` : `${server}/${tool.name}`;
					throw new Error(`MCP tool name collision: ${registeredName} (${owner})`);
				}
				localNames.add(registeredName);
				names.push(registeredName);
			}
			for (const [index, tool] of listed.tools.entries()) {
				const registeredName = names[index];
				registeredNames.set(registeredName, { server, tool: tool.name });
			}
			for (const [index, tool] of listed.tools.entries()) {
				const registeredName = names[index];
				pi.registerTool({
					name: registeredName,
					label: `MCP ${server}/${tool.name}`,
					description: tool.description ?? `MCP tool ${server}/${tool.name}`,
					parameters: Type.Unsafe(tool.inputSchema ?? { type: "object", properties: {} }),
					async execute(_toolCallId, params) {
						const current = clients.get(server);
						if (generations.get(server) !== generation || !current) {
							throw new Error(`MCP server ${server} activation is no longer active`);
						}
						const result = await current.client.callTool({
							name: tool.name,
							arguments: params as Record<string, unknown>,
						});
						return {
							content: [{ type: "text", text: resultText(result) }],
							details: { server, tool: tool.name, isError: result.isError === true },
						};
					},
				});
			}
			unregisterResource = registerRuntimeResource(runId, connection.resource);
			clients.set(server, connection);
			activated.add(server);
			activationNames.set(server, names);
			return names;
		} catch (error) {
			unregisterResource?.();
			for (const [name, owner] of registeredNames) {
				if (owner.server === server) registeredNames.delete(name);
			}
			await Promise.resolve(connection.resource.close()).catch(() => undefined);
			throw error;
		}
	}

	async function activate(server: string): Promise<string[]> {
		if (activated.has(server)) return activationNames.get(server) ?? [];
		const existing = pending.get(server);
		if (existing) return existing;
		const work = activateOnce(server);
		pending.set(server, work);
		try {
			return await work;
		} finally {
			if (pending.get(server) === work) pending.delete(server);
		}
	}

	pi.registerTool({
		name: "mcp_tool_search",
		label: "MCP Tool Search",
		description:
			"Activate one configured MCP server and discover its tools. Call the returned tool directly afterward.",
		parameters: Type.Object({
			query: Type.String({ description: "Server name or capability to activate" }),
			server: Type.Optional(Type.String({ description: "Exact MCP server name" })),
		}),
		async execute(_toolCallId, params: { query: string; server?: string }) {
			const query = (params.server ?? params.query ?? "").trim().toLowerCase();
			const candidates = Object.keys(configs).filter(
				(name) => name.toLowerCase().includes(query) || query.includes(name.toLowerCase()),
			);
			const matches = params.server ? [params.server] : candidates.length === 1 ? candidates : [];
			if (matches.length !== 1) {
				return {
					content: [
						{ type: "text", text: `Choose one MCP server: ${Object.keys(configs).join(", ")}` },
					],
					details: { servers: Object.keys(configs) },
				};
			}
			try {
				const tools = await activate(matches[0]);
				return {
					content: [
						{
							type: "text",
							text: `Activated MCP server ${matches[0]}; call these tools directly:\n${tools.join("\n")}`,
						},
					],
					details: { servers: Object.keys(configs) },
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `MCP server ${matches[0]} activation failed: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: { servers: Object.keys(configs) },
				};
			}
		},
	});

	pi.on("session_shutdown", async () => {
		await cleanupRuntimeResources(runId);
		clients.clear();
		activated.clear();
		activationNames.clear();
		registeredNames.clear();
		generations.clear();
		pending.clear();
	});
}
