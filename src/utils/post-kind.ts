const TECH_CATEGORY_SLUGS = new Set(["tech", "microsoft-365"]);

export type PostKind = "tech" | "life";

/**
 * Classifies a post (or a single taxonomy term) into the "uptime log"
 * tech/life split used for LED dots and tag chips.
 *
 * Based on the actual category data in this blog: `tech` / `microsoft-365`
 * are tech-flavored, everything else (aquarium, movies, diary) is life. The
 * one uncategorized post is a RaspberryPi networking post, so "no category"
 * defaults to tech.
 */
export function getPostKind(terms: Array<{ slug: string }>): PostKind {
	if (terms.some((t) => TECH_CATEGORY_SLUGS.has(t.slug))) return "tech";
	return terms.length > 0 ? "life" : "tech";
}
