import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const dbPath = path.join(repoRoot, "data.db");
const publishedDatesPath = path.join(repoRoot, ".local", "hatena-published-dates.json");
const legacySlugsPath = path.join(repoRoot, ".local", "hatena-legacy-slugs.json");

const publishedDates = Object.values(
	JSON.parse(await readFile(publishedDatesPath, "utf8")),
).sort();
const legacySlugs = JSON.parse(await readFile(legacySlugsPath, "utf8")).sort();

const db = new Database(dbPath);

const result = db.transaction((dates) => {
	if (dates.length === 0 && legacySlugs.length === 0) {
		return { taxonomies: 0, posts: 0 };
	}

	const datePlaceholders = dates.map(() => "?").join(", ");
	const slugPlaceholders = legacySlugs.map(() => "?").join(", ");
	const whereClauses = [];
	if (dates.length > 0) {
		whereClauses.push(`published_at IN (${datePlaceholders})`);
	}
	if (legacySlugs.length > 0) {
		whereClauses.push(`slug IN (${slugPlaceholders})`);
	}
	const whereSql = whereClauses.join(" OR ");
	const deleteTaxonomies = db.prepare(
		[
			"DELETE FROM content_taxonomies",
			"WHERE collection = 'posts'",
			"AND entry_id IN (",
			"  SELECT id FROM ec_posts",
			`  WHERE ${whereSql}`,
			")",
		].join(" "),
	);
	const deletePosts = db.prepare(
		`DELETE FROM ec_posts WHERE ${whereSql}`,
	);
	const args = [...dates, ...legacySlugs];

	return {
		taxonomies: deleteTaxonomies.run(...args).changes,
		posts: deletePosts.run(...args).changes,
	};
})(publishedDates);

db.close();

console.log(
	JSON.stringify(
		{
			db: dbPath,
			publishedAtValues: publishedDates.length,
			legacySlugs: legacySlugs.length,
			deletedPosts: result.posts,
			deletedTaxonomies: result.taxonomies,
		},
		null,
		2,
	),
);
