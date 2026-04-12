type DateLike = Date | string | null | undefined;

type EntryLike =
	| { data?: { publishedAt?: DateLike; published_at?: DateLike } }
	| { publishedAt?: DateLike; published_at?: DateLike }
	| null
	| undefined;

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

	const data = "data" in entry && entry.data ? entry.data : entry;
	return toDate(data.published_at) ?? toDate(data.publishedAt);
}

export function comparePublishedDateDesc(a: EntryLike, b: EntryLike): number {
	const left = getPublishedDate(a)?.getTime() ?? 0;
	const right = getPublishedDate(b)?.getTime() ?? 0;
	return right - left;
}
