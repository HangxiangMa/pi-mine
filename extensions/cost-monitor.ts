/**
 * Show the live AICP and Breeze spend caps in pi's footer statusline.
 *
 * Both probes are best-effort and cached for one minute. A failed refresh keeps
 * the last good value, so a gateway outage never interrupts a pi session.
 *
 * CONFIG (env):
 *   PI_COST_MONITOR_OFF=1  disable the monitor entirely.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const STATUS_KEY = "cost-monitor";
const AICP_ENDPOINT = "https://qgenie-api.qualcomm.com/v1/rate-limit/cost-cap/usage";
const REFRESH_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 2_000;

type Usage = { used: number; cap: number; percent: number };
type AicpUsage = Usage;
type CostSnapshot = { aicp?: AicpUsage; breeze?: Usage };

let snapshot: CostSnapshot | undefined;
let refreshedAt = 0;
let refreshPromise: Promise<CostSnapshot> | undefined;

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usage(used: unknown, cap: unknown, percent?: unknown): Usage | undefined {
	const usedValue = finite(used);
	const capValue = finite(cap);
	if (usedValue === undefined || capValue === undefined) return undefined;
	const percentValue = finite(percent) ?? (capValue > 0 ? (usedValue / capValue) * 100 : 0);
	return { used: usedValue, cap: capValue, percent: percentValue };
}

function addUsage(left: Usage, right: Usage | undefined): Usage {
	const used = left.used + (right?.used ?? 0);
	const cap = left.cap + (right?.cap ?? 0);
	return { used, cap, percent: cap > 0 ? (used / cap) * 100 : 0 };
}

function readAicpToken(): string | undefined {
	const fromEnv = process.env.ANTHROPIC_AUTH_TOKEN || process.env.QGENIE_API_KEY;
	if (fromEnv) return fromEnv;
	try {
		const models = JSON.parse(readFileSync(join(getAgentDir(), "models.json"), "utf8")) as {
			providers?: { qgenie?: { apiKey?: unknown } };
		};
		const token = models.providers?.qgenie?.apiKey;
		return typeof token === "string" && token && !token.startsWith("!") && !token.includes("$")
			? token
			: undefined;
	} catch {
		return undefined;
	}
}

async function fetchAicp(): Promise<AicpUsage | undefined> {
	const token = readAicpToken();
	if (!token) return undefined;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(AICP_ENDPOINT, {
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (!response.ok) return undefined;
		const data = (await response.json()) as {
			usage?: {
				month?: { used?: { usd?: unknown }; cap?: { usd?: unknown }; percent?: unknown };
				personal_overflow?: {
					used?: { usd?: unknown };
					cap?: { usd?: unknown };
					percent?: unknown;
				};
				total?: { used?: { usd?: unknown }; cap?: { usd?: unknown }; percent?: unknown };
			};
		};
		const month = data.usage?.month;
		const monthUsage = usage(month?.used?.usd, month?.cap?.usd, month?.percent);
		if (!monthUsage) return undefined;
		const overflow = data.usage?.personal_overflow;
		const overflowUsage = usage(overflow?.used?.usd, overflow?.cap?.usd, overflow?.percent);
		return addUsage(monthUsage, overflowUsage);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

async function fetchBreeze(): Promise<Usage | undefined> {
	try {
		const { stdout } = await execFileAsync(
			process.env.BREEZE_BIN || "breeze",
			["status", "--json"],
			{
				timeout: FETCH_TIMEOUT_MS,
				maxBuffer: 64 * 1024,
			},
		);
		const data = JSON.parse(stdout) as {
			quota?: { spend_usd?: unknown; budget_usd?: unknown; usage_pct?: unknown };
		};
		const quota = data.quota;
		return usage(quota?.spend_usd, quota?.budget_usd, quota?.usage_pct);
	} catch {
		return undefined;
	}
}

async function refresh(): Promise<CostSnapshot> {
	if (refreshPromise) return refreshPromise;
	refreshPromise = Promise.all([fetchAicp(), fetchBreeze()])
		.then(([aicp, breeze]): CostSnapshot => {
			const next: CostSnapshot = {
				aicp: aicp ?? snapshot?.aicp,
				breeze: breeze ?? snapshot?.breeze,
			};
			snapshot = next;
			refreshedAt = Date.now();
			return next;
		})
		.catch((): CostSnapshot => snapshot ?? {})
		.finally(() => {
			refreshPromise = undefined;
		});
	return refreshPromise;
}

const ESC = String.fromCharCode(27);

function paint(text: string, code: string): string {
	return `${ESC}[${code}m${text}${ESC}[0m`;
}

function money(value: number): string {
	return value.toFixed(2);
}

function costColor(percent: number): string {
	return percent >= 90 ? "31" : percent >= 70 ? "33" : "32";
}

function renderUsage(name: string, value: Usage | undefined, labelCode: string): string {
	if (!value) return paint(`${name} unavailable`, "90");
	const amount = paint(
		`${money(value.used)}/${money(value.cap)} (${Math.round(value.percent)}%)`,
		costColor(value.percent),
	);
	return `${paint(`${name}:`, labelCode)} ${amount}`;
}

function renderAicp(value: AicpUsage | undefined): string {
	return renderUsage("AICP", value, "1;35");
}

function render(snapshotValue: CostSnapshot | undefined): string {
	return (
		[renderAicp(snapshotValue?.aicp), renderUsage("Breeze", snapshotValue?.breeze, "1;36")].join(
			" | ",
		) + " | "
	);
}

function publish(ctx: ExtensionContext): void {
	try {
		if (!ctx.hasUI || !ctx.ui?.setStatus) return;
		ctx.ui.setStatus(STATUS_KEY, render(snapshot));
	} catch {
		// Session replacement/reload can invalidate a timer's captured context.
	}
}

export default function costMonitor(pi: ExtensionAPI): void {
	if (process.env.PI_COST_MONITOR_OFF === "1") return;

	let activeContext: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	const update = async (): Promise<void> => {
		const ctx = activeContext;
		if (!ctx) return;
		if (Date.now() - refreshedAt >= REFRESH_MS) await refresh();
		if (activeContext === ctx) publish(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		activeContext = undefined;
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		activeContext = ctx;
		publish(ctx);
		void update().catch(() => undefined);
		timer = setInterval(() => void update().catch(() => undefined), REFRESH_MS);
		timer.unref?.();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx !== activeContext) return;
		if (timer) clearInterval(timer);
		timer = undefined;
		try {
			ctx.ui?.setStatus(STATUS_KEY, undefined);
		} catch {
			// The shutdown event may race with context invalidation.
		}
		activeContext = undefined;
	});
}

export const __test = { render, usage };
