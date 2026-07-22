// Category palette used by the "engineer's notebook" design — hub colors on
// the trail graph, and (indirectly, via the same palette) anything that
// wants a stable per-category accent. Kept framework-agnostic (plain hex
// strings, no CSS custom properties) so both SSR (Astro) and the client-side
// graph script (which draws on a <canvas>) can use the exact same values.
const CATEGORY_PALETTE = [
	"#3e8e6d",
	"#b98d4f",
	"#cf6a50",
	"#5b7fa6",
	"#7a6aa8",
	"#4a8f9c",
] as const;

// Fixed assignments for known category slugs, so the hub colors stay
// consistent across deploys instead of shuffling whenever the category list
// changes shape. Everything else falls through to the deterministic hash.
const FIXED_SLUG_COLORS: Record<string, string> = {
	tech: "#b98d4f",
	"microsoft-365": "#5b7fa6",
};

/**
 * Deterministic hash of a string into a small non-negative integer. Simple
 * char-code sum with a multiplier — stable across processes/runs, which is
 * all we need for a "pick a palette slot" hash (no cryptographic properties
 * required).
 */
function hashSlug(slug: string): number {
	let hash = 0;
	for (let i = 0; i < slug.length; i++) {
		hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
	}
	return hash;
}

/**
 * Maps a category slug to a stable hex color from the notebook palette.
 * Known slugs (tech-flavored categories) get a fixed assignment; everything
 * else is hashed deterministically into the palette so the same slug always
 * lands on the same color.
 */
export function getCategoryColor(slug: string): string {
	const fixed = FIXED_SLUG_COLORS[slug];
	if (fixed) return fixed;
	const index = hashSlug(slug) % CATEGORY_PALETTE.length;
	return CATEGORY_PALETTE[index];
}

/** Hub color for posts with no category ("メモ" hub) — matches --color-muted. */
export const UNCATEGORIZED_HUB_COLOR = "#8b95a1";
