import { getEntryTerms } from "emdash";
import { getPublishedDate } from "./post-date";

export interface NotebookEntry {
	slug: string;
	title: string;
	date: Date | null;
	terms: Array<{ slug: string; label: string }>;
}

interface PostLike {
	/** slug(URL 用) */
	id: string;
	data: {
		/** DB ULID(getEntryTerms 用) */
		id: string;
		title?: string | null;
		publishedAt?: Date | string | null;
		published_at?: Date | string | null;
	};
}

/**
 * NotebookList 用のエントリ形式へ変換する。カテゴリ terms は
 * 記事ごとに並列取得(withTerms: false でスキップ — カテゴリページの
 * ように行内表示が冗長な場合用)。ソート・絞り込みは呼び出し側の責務。
 */
export async function toNotebookEntries(
	posts: PostLike[],
	{ withTerms = true }: { withTerms?: boolean } = {}
): Promise<NotebookEntry[]> {
	const postsTerms = withTerms
		? await Promise.all(
				posts.map((post) => getEntryTerms("posts", post.data.id, "category"))
			)
		: [];
	return posts.map((post, i) => ({
		slug: post.id,
		title: post.data.title ?? "Untitled",
		date: getPublishedDate(post),
		terms: (postsTerms[i] ?? []).map((t) => ({ slug: t.slug, label: t.label })),
	}));
}
