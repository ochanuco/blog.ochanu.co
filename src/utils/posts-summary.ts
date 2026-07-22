import { getEmDashCollection, getEntryTerms, getTaxonomyTerms } from "emdash";
import { comparePublishedDateDesc, getPublishedDate } from "./post-date";

export interface PostSummary {
	slug: string;
	title: string;
	date: Date | null;
	catSlug: string | null;
	catLabel: string | null;
}

export interface PostsSummaryData {
	/** 新しい順 */
	posts: PostSummary[];
	cats: Array<{ slug: string; label: string }>;
}

/**
 * 全記事サマリ+カテゴリ一覧の共有ストア。GraphRail(全ページで描画)や
 * 記事ページの前後ナビなど「ページ本来のコンテンツではない補助データ」用に、
 * リクエスト横断の短命キャッシュで DB 問い合わせを抑える。
 * ページ自身のコンテンツ取得と Astro.cache.set(cacheHint) は各ページの
 * 責務のままにしてある。
 */
const TTL_MS = 60_000;
let cached: { at: number; data: Promise<PostsSummaryData> } | null = null;

async function load(): Promise<PostsSummaryData> {
	const { entries } = await getEmDashCollection("posts");
	const cats = await getTaxonomyTerms("category");
	const sorted = entries.toSorted(comparePublishedDateDesc);
	const terms = await Promise.all(
		sorted.map((post) => getEntryTerms("posts", post.data.id, "category"))
	);
	return {
		posts: sorted.map((post, i) => ({
			slug: post.id,
			title: post.data.title ?? "Untitled",
			date: getPublishedDate(post),
			catSlug: terms[i]?.[0]?.slug ?? null,
			catLabel: terms[i]?.[0]?.label ?? null,
		})),
		cats: cats.map((c) => ({ slug: c.slug, label: c.label })),
	};
}

export function getPostsSummary(): Promise<PostsSummaryData> {
	const now = Date.now();
	if (!cached || now - cached.at > TTL_MS) {
		const entry = {
			at: now,
			data: load().catch((error) => {
				// 失敗をキャッシュしない
				if (cached === entry) cached = null;
				throw error;
			}),
		};
		cached = entry;
	}
	return cached.data;
}
