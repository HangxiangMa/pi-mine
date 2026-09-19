import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createMcpOAuthProvider, type McpOAuthProvider } from "./oauth-provider.ts";

/** Idempotent cleanup registry for resources owned by a routed child run. */
export interface RuntimeResource {
	kind: "mcp" | "shell" | "worktree" | "other";
	name?: string;
	close: () => void | Promise<void>;
}

export interface McpServerConfig {
	type?: "stdio" | "sse" | "http";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	oauth?: {
		redirectUrl?: string;
		clientMetadata?: OAuthClientMetadata;
		clientMetadataUrl?: string;
		storageFile?: string;
		callbackBindHost?: string;
	};
}

export interface McpClientHandle {
	close?: () => void | Promise<void>;
	disconnect?: () => void | Promise<void>;
	shutdown?: () => void | Promise<void>;
}

export interface McpRuntimeLifecycle {
	start: (
		serverNames: readonly string[],
		runId: string,
	) => readonly RuntimeResource[] | Promise<readonly RuntimeResource[]>;
}

const MCP_CONFIG_FILE = "mcp.json";

function configPath(): string {
	return (
		process.env.PI_MCP_SERVERS_FILE ??
		join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), MCP_CONFIG_FILE)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseMcpServerConfigs(raw: unknown): Record<string, McpServerConfig> {
	if (!isRecord(raw)) return {};
	const servers = isRecord(raw.mcpServers) ? raw.mcpServers : raw;
	const result: Record<string, McpServerConfig> = {};
	for (const [name, value] of Object.entries(servers)) {
		if (!isRecord(value)) continue;
		const config: McpServerConfig = {
			type: value.type === "sse" || value.type === "http" ? value.type : "stdio",
			command: typeof value.command === "string" ? value.command : undefined,
			args: Array.isArray(value.args)
				? value.args.filter((arg): arg is string => typeof arg === "string")
				: [],
			env: isRecord(value.env)
				? Object.fromEntries(
						Object.entries(value.env).filter(
							(entry): entry is [string, string] => typeof entry[1] === "string",
						),
					)
				: undefined,
			url: typeof value.url === "string" ? value.url : undefined,
			headers: isRecord(value.headers)
				? Object.fromEntries(
						Object.entries(value.headers).filter(
							(entry): entry is [string, string] => typeof entry[1] === "string",
						),
					)
				: undefined,
			oauth: isRecord(value.oauth)
				? {
						redirectUrl:
							typeof value.oauth.redirectUrl === "string" ? value.oauth.redirectUrl : undefined,
						clientMetadata: isRecord(value.oauth.clientMetadata)
							? (value.oauth.clientMetadata as OAuthClientMetadata)
							: undefined,
						clientMetadataUrl:
							typeof value.oauth.clientMetadataUrl === "string"
								? value.oauth.clientMetadataUrl
								: undefined,
						storageFile:
							typeof value.oauth.storageFile === "string" ? value.oauth.storageFile : undefined,
						callbackBindHost:
							typeof value.oauth.callbackBindHost === "string"
								? value.oauth.callbackBindHost
								: undefined,
					}
				: undefined,
		};
		if (config.type === "stdio" ? config.command : config.url) result[name] = config;
	}
	return result;
}

export function loadMcpServerConfigs(
	serverNames: readonly string[],
): Record<string, McpServerConfig> {
	if (serverNames.length === 0) return {};
	try {
		const raw = process.env.PI_MCP_SERVERS_JSON
			? JSON.parse(process.env.PI_MCP_SERVERS_JSON)
			: existsSync(configPath())
				? JSON.parse(readFileSync(configPath(), "utf8"))
				: {};
		const all = parseMcpServerConfigs(raw);
		const selected: Record<string, McpServerConfig> = {};
		for (const name of serverNames) {
			if (all[name]) selected[name] = all[name];
		}
		return selected;
	} catch {
		return {};
	}
}

function subprocessEnv(extra: Record<string, string> | undefined): Record<string, string> {
	return {
		...Object.fromEntries(
			Object.entries(process.env).filter(
				(entry): entry is [string, string] => entry[1] !== undefined,
			),
		),
		...extra,
	};
}

export async function connectMcpServer(
	name: string,
	config: McpServerConfig,
): Promise<{ client: Client; resource: RuntimeResource }> {
	const client = new Client({ name: `pi-mine-${name}`, version: "0.1.0" });
	const headers = config.headers ? new Headers(config.headers) : undefined;
	const authProvider: McpOAuthProvider | undefined = config.oauth
		? createMcpOAuthProvider(name, {
				...config.oauth,
				storageFile:
					config.oauth.storageFile ??
					join(
						process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
						"mcp-oauth",
						`${name}.json`,
					),
			})
		: undefined;
	const transport =
		config.type === "sse"
			? new SSEClientTransport(new URL(config.url!), {
					requestInit: headers ? { headers } : undefined,
					authProvider,
				})
			: config.type === "http"
				? new StreamableHTTPClientTransport(new URL(config.url!), {
						requestInit: headers ? { headers } : undefined,
						authProvider,
					})
				: new StdioClientTransport({
						command: config.command!,
						args: config.args ?? [],
						env: subprocessEnv(config.env),
					});
	try {
		await client.connect(transport);
	} catch (error) {
		const finishAuth = (transport as { finishAuth?: (code: string) => Promise<void> }).finishAuth;
		if (!authProvider || !finishAuth) throw error;
		await finishAuth.call(transport, await authProvider.waitForAuthorizationCode());
		await client.connect(transport);
	}
	return {
		client,
		resource: {
			kind: "mcp",
			name,
			close: () => client.close(),
		},
	};
}

export function registerMcpClient(
	runId: string,
	name: string,
	client: McpClientHandle,
): () => void {
	const close = client.close ?? client.disconnect ?? client.shutdown;
	if (!close) throw new Error(`MCP client ${name} has no close, disconnect, or shutdown method`);
	return registerRuntimeResource(runId, { kind: "mcp", name, close: () => close.call(client) });
}

const resources = new Map<string, Set<RuntimeResource>>();

export function registerRuntimeResource(runId: string, resource: RuntimeResource): () => void {
	const set = resources.get(runId) ?? new Set<RuntimeResource>();
	set.add(resource);
	resources.set(runId, set);
	return () => {
		set.delete(resource);
		if (set.size === 0) resources.delete(runId);
	};
}

export async function startMcpRuntime(
	runId: string,
	serverNames: readonly string[],
	lifecycle?: McpRuntimeLifecycle,
): Promise<{ started: number; failed: number }> {
	if (serverNames.length === 0) return { started: 0, failed: 0 };
	if (!lifecycle) return { started: 0, failed: 1 };
	try {
		const startedResources = await lifecycle.start(serverNames, runId);
		let started = 0;
		for (const resource of startedResources) {
			registerRuntimeResource(runId, resource);
			started++;
		}
		return { started, failed: 0 };
	} catch {
		return { started: 0, failed: 1 };
	}
}

export async function cleanupRuntimeResources(
	runId: string,
): Promise<{ cleaned: number; failed: number }> {
	const set = resources.get(runId);
	if (!set) return { cleaned: 0, failed: 0 };
	resources.delete(runId);
	let cleaned = 0;
	let failed = 0;
	for (const resource of [...set].reverse()) {
		try {
			await resource.close();
			cleaned++;
		} catch {
			failed++;
		}
	}
	return { cleaned, failed };
}

export function runtimeResourceSnapshot(
	runId?: string,
): Array<{ runId: string; kind: RuntimeResource["kind"] }> {
	const result: Array<{ runId: string; kind: RuntimeResource["kind"] }> = [];
	for (const [id, set] of resources) {
		if (runId && id !== runId) continue;
		for (const resource of set) result.push({ runId: id, kind: resource.kind });
	}
	return result;
}
