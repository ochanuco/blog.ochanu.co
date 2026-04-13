import Database from "better-sqlite3";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const dbPath = path.join(repoRoot, "data.db");
const publishedDatesPath = path.join(repoRoot, ".local", "hatena-published-dates.json");
const mediaManifestPath = path.join(repoRoot, ".local", "hatena-media-manifest.json");
const defaultSqlPath = path.join(repoRoot, ".local", "hatena-remote-content-sync.sql");
const d1Binding = process.env.HATENA_D1_BINDING || "DB";

const argv = process.argv.slice(2);
const applyRemote = argv.includes("--remote");
const applyLocal = argv.includes("--local");
const sqlPath = getArgValue("--output") || defaultSqlPath;
const localTargetDb = getArgValue("--database") || dbPath;

await mkdir(path.dirname(sqlPath), { recursive: true });

const localDb = new Database(dbPath, { readonly: true });
const hatenaSlugs = Object.keys(JSON.parse(await readFile(publishedDatesPath, "utf8"))).sort();
const mediaManifest = JSON.parse(await readFile(mediaManifestPath, "utf8"));

const posts = getHatenaPosts(localDb, hatenaSlugs);
const media = getHatenaMedia(localDb, mediaManifest);
const taxonomies = getHatenaTaxonomies(localDb, hatenaSlugs);
const taxonomyAssignments = getHatenaTaxonomyAssignments(localDb, hatenaSlugs);

localDb.close();

const sqlText = buildSyncSql({ posts, media, taxonomies, taxonomyAssignments });
await writeFile(sqlPath, sqlText, "utf8");

if (applyLocal) {
	await execSqlite(localTargetDb, sqlText);
}

if (applyRemote) {
	await execFile(
		"pnpm",
		["exec", "wrangler", "d1", "execute", d1Binding, "--remote", "--file", sqlPath, "--yes"],
		{ cwd: repoRoot },
	);
}

console.log(
	JSON.stringify(
		{
			sql: sqlPath,
			posts: posts.length,
			media: media.length,
			taxonomies: taxonomies.length,
			assignments: taxonomyAssignments.length,
			mode: applyRemote ? "remote" : applyLocal ? "local" : "write-only",
			d1Binding: applyRemote ? d1Binding : null,
			localDatabase: applyLocal ? localTargetDb : null,
		},
		null,
		2,
	),
);

function getArgValue(flag) {
	const index = argv.indexOf(flag);
	if (index === -1) return null;
	return argv[index + 1] ?? null;
}

function getHatenaPosts(db, slugs) {
	if (slugs.length === 0) return [];
	const placeholders = slugs.map(() => "?").join(", ");
	return db
		.prepare(
			[
				"SELECT id, slug, status, author_id, primary_byline_id, created_at, updated_at,",
				"published_at, scheduled_at, deleted_at, version, live_revision_id, draft_revision_id,",
				"locale, translation_group, title, featured_image, content, excerpt",
				`FROM ec_posts WHERE slug IN (${placeholders}) ORDER BY slug, locale`,
			].join(" "),
		)
		.all(...slugs);
}

function getHatenaMedia(db, manifest) {
	const ids = [...new Set(manifest.map((item) => item.id).filter(Boolean))].sort();
	if (ids.length === 0) return [];
	const placeholders = ids.map(() => "?").join(", ");
	return db
		.prepare(
			[
				"SELECT id, filename, mime_type, size, width, height, alt, caption, storage_key,",
				"content_hash, created_at, author_id, status, blurhash, dominant_color",
				`FROM media WHERE id IN (${placeholders}) ORDER BY id`,
			].join(" "),
		)
		.all(...ids);
}

function getHatenaTaxonomies(db, slugs) {
	if (slugs.length === 0) return [];
	const placeholders = slugs.map(() => "?").join(", ");
	return db
		.prepare(
			[
				"SELECT DISTINCT t.id, t.name, t.slug, t.label, t.parent_id, t.data",
				"FROM taxonomies t",
				"JOIN content_taxonomies ct ON ct.taxonomy_id = t.id",
				"JOIN ec_posts p ON p.id = ct.entry_id",
				`WHERE ct.collection = 'posts' AND p.slug IN (${placeholders})`,
				"ORDER BY t.name, t.slug",
			].join(" "),
		)
		.all(...slugs);
}

function getHatenaTaxonomyAssignments(db, slugs) {
	if (slugs.length === 0) return [];
	const placeholders = slugs.map(() => "?").join(", ");
	return db
		.prepare(
			[
				"SELECT p.slug AS post_slug, p.locale, t.name AS taxonomy_name, t.slug AS taxonomy_slug",
				"FROM content_taxonomies ct",
				"JOIN ec_posts p ON p.id = ct.entry_id",
				"JOIN taxonomies t ON t.id = ct.taxonomy_id",
				`WHERE ct.collection = 'posts' AND p.slug IN (${placeholders})`,
				"ORDER BY p.slug, p.locale, t.name, t.slug",
			].join(" "),
		)
		.all(...slugs);
}

function buildSyncSql({ posts, media, taxonomies, taxonomyAssignments }) {
	const statements = [
		"PRAGMA defer_foreign_keys = ON;",
		"BEGIN TRANSACTION;",
		"-- Hatena media",
		...media.map((row) => buildMediaUpsert(row)),
		"-- Hatena posts",
		...posts.map((row) => buildPostUpsert(row)),
		"-- Remove old taxonomy assignments for synced posts",
		buildDeleteAssignments(posts),
		"-- Hatena taxonomies",
		...taxonomies.map((row) => buildTaxonomyUpsert(row)),
		"-- Recreate taxonomy assignments for synced posts",
		...taxonomyAssignments.map((row) => buildAssignmentInsert(row)),
		"COMMIT;",
	];

	return `${statements.filter(Boolean).join("\n")}\n`;
}

function buildMediaUpsert(row) {
	return [
		"INSERT INTO media (",
		"id, filename, mime_type, size, width, height, alt, caption, storage_key,",
		"content_hash, created_at, author_id, status, blurhash, dominant_color",
		") VALUES (",
		[
			sql(row.id),
			sql(row.filename),
			sql(row.mime_type),
			sqlNumber(row.size),
			sqlNumber(row.width),
			sqlNumber(row.height),
			sql(row.alt),
			sql(row.caption),
			sql(row.storage_key),
			sql(row.content_hash),
			sql(row.created_at),
			sql(row.author_id),
			sql(row.status),
			sql(row.blurhash),
			sql(row.dominant_color),
		].join(", "),
		")",
		"ON CONFLICT(id) DO UPDATE SET",
		"filename = excluded.filename,",
		"mime_type = excluded.mime_type,",
		"size = excluded.size,",
		"width = excluded.width,",
		"height = excluded.height,",
		"alt = excluded.alt,",
		"caption = excluded.caption,",
		"storage_key = excluded.storage_key,",
		"content_hash = excluded.content_hash,",
		"created_at = excluded.created_at,",
		"author_id = excluded.author_id,",
		"status = excluded.status,",
		"blurhash = excluded.blurhash,",
		"dominant_color = excluded.dominant_color;",
	].join(" ");
}

function buildPostUpsert(row) {
	return [
		"INSERT INTO ec_posts (",
		"id, slug, status, author_id, primary_byline_id, created_at, updated_at, published_at,",
		"scheduled_at, deleted_at, version, live_revision_id, draft_revision_id, locale,",
		"translation_group, title, featured_image, content, excerpt",
		") VALUES (",
		[
			sql(row.id),
			sql(row.slug),
			sql(row.status),
			sql(row.author_id),
			sql(row.primary_byline_id),
			sql(row.created_at),
			sql(row.updated_at),
			sql(row.published_at),
			sql(row.scheduled_at),
			sql(row.deleted_at),
			sqlNumber(row.version),
			sql(row.live_revision_id),
			sql(row.draft_revision_id),
			sql(row.locale),
			sql(row.translation_group),
			sql(row.title),
			sql(row.featured_image),
			sql(row.content),
			sql(row.excerpt),
		].join(", "),
		")",
		"ON CONFLICT(slug, locale) DO UPDATE SET",
		"status = excluded.status,",
		"author_id = excluded.author_id,",
		"primary_byline_id = excluded.primary_byline_id,",
		"created_at = excluded.created_at,",
		"updated_at = excluded.updated_at,",
		"published_at = excluded.published_at,",
		"scheduled_at = excluded.scheduled_at,",
		"deleted_at = excluded.deleted_at,",
		"version = excluded.version,",
		"live_revision_id = excluded.live_revision_id,",
		"draft_revision_id = excluded.draft_revision_id,",
		"translation_group = excluded.translation_group,",
		"title = excluded.title,",
		"featured_image = excluded.featured_image,",
		"content = excluded.content,",
		"excerpt = excluded.excerpt;",
	].join(" ");
}

function buildDeleteAssignments(posts) {
	if (posts.length === 0) {
		return null;
	}

	const tuples = posts.map((post) => `(${sql(post.slug)}, ${sql(post.locale)})`).join(", ");
	return [
		"DELETE FROM content_taxonomies",
		"WHERE collection = 'posts'",
		"AND entry_id IN (",
		"  SELECT id FROM ec_posts",
		`  WHERE (slug, locale) IN (${tuples})`,
		");",
	].join(" ");
}

function buildTaxonomyUpsert(row) {
	return [
		"INSERT INTO taxonomies (id, name, slug, label, parent_id, data) VALUES (",
		[
			sql(row.id),
			sql(row.name),
			sql(row.slug),
			sql(row.label),
			sql(row.parent_id),
			sql(row.data),
		].join(", "),
		")",
		"ON CONFLICT(name, slug) DO UPDATE SET",
		"label = excluded.label,",
		"parent_id = excluded.parent_id,",
		"data = excluded.data;",
	].join(" ");
}

function buildAssignmentInsert(row) {
	return [
		"INSERT OR REPLACE INTO content_taxonomies (collection, entry_id, taxonomy_id)",
		"VALUES (",
		"'posts',",
		`(SELECT id FROM ec_posts WHERE slug = ${sql(row.post_slug)} AND locale = ${sql(row.locale)}),`,
		`(SELECT id FROM taxonomies WHERE name = ${sql(row.taxonomy_name)} AND slug = ${sql(row.taxonomy_slug)})`,
		");",
	].join(" ");
}

function sql(value) {
	if (value === null || value === undefined) return "NULL";
	return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNumber(value) {
	if (value === null || value === undefined) return "NULL";
	return Number.isFinite(Number(value)) ? String(value) : "NULL";
}

function execSqlite(targetDbPath, sql) {
	return new Promise((resolve, reject) => {
		const child = spawn("sqlite3", [targetDbPath], {
			stdio: ["pipe", "inherit", "inherit"],
			cwd: repoRoot,
		});

		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`sqlite3 exited with code ${code}`));
		});

		child.stdin.end(sql);
	});
}

function execFile(command, args, options) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: "inherit",
			...options,
		});

		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${command} exited with code ${code}`));
		});
	});
}
