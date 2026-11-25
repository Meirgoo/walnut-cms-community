# Walnut CMS Theme Development Contract

> Self-contained theme specification covering package structure, manifest declarations, component schemas, template blueprints, dataset schemas, slot assembly, `@api:` bindings, template engine syntax, and frontend runtime hooks.

---

## 1. Directory Layout, Three-Tier Templates & Packaging Rules

### Disambiguating "Template" Layers
| Layer | Location | Purpose & Runtime Behavior |
| :--- | :--- | :--- |
| **Document Shell** | `templates/layout.html` | Root HTML skeleton (`<!DOCTYPE html>`, `{{edge_head}}`, `{{slot:*}}`, `{{edge_foot}}`). Only `templates/layout.html` (`base.html`, `skeleton.html`, or `manifest.layout_file`) auto-populates `layout_html`. Standalone `templates/<slug>.html` files only backfill matching `manifest.templates[]` HTML (`layout_html` / `template_path`), not visual blocks. |
| **Component Fragment** | `blocks/<component-slug>.html` | Reusable block HTML template snippet (`components/*.html` also accepted in ZIP import). Backfills `template_html` only; schemas and defaults stay in `manifest.json`. |
| **Page Blueprint / Master** | `manifest.templates[]` (or admin `page_type: "template"`) | Ordered list of `PageBlock[]` forming an entire page layout (cloneable starter pages, article detail master layout, or single-page shared chrome wrapper via `@slot:page_content`). |

### Archive Structure
```text
<archive-root>/                      # Pack contents at ZIP root (do NOT wrap in an extra top folder)
├── manifest.json                    # [Required] Theme metadata, components, blueprints & schemas
├── tokens.json                      # [Optional] Design tokens (overrides manifest.tokens during import)
├── templates/
│   └── layout.html                  # [Recommended] Document skeleton
├── blocks/                          # [Optional] Standalone component HTML fragments
│   └── <component-slug>.html        # Auto-matched by filename slug (or manifest template_path)
├── schemas/                         # [Optional] Dataset schema JSON files (schemas/*.json)
│   └── <schema-slug>.json
└── assets/                          # Static assets served under /theme/<slug>/assets/*
    ├── preview.png                  # Local preview image MUST live under assets/
    ├── css/style.css                # Loaded ONLY when declared in global_assets.styles
    └── js/main.js                   # Loaded ONLY when declared in global_assets.scripts
```

**Packaging & Matching Rules**:
1. **`blocks/<component-slug>.html` Matching**: ZIP chunked import matches filenames against `manifest.components[]` via `comp.slug === fileSlug`, `comp.type === fileSlug`, or `comp.template_path` suffix; Git repository import reads ONLY explicit `comp.template_path`. Providing both `blocks/<slug>.html` naming and `template_path` supports both import paths cleanly.
2. **Static Asset Isolation & No Missing Image Paths**: Only non-`.html`, non-`.json` files under `assets/` upload to asset storage (`/theme/<slug>/assets/*`). Placing `preview.png` outside `assets/` drops it during ZIP upload. **Never reference non-existent asset paths** (e.g. a missing `assets/preview.png` or fictional `assets/logo.svg`) in `manifest.json` or templates to avoid 404s—leave optional image fields empty or use inline `<svg>` when no image file is bundled.
3. **ZIP Root Rule**: Compress files directly inside the theme root so `manifest.json`, `assets/`, and `schemas/` sit at archive root (single outer wrapper folders are tolerated by the importer, but packing at ZIP root is recommended).
4. **Inline Locales (Optional) & Explicit Assets**: Translation dictionaries are optional—themes may omit `locales` and write default-language copy directly in templates, or declare inline dictionaries under `manifest.json` `locales`. Stylesheets and scripts are NOT auto-guessed—declare all CSS/JS explicitly using theme-relative paths (auto-prefixed with `/theme/<slug>/`):
   ```json
   "preview_image": "assets/preview.png",
   "global_assets": {
     "styles": ["assets/css/style.css"],
     "scripts": ["assets/js/main.js"]
   }
   ```

---

## 2. Theme Manifest & Design Tokens (`manifest.json`)

| Field | Type | Req | Default / Notes |
| :--- | :--- | :---: | :--- |
| `id` | `string` | ✅ | Unique theme identifier |
| `slug` | `string` | ❌ | URL/asset prefix slug; falls back to `id` |
| `name` | `string` | ✅ | Display title |
| `version` | `string` | ✅ | Semantic version (e.g. `"1.0.0"`), appended as `?v=` cache-buster |
| `description` / `author` / `preview_image` | `string` | ❌ | Optional metadata; relative paths such as `"assets/preview.png"` resolve under `/theme/<slug>/` |
| `default_locale` | `string` | ❌ | Default `'zh-CN'` |
| `locales` | `Record<string, Record<string, string>>` | ❌ | Optional inline dictionaries keyed by BCP-47 tag (`"zh-CN"`, `"en-US"`), exposed as `{{i18n.*}}`; may be omitted if templates use hardcoded default copy |
| `color_schemes` | `Array<'light' \| 'dark'>` | ❌ | Defaults to `['light', 'dark']`; single-value locks user theme toggle |
| `global_assets` | `{ styles?: string[]; scripts?: string[] }` | ❌ | Declared CSS links and `defer` JS scripts; relative `"assets/..."` entries auto-prefix `/theme/<slug>/` |
| `layout_html` / `layout_file` | `string` | ❌ | Inline layout string or path (e.g. `"templates/layout.html"`) |
| `custom_css` / `custom_js` | `string` | ❌ | Optional global theme-level inline CSS / JS |
| `tokens` | `Record<string, any>` | ❌ | Design metadata (`primaryColor`, `primaryColorDark`, `borderRadius`, `fontFamily`) |
| `md_components` | `Record<string, string>` | ❌ | Container templates using **`{{{content}}}`** (never `{content}`), e.g. `"md_components": { "tip": "<div class=\"callout\">{{{content}}}</div>" }` |
| `components` | `ComponentManifest[]` | ❌ | Headless component definitions |
| `templates` | `TemplateBlueprint[]` | ❌ | Cloneable page blueprints & default article master layout |
| `schemas` | `SchemaDefinition[]` | ❌ | Bundled dataset schemas |

### Design Tokens Precedence & Runtime CSS Variables
- **Import Precedence**: When `tokens.json` exists in a ZIP or repository theme, it takes precedence and **overwrites `manifest.tokens`** (`tokens = tokens.json || manifest.tokens`).
- **CSS Variable Scope**: At runtime, the core **ONLY injects `--edge-primary`** (driven by site appearance settings `primary_color` / `primary_color_dark`, rendered into `:root` and `html.dark`). Theme token keys such as `borderRadius`, `fontFamily`, and `primaryColorDark` are stored as theme metadata only and are **NOT** auto-emitted as CSS custom properties—define your theme CSS variables inside `assets/css/style.css` and consume `var(--edge-primary, <fallback>)` for the site accent color.

---

## 3. Component Contract (`components[]`), Schemas & Blueprints

### `ComponentManifest`
| Field | Type | Req | Default / Notes |
| :--- | :--- | :---: | :--- |
| `slug` | `string` | ✅ | Unique component key (alias `type`) |
| `name` | `string` | ✅ | Display name (`title` optional UI alias) |
| `description` | `string` | ❌ | Concise usage & visual placement guidance |
| `summary` | `string` | ❌ | Gallery card summary |
| `category` | `string` | ❌ | e.g. `'navigation'`, `'hero'`, `'layout'`, `'content'`, `'data'`, `'media'`, `'form'` |
| `icon` | `string` | ❌ | Material Symbols icon name, default `'widgets'` |
| `slots` | `string[]` | ❌ | Allowed layout slots, default `['main']`; index `0` is default target slot |
| `template_html` | `string` | ❌ | Component HTML fragment (or loaded via `blocks/<slug>.html` / `template_path`) |
| `template_path` | `string` | ❌ | Explicit path (e.g. `"blocks/hero.html"`) required for Git repo imports |
| `default_props` | `Record<string, any>` | ❌ | Explicit `""` in user props overrides non-empty defaults verbatim |
| `ui_schema` | `UiField[]` | ❌ | Visual property editor field definitions |
| `data_slots` | `Array<{ key: string; label?: string; required?: boolean }>` | ❌ | Semantic item fields exposed for visual dataset `field_map` projection |
| `dataSource` | `string \| { pipelineName: string; params?: object }` | ❌ | Default `@api:` string or built-in pipeline fallback |
| `allow_custom_js` | `boolean` | ❌ | Strictly `false` by default; must be `true` to allow `props.custom_js` |
| `hydration` | `'none' \| 'instant' \| 'idle' \| 'visible'` | ❌ | Default `'idle'` |

### `ui_schema[]` Field Types & Nested Lists
- Standard types: `'text'`, `'textarea'`, **`'markdown'`**, `'number'`, `'boolean'` (`'switch'`), `'select'` (`options: string[] | { label, value }[]`), `'image'`, `'url'`, `'json'`.
- **List Fields**: The property editor triggers the repeatable list + `@api:` toggle UI when **`widget: "list"`** (preferred canonical form: **`type: "json", widget: "list"`**; compatible aliases: `type: "array"` or `widget: "array"` — avoid bare `type: "list"` without `widget`). Subfields reuse standard `{ key, label, type, options?, placeholder?, default? }` objects under `item_fields` (or `item_schema`):
```json
{
  "key": "items",
  "label": "Cards",
  "type": "json",
  "widget": "list",
  "item_fields": [
    { "key": "title", "label": "Title", "type": "text" },
    { "key": "url", "label": "Link", "type": "url" },
    { "key": "tags", "label": "Tags (comma-separated)", "type": "text" }
  ],
  "default": []
}
```
- **Markdown Fields (`type: "markdown"`)**: Edited in a monospace textarea and compiled before rendering via Markdown + `md_components` + wikilinks + URL sanitization; output with triple braces `{{{fieldKey}}}`.

### `PageBlock`, `TemplateBlueprint` & `SchemaDefinition`
- **`PageBlock`** (minimal valid block):
  - `field_map` **direction**: `{ "<component_data_slot>": "<dataset_source_field>" }` — the **key** is the component's `data_slots[].key`, and the **value** is the dataset source field name.
```json
{
  "id": "blk_hero_1",
  "component": "my-hero",
  "target_slot": "main",
  "props": { "heading": "Hello" },
  "field_map": { "title": "name", "description": "summary" },
  "dataSource": "@api:dataset:collection=projects&limit=6"
}
```
- **`TemplateBlueprint` (`manifest.templates[]`)**:
  - Fields: `id`, `slug` (required), `name` / `title`, `description?`, `layout?` (default `'default'`), `blocks: PageBlock[]` (or `template_path?` / `layout_html?`).
  - **Clone Blueprints vs. Master Pages & Homepage (`/`)**: Activating/importing a theme only switches the active theme pointer—it **never** auto-generates `/` or any pages by magic slug, nor inspects `@slot:page_content` to separate `manifest.templates[]` entries. Instead, every blueprint in `manifest.templates[]` can be manually cloned into a `page_type: "single"` page (e.g. slug `/`) by the admin, **or** auto-selected as the article master when `slug` contains `'article'`; wrapping child page `main` blocks via `@slot:page_content` applies when a page binds a `page_type: "template"` master page in the admin.
  - **`@slot:page_content` Placement**: Inside reusable single-page master templates (when converted/saved as `page_type: "template"`), insert this block inside `blocks[]` (NOT in `layout.html`) where bound page `main` blocks should expand:
    `{ "id": "slot_main", "component": "@slot:page_content", "target_slot": "main" }`
  - **Default Article Master Rule**: When rendering an article without an explicit bound template, the runtime automatically falls back to the first `manifest.templates[]` entry whose **`slug` contains `'article'`** (e.g. `"tpl-mytheme-article"`), then to the site's default template page.
```json
{
  "id": "tpl-mytheme-article",
  "slug": "tpl-mytheme-article",
  "name": "Article Detail Master",
  "layout": "default",
  "blocks": [
    { "id": "art-nav", "component": "my-navbar", "target_slot": "header", "props": {} },
    { "id": "art-body", "component": "my-article-view", "target_slot": "main", "props": {} },
    { "id": "art-side", "component": "my-toc-sidebar", "target_slot": "sidebar", "dataSource": "fetch_backlinks", "props": {} },
    { "id": "art-foot", "component": "my-footer", "target_slot": "footer", "props": {} }
  ]
}
```
- **`SchemaDefinition` (`manifest.schemas[]` / `schemas/*.json`)**:
  - Fields: `slug` (required), `name` / `title`, `description?`, **`api_only?: boolean`** (top-level flag; when `true`, excludes this schema's items from all `@api:dataset:` / `@api:feed:` / public queries), `fields: Array<{ key, label, type, required?, options?, default? }>` (also supports JSON Schema `properties` + `required`).
```json
{
  "slug": "projects",
  "name": "Projects",
  "api_only": false,
  "fields": [
    { "key": "title", "label": "Title", "type": "text", "required": true },
    { "key": "repo_url", "label": "Repo URL", "type": "url" }
  ]
}
```

---

## 4. Layout Skeleton, Slots, Assets & Article Detail Pipeline

### `layout.html` Placeholders & Routing Convention
- Required anchors: `{{edge_head}}` inside `<head>` and `{{edge_foot}}` before `</body>`.
- Named slots: `{{slot:<name>}}` or capped `{{slot:<name>:<quota>}}`. Default quotas if omitted: `header: 1`, `footer: 1`, `sidebar: 3`, `main: Infinity`.
- Slot queue priority: `[...templateBlocks, ...pageBlocks].slice(0, quota)`. On single pages bound to a template page (`page_type: "template"`), the `@slot:page_content` block in `blocks[]` marks where the single page's `main` blocks expand inline (if absent, single-page `main` blocks are suppressed).
- **Field Mapping (`field_map`)**: With `{ "<component_data_slot>": "<dataset_source_field>" }`, values resolve by `item[src]` -> `item.fields[src]` -> `item.metadata.fields[src]` -> `item.metadata[src]` while preserving unmapped keys. **Projected values are written directly onto each item at top level under `data_slots[].key` inside `{{#each items}}`** (e.g. mapping `"title": "name"` allows the template to output `{{title}}` directly).
- **Navigation Convention**: The site homepage route is fixed at `/` (and `/<locale>` for non-default locales); themes must not rely on auto-creating `/`, so primary navigation links are typically exposed through a Header component's `ui_schema` list prop (`widget: "list"`).

### Article Detail Page Rendering Pipeline
1. **Resolve Content & Article Master**: Visiting `/<article-slug>` compiles the article's `content_raw` into `content_html` (`page.content`) and picks the article master blueprint (`metadata.template_page_id` -> `manifest.templates[]` where `slug` includes `'article'` -> site default template).
2. **No `@slot:page_content` Needed**: Articles carry no page blocks of their own, so an article master puts its article reader component directly inside `main` (unlike single-page master templates, which use `@slot:page_content`).
3. **Consume Pre-Rendered Body & Tags**: Any component placed in `main` that renders **`{{{content_html}}}`** (or `{{{page.content}}}` / `{{{content}}}`) plus optional metadata (`{{title}}`, `{{published_date}}`, `{{reading_time}}`, `{{cover_image}}`, `{{author}}`) renders the full article—no hardcoded component slug is required. Because `page.tags` at article top level is a `string[]` (and there is no outer `#each`), iterate it directly via **`{{#each page.tags}}{{this}}{{/each}}`** (or `{{#each tags}}{{this}}{{/each}}`).

### Static Asset References Inside Templates
- **In Block Props**: String prop values whose key matches `/(logo|image|img|src|avatar|cover|banner|favicon|poster)/i` (e.g. `"assets/hero.png"`) automatically prefix `/theme/<slug>/` when relative.
- **In Raw HTML Templates / `layout.html`**: Reference actually bundled images or icons via **`{{site.assetsBase}}/assets/<file>`** (resolves to `/theme/<slug>` by default) or explicit **`/theme/<slug>/assets/<file>`**—never reference unbundled/fictional files like an absent `assets/logo.svg` (omit or inline `<svg>` instead). Never write bare relative `"assets/..."` inside nested `<img src>` tags, as multi-segment routes will break resolution.

---

## 5. `@api:` Data Protocol, Built-in Pipelines & Returned Fields

Bind `@api:<kind>:<query>` to a non-copy `props.<customKey>` (such as `items`, `cards`, `posts`) or `dataSource`.
- Skipped static copy keys: `title`, `subtitle`, `gallery_subtitle`, `feed_subtitle`, `section_subtitle`, `heading`, `text`, `label`, `description`, `summary`.
- **Static Config Only (Important)**: All `@api:*` parameters (`limit`, `page`, `offset`, `tag`, `folder`, `progress`) are **fixed query parameters compiled from block configuration**; visitor request URL query strings (such as `?page=2&tag=tech`) are **NOT** forwarded to `@api:*`. Do NOT generate fake `?page=2` or `?tag=...` anchor links expecting dynamic SSR re-querying—either rely on client-side filtering/pagination or pre-built static routes. If interactive tag filtering or archive pagination is needed, configure a suitable static `limit` (max 100) and implement client-side filtering/pagination inside `assets/js/` (listening to both `DOMContentLoaded` and `htmx:afterSettle`).
- Pagination bounds: `limit` (`1..100`, default `20`), `page`, `offset`.

| Prefix | Supported Params | Notes |
| :--- | :--- | :--- |
| `@api:article[s]:` | `id`, `slug`, `folder`, `locale` (`auto\|all\|<code>`), `tag`, `limit`, `page`, `offset` | Published public articles only; sorted by `COALESCE(published_at, created_at) DESC`; injects localized `url` |
| `@api:micro[s]:` | `id`, `slug`, `progress`, `folder`, `locale`, `tag`, `limit`, `page`, `offset` | Published public micro posts sorted by `COALESCE(published_at, created_at) DESC` (`url` stays `""`) |
| `@api:dataset[s]:` | `collection`, `schema`, `sort` (`order\|latest`, default `order`), `limit`, `page`, `offset`, plus `[a-zA-Z0-9_]` JSON filters | Excludes `api_only` schemas; sorts by `sort_order DESC, updated_at DESC` (`order`) or `updated_at DESC` (`latest`); flattens `metadata` & `fields` |
| `@api:media[s]:` | `id`, `mime`, `folder`, `limit`, `page`, `offset` | Public media assets only (stores relative `/content/...`; prefixes `PUBLIC_ASSETS_DOMAIN` at output time if configured) |
| `@api:feed[s]:` | `types` (`article,micro,dataset:<schema>`), `dataset`, `folder`, `tag`, `locale`, `limit`, `page`, `offset` | Merges & sorts chronologically by `published_at \|\| created_at` into unified `FeedItem[]` |

### Built-in `dataSource` Pipeline Boundary
- New themes only need **`fetch_backlinks`** (built-in `fetch_latest_nodes` and `fetch_datasets` are legacy equivalents superseded by `@api:feed:` and `@api:dataset:`).
- **`fetch_backlinks` Returned Items** (writes to `{{items}}` and `{{backlinks}}`): each entry contains `{ id, title, slug, type ('article' | 'micro'), maturity }`, plus loop-derived `url`, `text`, and `progress`.

### Returned Item Fields Quick Reference
- **Articles**: `id`, `slug`, `type`, `locale`, `title`, `summary`, `cover_image_url`, `progress`, `folder`, `metadata` (with `tags: string[]`, `author`, `og_image`, `aliases?: string[]`), raw Markdown `content_raw`, `url`, `published_at`, `created_at`, `updated_at` (list queries do NOT pre-render `content_html` / `content`).
- **Micros**: `id`, `slug`, `type`, `locale`, `title`, raw Markdown **`content_raw`** + precompiled HTML **`content_html`** (generated on save via Markdown/wikilink/theme container parser; no separate `summary` column), `progress`, `folder`, `metadata` (`tags: string[]`), `published_at`, `created_at`, `updated_at` (`url` is empty `""`).
- **Datasets**: `id`, `collection_id`, `schema_slug`, `slug`, `title`, `summary`, `sort_order` (integer weight descending), plus flattened custom `fields` and `metadata` keys at item top level.
- **Media**: `id`, `file_name`, `title`, `summary`, `file_size`, `mime_type`, `public_url`, `url`, `image_url` (all three URLs point to public asset URL), `folder`, `created_at`.
- **Feed (`@api:feed:`)**: Normalized `kind` (`'article' | 'micro' | 'dataset'`), `type_label`, `date` (derived from `published_at || created_at`), `title`, `summary` (for `'micro'` items, `summary` carries raw `content_raw` alongside optional `content_raw` & precompiled `content_html`), `url`, `badge`, `published_at`, `created_at`, plus optional `id`, `folder`, `progress`, `locale`, `tags` (`string[]` on article/micro), `cover_image_url`, `author`, `seo`.

> **Rendering Micro / Feed Body Content**: Prefer **`{{{content_html}}}`** on `@api:micro:` and micro `FeedItem` entries to render precompiled Markdown HTML cleanly (legacy `{{content_raw}}` / `{{summary}}` remains available as raw text). Use `{{summary}}` for `article` and `dataset` feed entries.

---

## 6. Template Engine Syntax & Scopes

### Block Props & Data Binding Scope
Inside any component `template_html`:
1. **`block.props.foo`** -> Merged with `default_props` and flattened directly into top-level scope as **`{{foo}}`** (do NOT prefix with `props.`; system-protected keys `powered_by`, `translations`, and `translations_json` cannot be overwritten).
2. **`block.dataSource`** (or component `dataSource` fallback) -> Resolved array binds to **`{{items}}`** for `{{#each items}}` whenever static `rawProps.items` is empty or non-array (`fetch_backlinks` also populates `{{backlinks}}`).
3. **`block.props.<customKey>: "@api:..."`** (any non-copy prop key) -> Resolved array binds to **`{{<customKey>}}`** for `{{#each <customKey>}}`, and automatically mirrors into **`{{items}}`** if `mergedProps.items` is not already an array. When a single component binds multiple `@api:*` keys in `props`, the template MUST explicitly use `{{#each <customKey>}}` for each key and NOT rely on the auto-mirrored `{{items}}`.

### Syntax & Escaping Rules
- `{{key}}` vs. `{{{key}}}`:
  - Both support dot paths (`site.name`, `page.title`) and return `""` for **any non-scalar object value (including arrays such as `tags: string[]`)**.
  - **`{{key}}` outputs values from data scope WITHOUT HTML escaping; ONLY strings resolved from `locales[locale]` (`i18n.*`) are HTML-escaped** (`&`, `<`, `>`, `"`). **Never place untrusted raw HTML inside ordinary data variables rendered with `{{key}}`.**
  - **`{{{key}}}`** resolves ONLY data scope (never `i18n`) and outputs raw HTML without escaping. Always use triple braces semantically for pre-rendered HTML slots (`{{{content_html}}}`, `{{{content}}}`, `{{{page.content}}}`, and `type: "markdown"` component fields). `@api:micro:` and micro `FeedItem` entries now provide precompiled `{{{content_html}}}` alongside `{{content_raw}}` / `{{summary}}`.
- Conditions: `{{#if key}}...{{else}}...{{/if}}` (supports nested `#if`; falsy when `[]`, `""`, `false`, `'false'`, `'0'`, `null`, `undefined`).
- Loops: `{{#each listKey}}...{{/each}}` (auto-parses JSON array strings; flattens `item`, `metadata`, `fields`, `url`/`href`, `text`/`label`, `title`, `summary`/`description`, `published_date`, `progress`, `folder`, `this`, `@index`/`index`; does **not** synthesize `tags_text` or join array fields into strings).
- **`tags` Rendering Scope Split (`detail` vs. `list`)**:
  - **At Page/Article Top Level**: `page.tags` is `string[]`, so **`{{#each page.tags}}{{this}}{{/each}}`** (or `{{#each tags}}{{this}}{{/each}}`) renders every tag cleanly (`{{page.tags}}` alone outputs `""`).
  - **Inside `{{#each items}}` List Loops**: Nested `{{#each}}` is unsupported and `{{key}}` outputs `""` for arrays, so **`{{tags}}` outputs `""` on `@api:article:` / `@api:micro:` / `@api:feed:` list items** (`{{#if tags}}` checks non-emptiness only). `{{tags}}` inside a list loop renders text ONLY when a dataset schema or static list stores a plain comma-separated string.
- Markdown Containers (`md_components`): Active ONLY when rendering **full article/prose bodies** (`{{{content_html}}}` / `{{{page.content}}}`) and **component `ui_schema` fields with `type: "markdown"`** via `<tag>...</tag>`, `:::tag\n...\n:::`, or `[[tag: ...]]`. Keys are plain container names (e.g. `"tip"` / `"callout"`); templates inside `manifest.md_components` receive **only `{{{content}}}`** (never `{content}`) and ignore inline fence header arguments (`:::tip Title` discards `Title`). If an article uses `[[tag: ...]]` without registering `tag` in `md_components`, it falls back to normal `[[wikilink]]` `<a>` parsing. List items from `@api:micro:`, `@api:article:`, or `@api:feed:` do **NOT** trigger `md_components`.

### Unsupported Template Features (Must Avoid)
- ❌ No condition expressions inside `{{#if}}` (no `==`, `!=`, `>`, `&&`, `||`, `!`).
- ❌ No `{{else if}}`, `{{#unless}}`, `{{#with}}`, or `{{> partial}}`.
- ❌ No nested `{{#each}}` inside another `{{#each}}` (`#if` inside `#each` IS supported).
- ❌ No custom helper functions or parent-scope traversal (`../`, `@first`, `@last`, `@key`).

### Built-in Template Variables
- **`site.*` (and top-level aliases)**: `site.name` (`site_name`, `brand_name`), `site.slogan` (`slogan`), `site.description` (`site_description`), `site.logo` (`logo_url`), `site.favicon`, `site.domain`, `site.copyright`, `site.email`, `site.socials` (`{ name, url, icon }[]`), `site.assetsBase`, `site.default_locale`, `powered_by` (`{ enabled, label, url }`).
  - **`site.socials[].icon` Note**: `icon` resolves to a **Material Symbols ligature keyword** (`'code'`, `'chat'`, `'mail'`, `'play_circle'`, `'menu_book'`, `'share'`). Because `{{edge_head}}` does NOT load Material Symbols for visitors, do NOT print `{{icon}}` as raw text unless your theme explicitly loads Material Symbols; prefer rendering `{{name}}` or mapping inline SVGs.
- **`page.*` (and top-level aliases)**: `page.title` (`title`), `page.slug`, `page.path`, `page.url`, `page.summary` (`summary`), `page.content` (`content`, `content_html`), `page.content_raw`, `page.published_date`, `page.updated_date`, `page.author`, `page.reading_time`, `page.cover_image`, `page.tags` (`string[]`), `page.category`, `page.locale`, `page.year`.
- **i18n & Translations**: `i18n.<key>` resolves through **`theme.locales[page.locale]` -> `theme.locales[requestLocale]` -> `theme.locales['zh-CN']` -> system built-in locale dict (`public/locales/<locale>.json` -> `'zh-CN'`) -> `""`** (`manifest.default_locale` is not queried as a dictionary fallback key, and themes may omit `locales` entirely in favor of direct copy). `translations` (`{ locale, url, isCurrent }[]`) populates only when `> 1` published peer translations exist.

---

## 7. Frontend CSS / JS Runtime Hooks

- **What `{{edge_head}}` Injects (and Does NOT Inject)**:
  - Injects SEO `<meta>` tags, `--edge-primary` style tag (when configured), declared `global_assets.styles`, `htmx.min.js`, inline i18n dictionary, `window.__EDGE__`, `theme-init.js`, `custom_css`, and conditional `window.__edgeMount`.
  - **Does NOT inject** any CSS Reset (`Preflight`), Tailwind CSS, or Material Symbols / icon fonts for anonymous visitors (unless your theme explicitly bundles its own CSS/fonts via `global_assets.styles`). Always use inline SVG icons, text/Unicode glyphs, or self-hosted theme icon fonts.
  - **`hx-boost` Behavior**: The core does **NOT** auto-add `hx-boost="true"`. Themes opt in by placing `hx-boost="true"` on `<body>` (or navigation wrappers) in `templates/layout.html` (HTMX default swap target is `body`; runtime automatically enforces `hx-boost="false"` on `/admin*` links).
- **Primary Site Accent Variable**: When configured on the site, `--edge-primary` is injected before theme stylesheets under `:root` and `html.dark` (`style="color: var(--edge-primary, #fallback)"`).
- **Dark Mode Preload Selectors**: Root class `html.dark` and attribute `html[data-theme-mode="light" | "dark" | "system"]` are locked synchronously before first paint. Preload rules automatically apply `display: none !important` to inactive `.theme-icon-light`, `.theme-icon-dark`, and `.theme-icon-system` elements. Call `window.toggleThemeMode()` from click handlers.
- **Reading Progress Hook**: Any element matching `[data-edge-reading-progress]` or `#edge-reading-progress` receives automatic scroll-percentage inline `style.width` updates (`0%`–`100%`).
- **Powered-by Visibility**: When `powered_by.enabled === true`, templates (e.g. footer) must render a visible `<a href="{{powered_by.url}}">{{powered_by.label}}</a>`.
- **Scoped Component JS (`allow_custom_js: true`)**:
  - Written inside **block `props.custom_js` or `default_props.custom_js`** (do **NOT** embed `<script>` inside `template_html`, and do **NOT** handwrite `window.__edgeMount(...)` or `document.currentScript`—the renderer injects `<script>window.__edgeMount(document.currentScript, function(root, $, $$, onCleanup){ ... })</script>` automatically and runs `onCleanup` on `htmx:beforeCleanupElement`):
  ```javascript
  const btn = $('button[data-copy]');
  if (btn) {
    const onClick = () => navigator.clipboard?.writeText(location.href);
    btn.addEventListener('click', onClick);
    onCleanup(() => btn.removeEventListener('click', onClick));
  }
  ```
- **Global Scripts (`assets/js/main.js`) & HTMX Transitions**: Global theme scripts load with `defer`; because `hx-boost` swaps `<body>` without full reloads, initialize widgets on both **`DOMContentLoaded`** and **`htmx:afterSettle`** / **`htmx:load`** (using idempotent `data-*` guards).
- **Visual Hover Edit Attributes** *(optional)*: Wrapping rendered dataset/component items with `data-edge-editable="true"`, `data-edge-component="<slug>"`, optional `data-edge-schema="<schema>"`, and optional `data-edge-entity-id="<itemId>"` enables inline quick-edit overlays for authenticated site admins.
- **Read-Only Runtime Context**: `window.__EDGE__` exposes `{ site, route, color_schemes, powered_by, blocks, blocksMap }` (never mutating or exposing `custom_js`).
