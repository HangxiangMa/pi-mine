/** Bounded session search with an optional caller-provided semantic scorer. */

export interface SessionSearchCandidate {
	id: string;
	title?: string;
	tags?: string[];
	branch?: string;
	summary?: string;
	firstPrompt?: string;
	transcript?: string;
}

export interface SessionSearchResult extends SessionSearchCandidate {
	score: number;
	matchedFields: string[];
	semanticScore?: number;
}

export interface SessionSearchOptions {
	/** Returns a normalized relevance score (0..1); failures fall back to lexical ranking. */
	semanticScore?: (query: string, candidate: SessionSearchCandidate) => number;
	semanticWeight?: number;
}

const MAX_CANDIDATES = 100;
const MAX_TEXT = 2_000;

function words(value: string): string[] {
	return value
		.toLocaleLowerCase()
		.split(/[^\p{L}\p{N}_-]+/u)
		.filter(Boolean);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.slice(0, MAX_TEXT).toLocaleLowerCase() : "";
}

export function searchSessions(
	query: string,
	candidates: readonly SessionSearchCandidate[],
	limit = 20,
	options: SessionSearchOptions = {},
): SessionSearchResult[] {
	const queryText = query.trim().toLocaleLowerCase();
	if (!queryText) return [];
	const terms = [...new Set(words(queryText))];
	if (terms.length === 0) return [];
	return candidates
		.slice(0, MAX_CANDIDATES)
		.map((candidate, index) => {
			const fields: Array<[string, string, number]> = [
				["title", text(candidate.title), 8],
				["tags", text(candidate.tags?.join(" ")), 7],
				["branch", text(candidate.branch), 5],
				["summary", text(candidate.summary), 4],
				["firstPrompt", text(candidate.firstPrompt), 3],
				["transcript", text(candidate.transcript), 1],
			];
			let score = 0;
			const matchedFields: string[] = [];
			for (const [name, value, weight] of fields) {
				const count = terms.filter((term) => value.includes(term)).length;
				if (count) {
					matchedFields.push(name);
					score += count * weight;
					if (value.includes(queryText)) score += weight;
				}
			}
			let semanticScore: number | undefined;
			if (options.semanticScore) {
				try {
					const value = options.semanticScore(query, candidate);
					if (Number.isFinite(value)) semanticScore = Math.max(0, Math.min(1, value));
				} catch {
					// Semantic providers are optional; lexical search remains authoritative.
				}
			}
			if (semanticScore !== undefined) score += semanticScore * (options.semanticWeight ?? 10);
			return { ...candidate, score, matchedFields, semanticScore, __index: index };
		})
		.filter((candidate) => candidate.score > 0)
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id) || a.__index - b.__index)
		.slice(0, Math.max(0, Math.min(limit, MAX_CANDIDATES)))
		.map(({ __index: _index, ...candidate }) => candidate);
}

export function sessionCandidateFromEntries(
	id: string,
	entries: readonly unknown[],
): SessionSearchCandidate {
	const parts: string[] = [];
	let firstPrompt: string | undefined;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const message = (entry as { message?: { role?: unknown; content?: unknown } }).message;
		const content = message?.content;
		const value =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.map((part) =>
								part && typeof part === "object" && "text" in part
									? String((part as { text?: unknown }).text ?? "")
									: "",
							)
							.join(" ")
					: "";
		if (!value) continue;
		parts.push(value.slice(0, MAX_TEXT));
		if (!firstPrompt && message?.role === "user") firstPrompt = value.slice(0, MAX_TEXT);
	}
	return {
		id,
		firstPrompt,
		transcript: parts.join("\n").slice(0, MAX_TEXT),
		summary: parts.at(-1)?.slice(0, MAX_TEXT),
	};
}

export const __test = { MAX_CANDIDATES, MAX_TEXT, words, sessionCandidateFromEntries };
