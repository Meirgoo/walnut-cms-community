# Changelog

All notable changes to **Walnut CMS** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Current Public Beta: **`0.9.0-beta.2`** (`0.9.0.beta.2` core / `0.9.1` official `Univers` theme / `0.9.1` database schema).

## [Unreleased]

## [0.9.0-beta.2] - 2026-11-25

### Added
- **AI Assembly & Contract Workflows**: Published a built-in static Theme Contract guide (read/copy/download in-app), unified AI context & import modals across Themes, Pages, and Datasets, and added joint `{ datasets, blocks }` page assembly with `site_taxonomy`, `recent_media`, non-destructive schema field appending, ghost dataset prechecks, and real collection reference samples (`reference_items`).
- **Standalone Markdown Block**: Added `type: "markdown"` schema field support and the `univers-markdown` component for rich page body blocks.
- **Theme-Switch Component Diagnostics**: Added on-demand detection for missing theme components across active pages and templates, surfaced via post-switch alerts, Dashboard alert cards, and red badges in the Page Editor.
- **Dataset Weight Sorting**: Added `sort_order` support for dataset items with inline editing, batch import/export passthrough, default weighted ordering, and `@api:dataset:` `sort=order|latest`.
- **Precompiled Micro-Content HTML**: Added `micros.content_html` precompiled on save and batch import, exposed alongside raw `content_raw` in `@api:micro:` and `@api:feed:`.
- **Legacy URL Aliases (301 Redirects)**: Added `metadata.aliases` support for articles and pages with automatic route syncing, collision checks, and anti-loop protection (includes `scripts/upgrade-beta2.sql` for upgrading from Beta 1).

### Changed
- **End-to-End `published_at` Support**: Added UTC `published_at` pickers across Article, Page, and Micro editors and batch import, preserving existing timestamps on edit and unifying list and `@api:` ordering onto `COALESCE(published_at, created_at) DESC`.
- **Domain-Neutral Media Storage**: Persisted root-relative media paths in D1 and applied `PUBLIC_ASSETS_DOMAIN` strictly at output time.
- **`Univers` Theme (`0.9.1`) & Protocol Alignment**: Standardized `@api:dataset:collection=<slug>` syntax, aligned component `item_schema` / `data_slots` keys, and restricted `univers-notice-bar` to the `main` slot.
- **Community Release Packaging**: Bundled bilingual READMEs and MIT `LICENSE` into community release archives.

### Fixed
- **`nocfa` Initial Setup Password & Secret Ordering**: Secured un-CFA builds (`__BUILD_CFA_ENABLED__=false`) on `/admin/setup` with a fail-closed, constant-time verified 16-char one-time setup password derived via `HMAC-SHA256(SESSION_SECRET, "walnut:nocfa:setup")`, and deferred fresh `SESSION_SECRET` uploads in `deploy.mjs` until after `wrangler deploy` so new Workers accept secrets and print the initial setup credential.
- **Theme ZIP Import**: Switched to Central Directory ZIP parsing with single wrapper-folder stripping, inline `locales` preservation, and reliable chunked block commits.
- **Page Editor List Controls**: Fixed list fields falling back to link (`text`/`url`) inputs by unifying `item_schema` / `item_fields` rendering and adding safe fallback rendering for schema-less arrays.

---

## [0.9.0-beta.1] - 2026-11-24

> Baseline: Version reset at `0.9.0` (`0.9-beta.1` core / `0.9.0` database schema).

### Added
- **Password-Protected Articles**: Added `visibility: 'password'` with server-side unlock gates (`POST /_unlock`) and automatic edge-cache bypass.
- **Full-Text Multi-Language RSS 2.0**: Added `/feed.xml`, `/rss.xml`, locale-prefixed feeds, and `<head>` auto-discovery tags.
- **SEO, Social Meta & LLM Discovery**: Added `/llm.txt` & `/llms.txt`, `X-Robots-Tag` headers, default & first-image OG tags, dynamic JSON-LD (`WebSite` / `WebPage` / `BlogPosting`), and `hreflang="x-default"`.
- **3-Layer Decoupled Datasets**: Introduced Schema → Collection → Item isolation and site-level custom metadata schemas that persist across theme switches.
- **Internal / Closed Frontend Mode**: Added configurable maintenance/closed status responses (`503`, `404`, `301`, `302`) and custom status pages.
- **Storage Monitoring**: Added built-in D1 and R2 media usage tracking with periodic calibration.
- **`nocfa` Release & Deployment Wizard**: Added the `nocfa` community release package (without Cloudflare Access verification) and enhanced `deploy.mjs` with interactive D1/R2 create-or-reuse, `CF_ACCESS_AUD` checks, and Analytics Engine setup.

### Changed
- **Admin Console Redesign**: Introduced 3 light/dark palettes (`walnut`, `monochrome`, `cosmic`), focused Edit/Split article writing mode, 4-tab inspectors, an editorial Dashboard timeline with tiered alerts, unified content lists, and responsive mobile drawers.
- **`Univers` Theme & Shared Themes**: Refreshed `Univers` with the "Cosmic Shell" palette and migrated themes to instance-wide sharing across multi-site deployments.
- **Dynamic Multi-Language Routing**: Replaced hardcoded locale prefixes with `sites.default_locale`-driven routing, locale-prefixed `site_routes` caching, and automatic translated template resolution.
- **Flexible Authentication**: Made Cloudflare Access an optional login method alongside password authentication.
- **Brand & Runtime Neutralization**: Updated public brand copy to **Walnut Edge CMS** and neutralized runtime headers/cookies (`X-Edge-*`, `edge_*`).

### Fixed & Security
- **Multi-Tenant & Session Hardening**: Enforced strict `site_id` isolation across DALs and admin routes, added `token_version` session revocation on password change/logout/role downgrade, enforced `CF_ACCESS_AUD` validation when Cloudflare Access is enabled, and hardened SSR/XSS error handling.
- **Multilingual & Crawlability Fixes**: Fixed secondary-locale homepage `/en/en` duplication, `<html lang="">` resolution, sibling translation cache invalidation, `robots.txt` line endings, and `sitemap.xml` `Content-Type`.
- **Admin UI Fixes**: Fixed dropdown portal positioning in dark/glass themes, switched timezones to direct UTC offsets, and added excerpt fallbacks for untitled micro-content.

### Removed
- **Media Bed Mode**: Removed the standalone media bed mode in favor of the unified Internal mode.
