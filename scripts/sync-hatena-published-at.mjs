import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const dbPath = path.join(repoRoot, "data.db");
const publishedDatesPath = path.join(repoRoot, ".local", "hatena-published-dates.json");
const wranglerConfigPath = path.join(repoRoot, "wrangler.jsonc");
const d1Binding = process.env.HATENA_D1_BINDING || "DB";
const cloudflareApiBase = "https://api.cloudflare.com/client/v4";

const args = new Set(process.argv.slice(2));
const localMode = args.has("--local");

const slugToDate = JSON.parse(await readFile(publishedDatesPath, "utf8"));
const updates = Object.entries(slugToDate).map(([slug, publishedAt]) => ({ slug, publishedAt }));

if (localMode) {
	const updated = syncLocal(updates);
	console.log(`target=local db=${dbPath} updated=${updated}`);
} else {
	const updated = await syncRemote(updates);
	console.log(`target=remote binding=${d1Binding} updated=${updated}`);
}

function syncLocal(items) {
	const db = new Database(dbPath);
	const updateStatement = db.prepare(`
		UPDATE ec_posts
		SET published_at = ?, updated_at = updated_at
		WHERE slug = ?
			AND (published_at IS NULL OR published_at != ?)
	`);

	const updateMany = db.transaction((rows) => {
		let count = 0;
		for (const row of rows) {
			count += updateStatement.run(row.publishedAt, row.slug, row.publishedAt).changes;
		}
		return count;
	});

	try {
		return updateMany(items);
	} finally {
		db.close();
	}
}

async function syncRemote(items) {
	const apiToken = process.env.CLOUDFLARE_API_TOKEN;
	if (!apiToken) {
		throw new Error("CLOUDFLARE_API_TOKEN is required for remote D1 updates.");
	}

	const databaseId = await resolveDatabaseId(d1Binding);
	const accountId = resolveAccountId();
	const sql = buildSql(items);

	const response = await fetch(
		`${cloudflareApiBase}/accounts/${accountId}/d1/database/${databaseId}/query`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sql }),
		},
	);

	const payload = await response.json();
	if (!response.ok || !payload.success) {
		const details = Array.isArray(payload.errors)
			? payload.errors.map((error) => `${error.code}: ${error.message}`).join("\n")
			: `HTTP ${response.status}`;
		throw new Error(
			[
				"Cloudflare D1 query failed",
				details,
				"Set CLOUDFLARE_ACCOUNT_ID to the account that owns this D1 database and retry.",
			].join("\n"),
		);
	}

	const results = Array.isArray(payload.result) ? payload.result : [payload.result];
	return results.reduce((sum, result) => sum + Number(result?.meta?.changes || 0), 0);
}

async function resolveDatabaseId(binding) {
	const configText = await readFile(wranglerConfigPath, "utf8");
	const pattern = new RegExp(
		String.raw`"binding"\s*:\s*"${escapeRegExp(binding)}"[\s\S]*?"database_id"\s*:\s*"([^"]+)"`,
	);
	const match = configText.match(pattern);
	if (!match) {
		throw new Error(`database_id for binding "${binding}" not found in wrangler.jsonc`);
	}
	return match[1];
}

function resolveAccountId() {
	if (process.env.CLOUDFLARE_ACCOUNT_ID) {
		return process.env.CLOUDFLARE_ACCOUNT_ID;
	}
	if (process.env.HATENA_CF_ACCOUNT_ID) {
		return process.env.HATENA_CF_ACCOUNT_ID;
	}

	throw new Error(
		[
			"CLOUDFLARE_ACCOUNT_ID is required for remote D1 updates.",
			"The previous auto-detection could pick the wrong account.",
		].join(" "),
	);
}

function buildSql(items) {
	const statements = ["BEGIN TRANSACTION;"];
	for (const { slug, publishedAt } of items) {
		statements.push(
			[
				"UPDATE ec_posts",
				`SET published_at = '${escapeSql(publishedAt)}', updated_at = updated_at`,
				`WHERE slug = '${escapeSql(slug)}'`,
				`AND (published_at IS NULL OR published_at != '${escapeSql(publishedAt)}');`,
			].join(" "),
		);
	}
	statements.push("COMMIT;");
	return `${statements.join("\n")}\n`;
}

function escapeSql(value) {
	return String(value).replace(/'/g, "''");
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
