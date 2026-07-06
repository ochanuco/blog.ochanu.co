import cloudflare from "@astrojs/cloudflare";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import webhookNotifier from "@emdash-cms/plugin-webhook-notifier";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

const isLocalDev = process.argv.some((arg) => arg === "dev" || arg.endsWith("/dev"));

const cloudflareEmdash = isLocalDev ? null : await import("@emdash-cms/cloudflare");

const database = isLocalDev
	? sqlite({ url: "file:./data.db" })
	: cloudflareEmdash.d1({ binding: "DB", session: "auto" });

const storage = isLocalDev
	? local({
			directory: "./uploads",
			baseUrl: "/_emdash/api/media/file",
		})
	: cloudflareEmdash.r2({ binding: "MEDIA" });

export default defineConfig({
	output: "server",
	adapter: isLocalDev ? node({ mode: "standalone" }) : cloudflare(),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database,
			storage,
			// パスキーの RP ID を blog.ochanu.co に固定しつつ、
			// admin サブドメインからのログインを許可する(apex+サブドメイン構成)。
			// blog.ochanu.co 時代に登録済みのパスキーがそのまま使える。
			siteUrl: "https://blog.ochanu.co",
			allowedOrigins: ["https://admin.blog.ochanu.co"],
			plugins: [formsPlugin()],
			...(isLocalDev
				? {}
				: {
						sandboxed: [webhookNotifier],
						sandboxRunner: cloudflareEmdash.sandbox(),
						marketplace: "https://marketplace.emdashcms.com",
					}),
		}),
	],
	devToolbar: { enabled: false },
});
