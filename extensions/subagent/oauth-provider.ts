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
import { constants, chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
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
	closeAuthorization(): Promise<void>;
}

export function createMcpOAuthProvider(name: string, config: McpOAuthConfig): McpOAuthProvider {
	const directory = dirname(config.storageFile);
	const read = (): State => {
		try {
			const stat = lstatSync(config.storageFile);
			if (!stat.isFile() || (stat.mode & constants.S_IFMT) !== constants.S_IFREG)
				throw new Error("OAuth storage is not a regular file");
			return JSON.parse(readFileSync(config.storageFile, "utf8")) as State;
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
			throw error;
		}
	};
	const write = (state: State): void => {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		const existing = (() => {
			try { return lstatSync(config.storageFile); } catch { return undefined; }
		})();
		if (existing && (!existing.isFile() || (existing.mode & constants.S_IFMT) !== constants.S_IFREG))
			throw new Error("OAuth storage is not a regular file");
		const temporary = `${config.storageFile}.${process.pid}.${randomUUID()}.tmp`;
		const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
		try {
			chmodSync(temporary, 0o600);
			writeSync(fd, JSON.stringify(state, null, 2));
			fsyncSync(fd);
			closeSync(fd);
			renameSync(temporary, config.storageFile);
		} catch (error) {
			try { closeSync(fd); } catch {}
			try { unlinkSync(temporary); } catch {}
			throw error;
		}
	};
	let authorizationCode: Promise<string> | undefined;
	let closeAuthorization = async (): Promise<void> => {};
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
				if (callback.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(callback.hostname) || !callback.port) {
					reject(new Error("MCP OAuth redirect must be http loopback with an explicit port"));
					return;
				}
				const bindHost = callback.hostname === "[::1]" ? "::1" : callback.hostname;
				let settled = false;
				let timer: NodeJS.Timeout | undefined;
				let server: ReturnType<typeof createServer>;
				const finish = (error?: Error, code?: string) => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					closeAuthorization = async () => {};
					server.close();
					if (error) reject(error); else resolve(code!);
				};
				closeAuthorization = async () => finish(new Error("MCP OAuth authorization cancelled"));
				server = createServer((request, response) => {
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
						if (error) finish(new Error(`OAuth authorization failed: ${error}`));
						else if (invalidState) finish(new Error("MCP OAuth state validation failed"));
						else finish(undefined, code!);
					} catch (callbackError) {
						response.writeHead(400).end("Invalid OAuth callback");
						finish(callbackError instanceof Error ? callbackError : new Error(String(callbackError)));
					}
				});
				server.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
				timer = setTimeout(() => finish(new Error("MCP OAuth authorization timed out")), 120_000);
				server.listen(Number(callback.port), bindHost);
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
		closeAuthorization: () => closeAuthorization(),
	};
}
