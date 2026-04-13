import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const defaultSourceRoot =
	"/Users/chanu/ghq/github.com/ochanuco/hatena-to-emdash/.local/output";
const sourceRoot = path.resolve(process.argv[2] ?? defaultSourceRoot);
const postsRoot = path.join(sourceRoot, "posts");
const assetsRoot = path.join(sourceRoot, "assets");
const publicAssetsRoot = path.join(repoRoot, "public", "hatena-assets");
const seedPath = path.join(repoRoot, "seed", "seed.json");
const publishedDatesPath = path.join(repoRoot, ".local", "hatena-published-dates.json");
const mediaManifestPath = path.join(repoRoot, ".local", "hatena-media-manifest.json");
const legacySlugsPath = path.join(repoRoot, ".local", "hatena-legacy-slugs.json");
const converterModulePath = path.join(
	repoRoot,
	"node_modules",
	".pnpm",
	"node_modules",
	"@emdash-cms",
	"gutenberg-to-portable-text",
	"dist",
	"index.mjs",
);
const LOCAL_MEDIA_BASE = "/_emdash/api/media/file/";
const HATENA_ASSET_BASE = "/hatena-assets/";

const { gutenbergToPortableText, extractText } = await import(
	pathToFileURL(converterModulePath).href
);

async function main() {
	await assertPath(postsRoot, "posts directory");
	await assertPath(assetsRoot, "assets directory");
	await assertPath(seedPath, "seed file");

	const seed = JSON.parse(await readFile(seedPath, "utf8"));
	const markdownFiles = await collectMarkdownFiles(postsRoot);
	const importedTerms = {
		category: new Map(),
		tag: new Map(),
	};
	const publishedDates = {};
	const legacySlugs = [];
	const mediaRegistry = new Map();

	await rm(publicAssetsRoot, { recursive: true, force: true });
	await mkdir(path.dirname(publishedDatesPath), { recursive: true });

	const importedPosts = [];
	for (const filePath of markdownFiles) {
		const markdown = await readFile(filePath, "utf8");
		const { frontmatter, body } = parseMarkdownFile(markdown, filePath);
		const slug = slugFromPublishedAt(frontmatter.date);
		legacySlugs.push(String(frontmatter.slug));
		const assetPrefix = String(frontmatter.assets_dir || "").replace(/^assets\//, "");
		const rewrittenBody = rewriteAssetUrls(body, assetPrefix);

		const { contentHtml, excerptHtml } = splitBodySections(rewrittenBody);
		const excerpt =
			normalizeWhitespace(
				excerptHtml ? extractText(excerptHtml) : firstNonEmptyLine(extractText(contentHtml)),
			) || undefined;
		const rawContentBlocks = gutenbergToPortableText(contentHtml);
		const contentBlocks = stripHatenaKeywordLinks(
			await materializeMediaReferences(rawContentBlocks, mediaRegistry),
		);
		const featuredImage = findFeaturedImage(contentBlocks, frontmatter.title);

		const categories = mapTermLabels(
			frontmatter.categories ?? [],
			importedTerms.category,
			"category",
		);
		const tags = mapTermLabels(frontmatter.tags ?? [], importedTerms.tag, "tag");
		publishedDates[slug] = frontmatter.date;

		importedPosts.push({
			id: `hatena-${slug}`,
			slug,
			status: frontmatter.status === "draft" ? "draft" : "published",
			data: {
				title: frontmatter.title,
				...(excerpt ? { excerpt } : {}),
				...(featuredImage ? { featured_image: featuredImage } : {}),
				content: contentBlocks,
			},
			taxonomies: {
				category: categories,
				tag: tags,
			},
		});
	}

	seed.collections = stripReservedPublishedAtField(seed.collections ?? []);
	seed.taxonomies = rebuildTaxonomies(seed.taxonomies ?? [], importedTerms);
	seed.content = {
		...seed.content,
		posts: importedPosts,
	};

	const mediaManifest = [...mediaRegistry.values()].sort((left, right) =>
		left.sourcePath.localeCompare(right.sourcePath),
	);

	await writeFile(seedPath, `${JSON.stringify(seed, null, "\t")}\n`, "utf8");
	await writeFile(publishedDatesPath, `${JSON.stringify(publishedDates, null, 2)}\n`, "utf8");
	await writeFile(mediaManifestPath, `${JSON.stringify(mediaManifest, null, 2)}\n`, "utf8");
	await writeFile(legacySlugsPath, `${JSON.stringify(unique(legacySlugs).sort(), null, 2)}\n`, "utf8");

	console.log(
		[
			`source=${sourceRoot}`,
			`posts=${importedPosts.length}`,
			`categories=${importedTerms.category.size}`,
			`tags=${importedTerms.tag.size}`,
			`media=${mediaManifest.length}`,
			`seed=${seedPath}`,
			`published_dates=${publishedDatesPath}`,
			`media_manifest=${mediaManifestPath}`,
		].join(" "),
	);
}

async function assertPath(targetPath, label) {
	if (!(await exists(targetPath))) {
		throw new Error(`${label} not found: ${targetPath}`);
	}
}

async function exists(targetPath) {
	try {
		await stat(targetPath);
		return true;
	} catch {
		return false;
	}
}

async function collectMarkdownFiles(rootDir) {
	const entries = await readdir(rootDir, { withFileTypes: true });
	const files = [];

	for (const entry of entries) {
		const targetPath = path.join(rootDir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectMarkdownFiles(targetPath)));
			continue;
		}
		if (entry.isFile() && targetPath.endsWith(".md")) {
			files.push(targetPath);
		}
	}

	return files.sort();
}

function parseMarkdownFile(markdown, filePath) {
	const match = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) {
		throw new Error(`frontmatter not found: ${filePath}`);
	}

	const frontmatter = {};
	for (const line of match[1].split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const separatorIndex = trimmed.indexOf(":");
		if (separatorIndex === -1) continue;
		const key = trimmed.slice(0, separatorIndex).trim();
		const rawValue = trimmed.slice(separatorIndex + 1).trim();
		frontmatter[key] = parseFrontmatterValue(rawValue);
	}

	return { frontmatter, body: match[2].trim() };
}

function parseFrontmatterValue(rawValue) {
	if (rawValue === "[]") return [];
	if (rawValue.startsWith("[")) return JSON.parse(rawValue);
	if (rawValue.startsWith('"')) return JSON.parse(rawValue);
	return rawValue;
}

function rewriteAssetUrls(html, assetPrefix) {
	if (!assetPrefix) return html;

	const baseName = path.basename(assetPrefix);
	const siteAssetBase = `${HATENA_ASSET_BASE}${assetPrefix}`;

	return html.replace(
		/(<(?:img|a)\b[^>]*\b(?:src|href)=["'])([^"']+)(["'][^>]*>)/gi,
		(_match, prefix, rawUrl, suffix) => {
			if (/^(?:[a-z]+:)?\/\//i.test(rawUrl) || rawUrl.startsWith("/") || rawUrl.startsWith("#")) {
				return `${prefix}${rawUrl}${suffix}`;
			}

			const normalized = rawUrl.replace(/^\.\//, "");
			const relative = normalized.startsWith(`${baseName}/`)
				? normalized.slice(baseName.length + 1)
				: normalized;
			return `${prefix}${siteAssetBase}/${relative}${suffix}`;
		},
	);
}

function splitBodySections(body) {
	const [beforeExcerpt, excerptRemainder] = body.split("<!-- excerpt -->", 2);
	if (!excerptRemainder) {
		const [beforeMore, afterMore] = body.split("<!-- more -->", 2);
		return {
			contentHtml: [beforeMore, afterMore].filter(Boolean).join("\n\n").trim(),
			excerptHtml: "",
		};
	}

	const [excerptHtml, afterMore] = excerptRemainder.split("<!-- more -->", 2);
	return {
		contentHtml: [beforeExcerpt, afterMore].filter(Boolean).join("\n\n").trim(),
		excerptHtml: excerptHtml.trim(),
	};
}

function firstNonEmptyLine(text) {
	return text
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
}

function normalizeWhitespace(text) {
	return text.replace(/\s+/g, " ").trim();
}

function slugFromPublishedAt(value) {
	const match = String(value).match(
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/,
	);
	if (!match) {
		throw new Error(`invalid published_at format: ${value}`);
	}
	return match.slice(1).join("");
}

async function materializeMediaReferences(value, mediaRegistry) {
	if (Array.isArray(value)) {
		return Promise.all(value.map((item) => materializeMediaReferences(item, mediaRegistry)));
	}

	if (typeof value === "string") {
		const media = await resolveHatenaMedia(value, undefined, mediaRegistry);
		return media ? buildMediaUrl(media.storageKey) : value;
	}

	if (!value || typeof value !== "object") {
		return value;
	}

	if (value._type === "image" && value.asset?.url) {
		const media = await resolveHatenaMedia(value.asset.url, value.alt, mediaRegistry);
		if (media) {
			return {
				...value,
				asset: {
					_type: "reference",
					_ref: media.id,
					url: buildMediaUrl(media.storageKey),
					provider: "local",
					meta: {
						storageKey: media.storageKey,
					},
				},
				alt: value.alt || media.alt,
				width: value.width ?? media.width,
				height: value.height ?? media.height,
			};
		}
	}

	const resolved = {};
	for (const [key, entry] of Object.entries(value)) {
		resolved[key] = await materializeMediaReferences(entry, mediaRegistry);
	}
	return resolved;
}

async function resolveHatenaMedia(url, alt, mediaRegistry) {
	if (typeof url !== "string" || !url.startsWith(HATENA_ASSET_BASE)) {
		return null;
	}

	const relativePath = url.slice(HATENA_ASSET_BASE.length);
	const sourcePath = path.join(assetsRoot, relativePath);
	if (!(await exists(sourcePath))) {
		console.warn(`missing hatena asset: ${sourcePath}`);
		return null;
	}

	const existing = mediaRegistry.get(sourcePath);
	if (existing) {
		if (!existing.alt && alt) {
			existing.alt = alt;
		}
		return existing;
	}

	const fileBuffer = await readFile(sourcePath);
	const extension = path.extname(sourcePath).toLowerCase();
	const baseName = path.basename(sourcePath);
	const idBase = hashLabel(relativePath);
	const media = {
		id: `hatena-media-${idBase}`,
		storageKey: `hatena-media-${idBase}${extension || ""}`,
		sourcePath,
		filename: baseName,
		mimeType: guessMimeType(baseName),
		size: fileBuffer.byteLength,
		width: null,
		height: null,
		alt: alt || null,
		caption: null,
	};

	mediaRegistry.set(sourcePath, media);
	return media;
}

function buildMediaUrl(storageKey) {
	return `${LOCAL_MEDIA_BASE}${storageKey}`;
}

function findFeaturedImage(blocks, fallbackAlt) {
	const imageBlock = blocks.find((block) => block?._type === "image" && block.asset?._ref);
	if (!imageBlock) {
		return undefined;
	}

	return {
		provider: "local",
		id: imageBlock.asset._ref,
		filename: imageBlock.asset.meta?.filename || undefined,
		mimeType: imageBlock.mimeType || undefined,
		width: imageBlock.width,
		height: imageBlock.height,
		alt: imageBlock.alt || fallbackAlt,
		meta: {
			storageKey: imageBlock.asset.meta?.storageKey || storageKeyFromUrl(imageBlock.asset.url),
		},
	};
}

function stripHatenaKeywordLinks(value) {
	if (Array.isArray(value)) {
		return value.map((item) => stripHatenaKeywordLinks(item));
	}

	if (!value || typeof value !== "object") {
		return value;
	}

	const resolved = Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [key, stripHatenaKeywordLinks(entry)]),
	);

	if (resolved._type !== "block" || !Array.isArray(resolved.markDefs)) {
		return resolved;
	}

	const removedKeys = new Set(
		resolved.markDefs
			.filter((markDef) => isHatenaKeywordHref(markDef?.href))
			.map((markDef) => markDef._key)
			.filter(Boolean),
	);

	if (removedKeys.size === 0) {
		return resolved;
	}

	return {
		...resolved,
		markDefs: resolved.markDefs.filter((markDef) => !removedKeys.has(markDef?._key)),
		children: Array.isArray(resolved.children)
			? resolved.children.map((child) => {
					if (!Array.isArray(child?.marks)) {
						return child;
					}
					return {
						...child,
						marks: child.marks.filter((mark) => !removedKeys.has(mark)),
					};
				})
			: resolved.children,
	};
}

function storageKeyFromUrl(url) {
	if (typeof url !== "string" || !url.startsWith(LOCAL_MEDIA_BASE)) {
		return undefined;
	}
	return url.slice(LOCAL_MEDIA_BASE.length);
}

function isHatenaKeywordHref(value) {
	return (
		typeof value === "string" &&
		/^https?:\/\/d\.hatena\.ne\.jp\/keyword\//i.test(value)
	);
}

function mapTermLabels(labels, registry, prefix) {
	return unique(labels)
		.map((label) => String(label).trim())
		.filter(Boolean)
		.map((label) => {
			const existing = registry.get(label);
			if (existing) return existing.slug;

			const slugBase = slugify(label);
			let slug = slugBase || `${prefix}-${hashLabel(label)}`;
			let counter = 2;
			while ([...registry.values()].some((term) => term.slug === slug)) {
				slug = `${slugBase || `${prefix}-${hashLabel(label)}`}-${counter}`;
				counter += 1;
			}

			registry.set(label, { slug, label });
			return slug;
		});
}

function unique(values) {
	return [...new Set(Array.isArray(values) ? values : [])];
}

function slugify(value) {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
}

function hashLabel(value) {
	let hash = 2166136261;
	for (const char of value) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function guessMimeType(filename) {
	const extension = path.extname(filename).toLowerCase();
	switch (extension) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".svg":
			return "image/svg+xml";
		case ".avif":
			return "image/avif";
		default:
			return "application/octet-stream";
	}
}

function stripReservedPublishedAtField(collections) {
	return collections.map((collection) => {
		if (collection.slug !== "posts") {
			return collection;
		}

		return {
			...collection,
			fields: collection.fields.filter((field) => field.slug !== "published_at"),
		};
	});
}

function rebuildTaxonomies(taxonomies, importedTerms) {
	return taxonomies.map((taxonomy) => {
		if (taxonomy.name !== "category" && taxonomy.name !== "tag") {
			return taxonomy;
		}

		const terms = [...importedTerms[taxonomy.name].values()]
			.sort((left, right) => left.label.localeCompare(right.label, "ja"))
			.map(({ slug, label }) => ({ slug, label }));

		return {
			...taxonomy,
			terms,
		};
	});
}

await main();
