This is an EmDash site -- a CMS built on Astro with a full admin UI.

## Commands

```bash
npx emdash dev        # Start dev server (runs migrations, seeds, generates types)
npx emdash types      # Regenerate TypeScript types from schema
```

The admin UI is at `http://localhost:4321/_emdash/admin`.

## Architecture: Static Delivery

The public site (`blog.ochanu.co`) is **static** — an assets-only Worker (`wrangler.static.jsonc`, name `ochanuco-blog-static`). The EmDash SSR Worker (`wrangler.jsonc`) serves only `admin.blog.ochanu.co` (admin UI + generation origin; D1/R2 live behind it).

```bash
pnpm generate:static   # Crawl ORIGIN (default admin.blog.ochanu.co) into dist-static/ + build Pagefind index
pnpm deploy:static     # Deploy dist-static/ as the public static worker
```

`.github/workflows/generate-static.yml` runs generate+deploy daily (05:00 JST) and on manual dispatch; requires the `CLOUDFLARE_API_TOKEN` repo secret.

Search is client-side Pagefind on `/search` — it only works on the generated static site (the `/pagefind/` bundle does not exist on the SSR worker). Do not reintroduce request-time features (live search, forms, comments) on public pages; they break when frozen.

Passkeys: `astro.config.mjs` pins the WebAuthn RP ID to `blog.ochanu.co` via `siteUrl` + `allowedOrigins` (apex + admin subdomain). `patches/emdash@0.27.0.patch` fixes an upstream bug where `allowedOrigins` was dropped from the serialized runtime config — check whether the fix landed upstream before bumping emdash.

## Key Files

| File                     | Purpose                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `astro.config.mjs`       | Astro config with `emdash()` integration, database, and storage                  |
| `src/live.config.ts`     | EmDash loader registration (boilerplate -- don't modify)                         |
| `emdash-env.d.ts`      | Generated types for collections (auto-regenerated on dev server start)             |
| `src/layouts/Base.astro` | Base layout with EmDash wiring (menus, search, page contributions)               |
| `src/pages/`             | Astro pages -- all server-rendered                                                 |

## Skills

Agent skills are in `.agents/skills/` (source of truth, git-tracked). `.claude/skills` is a local-only symlink to it (`../.agents/skills`) so Claude Code can discover them; it's gitignored (`**/.claude/` in global gitignore), so a fresh clone needs to recreate it: `mkdir -p .claude && ln -s ../.agents/skills .claude/skills`.

Load them when working on specific tasks:

- **building-emdash-site** -- Querying content, rendering Portable Text, schema design, seed files, site features (menus, widgets, search, SEO, comments, bylines). Start here.
- **creating-plugins** -- Building EmDash plugins with hooks, storage, admin UI, API routes, and Portable Text block types.
- **emdash-cli** -- CLI commands for content management, seeding, type generation, and visual editing flow.

## Rules

- All content pages must be server-rendered (`output: "server"`). No `getStaticPaths()` for CMS content.
- Image fields are objects (`{ src, alt }`), not strings. Use `<Image image={...} />` from `"emdash/ui"`.
- `entry.id` is the slug (for URLs). `entry.data.id` is the database ULID (for API calls like `getEntryTerms`).
- Always call `Astro.cache.set(cacheHint)` on pages that query content.
- Taxonomy names in queries must match the seed's `"name"` field exactly (e.g., `"category"` not `"categories"`).
