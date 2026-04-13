import Database from "better-sqlite3";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const dbPath = path.join(repoRoot, "data.db");
const uploadsDir = path.join(repoRoot, "uploads");
const mediaManifestPath = path.join(repoRoot, ".local", "hatena-media-manifest.json");
const wranglerConfigPath = path.join(repoRoot, "wrangler.jsonc");

const args = new Set(process.argv.slice(2));
const localOnly = args.has("--local-only");
const dryRunR2 = args.has("--dry-run-r2");

const manifest = JSON.parse(await readFile(mediaManifestPath, "utf8"));
const db = new Database(dbPath);
const remoteBucketName = localOnly ? null : await resolveRemoteBucketName();

await mkdir(uploadsDir, { recursive: true });

if (!localOnly && !remoteBucketName) {
	throw new Error(
		[
			"R2 bucket is not configured.",
			"Set HATENA_R2_BUCKET or add an r2_buckets entry with binding \"MEDIA\" to wrangler.jsonc.",
			"Use --local-only if you only want to populate data.db and uploads/.",
		].join(" "),
	);
}

if (!localOnly && !dryRunR2 && !process.env.CLOUDFLARE_API_TOKEN) {
	throw new Error(
		[
			"CLOUDFLARE_API_TOKEN is required for remote R2 upload.",
			"The previous script only updated local uploads/, so remote sync never happened.",
			"Set CLOUDFLARE_API_TOKEN or use --local-only.",
		].join(" "),
	);
}

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
let uploaded = 0;

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

	if (!localOnly) {
		await uploadToR2({
			bucketName: remoteBucketName,
			sourcePath: item.sourcePath,
			storageKey: item.storageKey,
			mimeType: item.mimeType,
			dryRun: dryRunR2,
		});
		uploaded += 1;
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
console.log(
	[
		`db=${dbPath}`,
		`media=${manifest.length}`,
		`created=${created}`,
		`updated=${updated}`,
		`copied=${copied}`,
		`uploaded=${uploaded}`,
		`mode=${localOnly ? "local-only" : dryRunR2 ? "dry-run-r2" : "local+r2"}`,
	].join(" "),
);

async function resolveRemoteBucketName() {
	if (process.env.HATENA_R2_BUCKET) {
		return process.env.HATENA_R2_BUCKET;
	}

	const configText = await readFile(wranglerConfigPath, "utf8");
	const mediaBucketMatch = configText.match(
		/"binding"\s*:\s*"MEDIA"[\s\S]*?"bucket_name"\s*:\s*"([^"]+)"/,
	);
	if (mediaBucketMatch) {
		return mediaBucketMatch[1];
	}

	const firstBucketMatch = configText.match(/"bucket_name"\s*:\s*"([^"]+)"/);
	return firstBucketMatch?.[1] ?? null;
}

async function uploadToR2({ bucketName, sourcePath, storageKey, mimeType, dryRun }) {
	const objectPath = `${bucketName}/${storageKey}`;
	if (dryRun) {
		console.log(`[dry-run-r2] ${objectPath} <- ${sourcePath}`);
		return;
	}

	await execFile("pnpm", [
		"exec",
		"wrangler",
		"r2",
		"object",
		"put",
		objectPath,
		"--remote",
		"--file",
		sourcePath,
		"--content-type",
		mimeType,
	], {
		cwd: repoRoot,
		env: {
			...process.env,
			WRANGLER_LOG: "error",
		},
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
