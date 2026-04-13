import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const dbPath = path.join(repoRoot, "data.db");
const publishedDatesPath = path.join(repoRoot, ".local", "hatena-published-dates.json");

const publishedDates = Object.values(
	JSON.parse(await readFile(publishedDatesPath, "utf8")),
).sort();

const db = new Database(dbPath);

const result = db.transaction((dates) => {
	if (dates.length === 0) {
		return { taxonomies: 0, posts: 0 };
	}

	const placeholders = dates.map(() => "?").join(", ");
	const deleteTaxonomies = db.prepare(
		[
			"DELETE FROM content_taxonomies",
			"WHERE collection = 'posts'",
			"AND entry_id IN (",
			"  SELECT id FROM ec_posts",
			`  WHERE published_at IN (${placeholders})`,
			")",
		].join(" "),
	);
	const deletePosts = db.prepare(
		`DELETE FROM ec_posts WHERE published_at IN (${placeholders})`,
	);

	return {
		taxonomies: deleteTaxonomies.run(...dates).changes,
		posts: deletePosts.run(...dates).changes,
	};
})(publishedDates);

db.close();

console.log(
	JSON.stringify(
		{
			db: dbPath,
			publishedAtValues: publishedDates.length,
			deletedPosts: result.posts,
			deletedTaxonomies: result.taxonomies,
		},
		null,
		2,
	),
);
