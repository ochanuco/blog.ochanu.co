type DateLike = Date | string | null | undefined;

type EntryLike =
	| { data?: { publishedAt?: DateLike; published_at?: DateLike } }
	| { publishedAt?: DateLike; published_at?: DateLike }
	| null
	| undefined;

function readDateLike(source: unknown, key: "published_at" | "publishedAt"): DateLike {
	if (!source || typeof source !== "object") {
		return undefined;
	}

	const value = (source as Record<string, unknown>)[key];
	if (value instanceof Date || typeof value === "string" || value == null) {
		return value as DateLike;
	}

	return undefined;
}

function toDate(value: DateLike): Date | null {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value;
	}
	if (typeof value !== "string" || value.trim() === "") {
		return null;
	}

	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function getPublishedDate(entry: EntryLike): Date | null {
	if (!entry) {
		return null;
	}

	const source = "data" in entry && entry.data ? entry.data : entry;
	return (
		toDate(readDateLike(source, "published_at")) ??
		toDate(readDateLike(source, "publishedAt"))
	);
}

export function comparePublishedDateDesc(a: EntryLike, b: EntryLike): number {
	const left = getPublishedDate(a)?.getTime() ?? 0;
	const right = getPublishedDate(b)?.getTime() ?? 0;
	return right - left;
}

/**
 * Formats a published date as an absolute "yyyy-MM-dd HH:mm" (never
 * relative, e.g. never "3 days ago") so it can be cross-referenced
 * against external timestamps (logs, monitoring dashboards, etc).
 */
export function formatPublishedDate(date: Date | null | undefined): string | null {
	if (!date) return null;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
