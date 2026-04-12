import Database from "better-sqlite3";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const dbPath = path.join(repoRoot, "data.db");
const uploadsDir = path.join(repoRoot, "uploads");
const mediaManifestPath = path.join(repoRoot, ".local", "hatena-media-manifest.json");

const manifest = JSON.parse(await readFile(mediaManifestPath, "utf8"));
const db = new Database(dbPath);

await mkdir(uploadsDir, { recursive: true });

const selectStatement = db.prepare("SELECT id FROM media WHERE id = ?");
const upsertStatement = db.prepare(`
	INSERT INTO media (
		id,
		filename,
		mime_type,
		size,
		width,
		height,
		alt,
		caption,
		storage_key,
		content_hash,
		created_at,
		author_id,
		status,
		blurhash,
		dominant_color
	) VALUES (
		@id,
		@filename,
		@mime_type,
		@size,
		@width,
		@height,
		@alt,
		@caption,
		@storage_key,
		NULL,
		COALESCE(@created_at, datetime('now')),
		NULL,
		'ready',
		NULL,
		NULL
	)
	ON CONFLICT(id) DO UPDATE SET
		filename = excluded.filename,
		mime_type = excluded.mime_type,
		size = excluded.size,
		width = excluded.width,
		height = excluded.height,
		alt = excluded.alt,
		caption = excluded.caption,
		storage_key = excluded.storage_key,
		status = 'ready'
`);

let created = 0;
let updated = 0;
let copied = 0;

for (const item of manifest) {
	const targetPath = path.join(uploadsDir, item.storageKey);
	await mkdir(path.dirname(targetPath), { recursive: true });

	let shouldCopy = true;
	try {
		const [sourceStat, targetStat] = await Promise.all([stat(item.sourcePath), stat(targetPath)]);
		shouldCopy = sourceStat.size !== targetStat.size;
	} catch {
		shouldCopy = true;
	}

	if (shouldCopy) {
		await copyFile(item.sourcePath, targetPath);
		copied += 1;
	}

	const exists = selectStatement.get(item.id);
	upsertStatement.run({
		id: item.id,
		filename: item.filename,
		mime_type: item.mimeType,
		size: item.size,
		width: item.width,
		height: item.height,
		alt: item.alt,
		caption: item.caption,
		storage_key: item.storageKey,
		created_at: null,
	});

	if (exists) {
		updated += 1;
	} else {
		created += 1;
	}
}

db.close();
console.log(`db=${dbPath} media=${manifest.length} created=${created} updated=${updated} copied=${copied}`);
