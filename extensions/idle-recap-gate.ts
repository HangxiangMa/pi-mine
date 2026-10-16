/**
 * Gate for the context-threshold recap trigger in `idle-recap.ts`.
 *
 * Once context usage is high, that trigger used to force `/recap` on every `agent_end`, even
 * when the user had stopped and nothing had changed. That spends a model call on a summary that
 * is already current. This gate fingerprints the most recent messages and only allows a forced
 * recap when the fingerprint differs from the last one that was generated.
 *
 * Pure: no pi runtime, so it is testable on its own.
 */

import { createHash } from "node:crypto";

/**
 * The minimum the fingerprint needs from a message. Message kinds differ in where their text lives
 * (`content` for chat, `command`/`output` for bash runs), so the text is read from whichever is set.
 */
export interface GateMessage {
	role: string;
	content?: unknown;
	command?: unknown;
	output?: unknown;
}

/** How many of the most recent messages the fingerprint covers. */
export const FINGERPRINT_DEPTH = 8;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const item = block as { type?: unknown; text?: unknown };
			return item.type === "text" && typeof item.text === "string" ? item.text : "";
		})
		.join("");
}

/** All text a message carries, so a bash run changes the fingerprint as much as a chat turn does. */
function messageText(message: GateMessage): string {
	const parts = [textOf(message.content)];
	if (typeof message.command === "string") parts.push(message.command);
	if (typeof message.output === "string") parts.push(message.output);
	return parts.join("\u0002");
}

/**
 * Stable hash of the last `depth` messages. Role and order are part of the hash, so swapping two
 * turns is a change. Messages before the window do not affect it.
 */
export function conversationFingerprint(
	messages: readonly GateMessage[],
	depth: number = FINGERPRINT_DEPTH,
): string {
	const recent = messages.slice(Math.max(0, messages.length - depth));
	const hash = createHash("sha256");
	for (const message of recent) {
		hash.update(message.role);
		hash.update("\u0000");
		hash.update(messageText(message));
		hash.update("\u0001");
	}
	return hash.digest("hex");
}

/**
 * Whether a forced recap should run. An empty conversation never recaps. The first recap of a
 * non-empty conversation always runs. After that, only a changed fingerprint runs it again.
 */
export function shouldForceRecap(input: {
	fingerprint: string;
	lastFingerprint: string | undefined;
}): boolean {
	if (input.fingerprint === conversationFingerprint([], FINGERPRINT_DEPTH)) return false;
	return input.fingerprint !== input.lastFingerprint;
}
