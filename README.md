<div align="center">

# Walnut CMS

**A lightweight, edge-native CMS built for Cloudflare Workers, D1, and R2.**

[English](./README.md) · [简体中文](./README.zh-CN.md)

[![Version](https://img.shields.io/badge/version-v0.9.0--beta.1-orange.svg)](#status)
[![Runtime](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1%20%2B%20R2-F38020.svg)](https://workers.cloudflare.com/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

[Website](https://walnut.meirgoo.com) · [Live Demo](https://walnut-demo.meirgoo.com) · [Report Bug](https://github.com/meirgoo/walnut-cms/issues)

</div>

> **Beta Notice (`v0.9.0-beta.1`)**: Walnut CMS Community Edition is currently in public beta. The core architecture, multi-site engine, and official `Univers` theme are live in production, while documentation and minor UX rough edges are still being polished. Feedback and issue reports are warmly welcome.

<!-- Replace with actual screenshots after deploying your demo site -->
<!-- ![Walnut CMS Preview](./docs/screenshots/preview-light.png) -->

---

## Why Walnut CMS?

Most self-hosted CMS platforms force you to maintain a VPS, a database server, and a fragile plugin stack—or settle for a static site generator that turns every quick edit into a Git CI pipeline.

**Walnut CMS** is built from the ground up for Cloudflare's edge platform with a **low-maintenance, finished-software** philosophy:

- **Edge-Native & Ultra-Light**: Runs entirely on Cloudflare Workers + D1 + R2 with zero VPS maintenance. Typical runtime stays under **4 MB memory** and **< 10 ms P99 CPU**, with a full uncached public page transferring **~58 KB** in total—friendly to Cloudflare's free tier.
- **Hybrid Content Model**: First-class support for three complementary content types in one workspace:
  - **Articles**: Long-form Markdown with custom callout containers, auto-generated TOC, version snapshots, multi-locale translation groups, and bidirectional `[[Wiki]]` backlinks.
  - **Micros**: Untitled, zero-friction short notes and status streams with optional `progress` badges.
  - **Datasets**: Custom JSON1 schemas for portfolios, project directories, reading lists, or structured catalogs.
- **Decoupled Themes & Slot Assembly**: Themes define layout skeletons (`header`, `subnav`, `main`, `sidebar`, `footer`) and component contracts, while pages bind data independently via `@api:` protocols and master templates (`@slot:page_content`). Switch themes via ZIP or Git (including private repo tokens) without migrating your data.
- **Unlimited Multi-Site (Free in Community)**: Host your personal homepage, project documentation, and demo sites from a single Worker instance with isolated domains, routes, media, and themes.
- **Security by Default**: Admin initialization and console access integrate natively with **Cloudflare Access (Zero Trust)**, alongside built-in RBAC, CSRF protection, and tenant isolation.

---

## Built-in `@api:` Data Protocols

Bind live content directly to any theme component without writing custom backend glue code:

| Protocol | Description |
| :--- | :--- |
| `@api:articles:limit=6` | Fetch latest published articles (supports `locale`, `folder`, etc.) |
| `@api:micro:limit=6` | Fetch latest untitled micro posts |
| `@api:dataset:schema=projects&limit=12` | Query structured entries by custom dataset schema |
| `@api:feed:types=article,micro&limit=20` | Merge multiple content types into a unified chronological timeline |
| `@api:media:limit=3` | Query public media assets from R2 |

---

## Quick Start

### Prerequisites

- A [Cloudflare](https://dash.cloudflare.com/) account (Workers, D1, R2, and Zero Trust Access enabled — Cloudflare's Free plan includes up to 50 Access seats at $0/month)
- Node.js `>= 20`

### Step 1: Configure Cloudflare Access (Required for `/admin`)

For security, Walnut CMS enforces **Cloudflare Access** authentication during initial setup (`/admin/setup`) and admin console access.

1. Go to Cloudflare **Workers & Pages** page→ Enable **Analytics Engine**

1. Go to **Cloudflare Zero Trust → Access → Applications → Add an application → Self-hosted**.
2. Under **Public Hostname**, enter your site domain and set **Path** to **`admin`** *(Important: do **not** add a trailing `*` such as `/admin*` — Cloudflare Access uses prefix matching by default, and a literal `*` will prevent `/admin/setup` from matching)*.
3. Under **Policies**, create a policy with Action set to **Allow** *(not Bypass)* and include your email address.
4. Note your **Team Name** (`CF_ACCESS_TEAM_NAME`, **prefix only** — e.g., `myteam` from `myteam.cloudflareaccess.com`, without `https://` or the domain suffix).
5. Copy the **Application Audience (AUD) Tag** (`CF_ACCESS_AUD`) from the application's **Overview** tab *(strongly recommended to lock JWT verification strictly to this Access application)*.

> **Multi-site tip**: You can add multiple site domains (each with path `admin`) under **one** Access application so all sites share the same `CF_ACCESS_AUD`.

### Step 2: Deploy

#### Option A: One-Command Deploy from Release Package (Recommended)

Download and extract `walnut-cms-community.tar.gz` from [Releases](https://github.com/meirgoo/walnut-cms/releases), then run the interactive deployment wizard:

```bash
node deploy.mjs          # Auto-detect language (zh / en)
node deploy.mjs --lang=en
```

The wizard automatically handles Wrangler login checks, D1/R2 provisioning or reuse, secret preservation, incremental database migrations, and theme asset syncing.

#### Option B: Local Development & Deploy from Source

```bash
git clone [https://github.com/](https://github.com/)meirgoo/walnut-cms.git
cd walnut-cms
npm install

# Sync official Univers theme assets to local R2
node scripts/sync-theme-assets.mjs --local

# Start local dev server
npm run dev
```

To deploy manually from source:

```bash
npm run deploy
# Ensure remote R2 contains the official theme static assets
node scripts/sync-theme-assets.mjs --remote
```

To regenerate Cloudflare Worker TypeScript bindings after modifying `wrangler.jsonc`:

```bash
npm run cf-typegen
```

### Step 3: Initialize & Customize

1. Visit `https://your-domain.com/admin/setup` (authenticated via Cloudflare Access) to create your admin account and claim your primary domain.
2. Walnut ships with the official **`Univers`** theme (light/dark adaptive, 19 single-responsibility components, and 5 page blueprints) plus an interactive starter guide.
3. All starter articles, pages, and micros are tagged under `folder: guide`—once you're familiar with the workspace, filter by `guide` in Admin to bulk-delete them cleanly.

---

## Community vs. Open-Core Roadmap

Walnut CMS follows a pragmatic **Open-Core** model designed for sustainable, independent maintenance:

- **Community Edition (Free & Open)**: Full content engine (Articles, Micros, Datasets), unlimited multi-site hosting, visual slot page builder, `@api:` protocols, Git/ZIP theme import, basic form & Webhook forwarding, and the official `Univers` theme.
- **Commercial Extensions & Themes (Planned)**: Advanced automation workflows, external API gateways, white-label branding, automated R2 backup/restore workflows, and standalone premium themes delivered via private Git/ZIP packages.

---

## Status

- Current release: **`v0.9.0-beta.1`**
- If you run into deployment hiccups, R2 asset sync issues, or edge-case bugs, please open an [Issue](https://github.com/meirgoo/walnut-cms/issues).

## License

Released under the [MIT License](./LICENSE).
