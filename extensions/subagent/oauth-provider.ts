import type {
	OAuthClientProvider,
	OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";

interface State {
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
	discoveryState?: OAuthDiscoveryState;
}

export interface McpOAuthConfig {
	redirectUrl?: string;
	clientMetadata?: OAuthClientMetadata;
	clientMetadataUrl?: string;
	storageFile: string;
	callbackBindHost?: string;
}

export interface McpOAuthProvider extends OAuthClientProvider {
	waitForAuthorizationCode(): Promise<string>;
}

export function createMcpOAuthProvider(name: string, config: McpOAuthConfig): McpOAuthProvider {
	const read = (): State => {
		try {
			return JSON.parse(readFileSync(config.storageFile, "utf8")) as State;
		} catch {
			return {};
		}
	};
	const write = (state: State): void => {
		mkdirSync(dirname(config.storageFile), { recursive: true, mode: 0o700 });
		writeFileSync(config.storageFile, JSON.stringify(state, null, 2), { mode: 0o600 });
		chmodSync(config.storageFile, 0o600);
	};
	let authorizationCode: Promise<string> | undefined;
	let expectedState: string | undefined;
	const metadata = config.clientMetadata ?? {
		client_name: `pi-mine-${name}`,
		redirect_uris: config.redirectUrl ? [config.redirectUrl] : [],
		grant_types: ["authorization_code"],
		response_types: ["code"],
	};
	return {
		redirectUrl: config.redirectUrl,
		clientMetadataUrl: config.clientMetadataUrl,
		clientMetadata: metadata,
		state: () => (expectedState ??= randomUUID()),
		clientInformation: () => read().clientInformation,
		saveClientInformation: (value) => write({ ...read(), clientInformation: value }),
		tokens: () => read().tokens,
		saveTokens: (value) => write({ ...read(), tokens: value }),
		saveCodeVerifier: (value) => write({ ...read(), codeVerifier: value }),
		codeVerifier: () => {
			const value = read().codeVerifier;
			if (!value) throw new Error(`MCP OAuth code verifier is missing for ${name}`);
			return value;
		},
		redirectToAuthorization: (url) => {
			console.warn(`MCP OAuth authorization required for ${name}: ${url}`);
			if (!config.redirectUrl) return;
			authorizationCode = new Promise((resolve, reject) => {
				const callback = new URL(config.redirectUrl!);
				if (!/^https?:$/.test(callback.protocol)) {
					reject(new Error(`Unsupported MCP OAuth redirect protocol: ${callback.protocol}`));
					return;
				}
				const bindHost =
					config.callbackBindHost ??
					(callback.hostname === "localhost" || callback.hostname === "127.0.0.1"
						? callback.hostname
						: "0.0.0.0");
				const server = createServer((request, response) => {
					try {
						const incoming = new URL(request.url ?? "/", callback);
						if (incoming.pathname !== callback.pathname) {
							response.writeHead(404).end();
							return;
						}
						const error = incoming.searchParams.get("error");
						const code = incoming.searchParams.get("code");
						const state = incoming.searchParams.get("state");
						const invalidState = !expectedState || state !== expectedState;
						response.writeHead(error || !code || invalidState ? 400 : 200, {
							"content-type": "text/plain",
						});
						response.end(
							error
								? `OAuth failed: ${error}`
								: invalidState
									? "Invalid OAuth state"
									: "Authorization received. You may return to pi.",
						);
						server.close();
						if (error) reject(new Error(`OAuth authorization failed: ${error}`));
						else if (invalidState) reject(new Error("MCP OAuth state validation failed"));
						else resolve(code!);
					} catch (callbackError) {
						response.writeHead(400).end("Invalid OAuth callback");
						reject(callbackError);
					}
				});
				server.once("error", reject);
				server.listen(Number(callback.port || 80), bindHost);
			});
		},
		invalidateCredentials: (scope) => {
			const state = read();
			if (scope === "all" || scope === "client") delete state.clientInformation;
			if (scope === "all" || scope === "tokens") delete state.tokens;
			if (scope === "all" || scope === "verifier") delete state.codeVerifier;
			if (scope === "all" || scope === "discovery") delete state.discoveryState;
			write(state);
		},
		saveDiscoveryState: (value) => write({ ...read(), discoveryState: value }),
		discoveryState: () => read().discoveryState,
		waitForAuthorizationCode: async () => {
			if (!authorizationCode) throw new Error(`MCP OAuth callback is not pending for ${name}`);
			return authorizationCode;
		},
	};
}
