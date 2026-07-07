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

// Matches an ISO date-time with no timezone designator, e.g.
// "2021-05-30T01:30:01" or "2021-05-30T01:30:01.000".
const DATE_TIME_NO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * EmDash's `publishedAt` is stored without a timezone designator (e.g.
 * "2021-05-30T01:30:01") — those values are JST wall-clock times. Its
 * Live Collections loader already deserializes the field into a `Date`
 * before we ever see it, ambiguously parsing the naive string as the
 * *server process's* local time (V8 default behavior). That parse and a
 * local-getter read are exact inverses within the same process, so
 * reading the Date's local Y/M/D/H/M/S back out always recovers the
 * original naive digits, regardless of what the ambient timezone
 * actually was — dev (JST) or Cloudflare Workers (always UTC). Re-anchor
 * those recovered digits as JST explicitly so the instant is correct
 * everywhere.
 */
function reinterpretAsJst(date: Date): Date {
	const utcMillis = Date.UTC(
		date.getFullYear(),
		date.getMonth(),
		date.getDate(),
		date.getHours(),
		date.getMinutes(),
		date.getSeconds(),
		date.getMilliseconds(),
	);
	return new Date(utcMillis - JST_OFFSET_MS);
}

function toDate(value: DateLike): Date | null {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : reinterpretAsJst(value);
	}
	if (typeof value !== "string" || value.trim() === "") {
		return null;
	}

	// Same offset-less naive-JST issue as above, for the raw-string input
	// shape (e.g. seed data, a future EmDash version returning strings).
	const normalized = DATE_TIME_NO_OFFSET.test(value) ? `${value}+09:00` : value;

	const parsed = new Date(normalized);
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

const PUBLISHED_DATE_PARTS: Intl.DateTimeFormatOptions = {
	timeZone: "Asia/Tokyo",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
};

/**
 * Formats a published date as an absolute "yyyy-MM-dd HH:mm" in JST (never
 * relative, e.g. never "3 days ago") so it can be cross-referenced against
 * external timestamps (logs, monitoring dashboards, etc). Pinned to JST
 * explicitly rather than the runtime's local time — Cloudflare Workers runs
 * in UTC while local dev runs in the machine's timezone, so relying on
 * local getters would render a different time in prod than in dev.
 */
export function formatPublishedDate(date: Date | null | undefined): string | null {
	if (!date || Number.isNaN(date.getTime())) return null;
	const parts = new Intl.DateTimeFormat("en-US", PUBLISHED_DATE_PARTS).formatToParts(date);
	const get = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((p) => p.type === type)?.value ?? "";
	return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}
