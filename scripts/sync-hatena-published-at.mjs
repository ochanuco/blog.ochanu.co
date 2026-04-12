import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const dbPath = path.join(repoRoot, "data.db");
const publishedDatesPath = path.join(repoRoot, ".local", "hatena-published-dates.json");
const execFileAsync = promisify(execFile);

const slugToDate = JSON.parse(await readFile(publishedDatesPath, "utf8"));

const escapeSql = (value) => String(value).replace(/'/g, "''");

let updated = 0;
for (const [slug, publishedAt] of Object.entries(slugToDate)) {
	const sql = [
		"UPDATE ec_posts",
		`SET published_at = '${escapeSql(publishedAt)}', updated_at = updated_at`,
		`WHERE slug = '${escapeSql(slug)}';`,
		"SELECT changes();",
	].join(" ");

	const { stdout } = await execFileAsync("sqlite3", [dbPath, sql]);
	updated += Number.parseInt(stdout.trim(), 10) || 0;
}
console.log(`db=${dbPath} updated=${updated}`);
