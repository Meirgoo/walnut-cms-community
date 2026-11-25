-- Walnut CMS - Initial Schema Migration (v2.2.0)
-- Automatically generated for Cloudflare D1 (SQLite)

-- 0. 系统元数据表
CREATE TABLE IF NOT EXISTS system_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 1. 多站点配置
CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    primary_domain TEXT NOT NULL UNIQUE,
    custom_domains TEXT,
    default_locale TEXT DEFAULT 'zh-CN',
    theme_id TEXT,
    license_key TEXT,
    settings TEXT,
    robots_txt TEXT,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. 用户与权限模型
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    cf_access_sub TEXT UNIQUE,
    global_role TEXT DEFAULT 'user',
    avatar_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS site_members (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(site_id, user_id)
);

-- 3. 核心文章 (Articles)
CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    locale TEXT DEFAULT 'zh-CN',
    translation_group_id TEXT,
    status TEXT DEFAULT 'draft',
    visibility TEXT DEFAULT 'public',
    maturity TEXT DEFAULT 'none',
    password TEXT,
    title TEXT NOT NULL,
    summary TEXT,
    cover_image_url TEXT,
    metadata TEXT,
    current_version_id TEXT,
    curator_id TEXT,
    published_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    UNIQUE(site_id, slug, locale)
);

-- 4. 微内容闪念速记 (Micros)
CREATE TABLE IF NOT EXISTS micros (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    locale TEXT DEFAULT 'zh-CN',
    status TEXT DEFAULT 'published',
    visibility TEXT DEFAULT 'public',
    progress TEXT DEFAULT '',
    title TEXT NOT NULL,
    content_raw TEXT NOT NULL DEFAULT '',
    content_html TEXT DEFAULT '',
    metadata TEXT,
    current_version_id TEXT,
    curator_id TEXT,
    published_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    UNIQUE(site_id, slug, locale)
);

-- 5. 独立页面 (Pages)
CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    parent_id TEXT NOT NULL DEFAULT '',
    locale TEXT DEFAULT 'zh-CN',
    translation_group_id TEXT,
    status TEXT DEFAULT 'draft',
    visibility TEXT DEFAULT 'public',
    password TEXT,
    title TEXT NOT NULL,
    summary TEXT,
    cover_image_url TEXT,
    metadata TEXT,
    current_version_id TEXT,
    curator_id TEXT,
    published_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    UNIQUE(site_id, slug, locale, parent_id)
);

-- 6. 主题配置包 (Themes)
CREATE TABLE IF NOT EXISTS themes (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    author TEXT,
    version TEXT DEFAULT '1.0.0',
    description TEXT,
    preview_image TEXT,
    is_active INTEGER DEFAULT 0,
    status TEXT DEFAULT 'published',
    metadata TEXT,
    current_version_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    UNIQUE(site_id, slug)
);

-- 6.1 统一实体版本快照表 (Entity Versions)
CREATE TABLE IF NOT EXISTS entity_versions (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    version_number INTEGER NOT NULL,
    version_tag TEXT,
    title TEXT NOT NULL DEFAULT '',
    summary TEXT,
    content_raw TEXT NOT NULL DEFAULT '',
    content_rendered TEXT DEFAULT '',
    metadata_snapshot TEXT,
    commit_message TEXT,
    author_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    UNIQUE(entity_type, entity_id, version_number)
);

-- 7. 双链与拓扑关系图谱 (Wiki-Links & Content Relations)
CREATE TABLE IF NOT EXISTS content_relations (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'article',
    target_id TEXT,
    target_type TEXT NOT NULL DEFAULT 'article',
    target_slug TEXT NOT NULL,
    relation_type TEXT NOT NULL DEFAULT 'wiki_link',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 7.1 结构化数据集集合与条目 (Dataset Collections & Items)
CREATE TABLE IF NOT EXISTS dataset_collections (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    schema_key TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    UNIQUE(site_id, slug)
);

CREATE TABLE IF NOT EXISTS datasets (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    collection_id TEXT NOT NULL DEFAULT '',
    schema_slug TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    metadata TEXT,
    status TEXT NOT NULL DEFAULT 'published',
    sort_order INTEGER DEFAULT 0,
    curator_id TEXT,
    current_version_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    UNIQUE(site_id, collection_id, slug)
);

-- 8. 独立图床与多媒体资产 (Media Assets)
CREATE TABLE IF NOT EXISTS media_assets (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    r2_key TEXT NOT NULL UNIQUE,
    public_url TEXT NOT NULL,
    metadata TEXT,
    is_public INTEGER DEFAULT 1,
    uploader_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME
);

-- 9. 错峰定时任务 (Scheduled Tasks)
CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    site_id TEXT,
    task_type TEXT NOT NULL,
    schedule_type TEXT DEFAULT 'recurring',
    interval_preset TEXT DEFAULT 'custom',
    payload TEXT,
    cron_interval_minutes INTEGER DEFAULT 5,
    next_run_at DATETIME NOT NULL,
    last_run_at DATETIME,
    last_result TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 10. 站点路由与预编译页面缓存表 (Site Routes & Prerender Cache)
CREATE TABLE IF NOT EXISTS site_routes (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    path TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'page',
    entity_id TEXT,
    locale TEXT DEFAULT 'zh-CN',
    translation_group_id TEXT,
    title TEXT,
    version INTEGER DEFAULT 1,
    rendered_html TEXT,
    status_code INTEGER DEFAULT 200,
    redirect_target TEXT,
    is_dirty INTEGER DEFAULT 1,
    changefreq TEXT DEFAULT 'weekly',
    priority REAL DEFAULT 0.8,
    images_json TEXT,
    template_id TEXT,
    schema_slug TEXT,
    dependencies_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(site_id, path)
);

-- 12. 基础 Webhook 转发规则表 (无限原始转发下放至社区内核)
CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '["*"]',
    secret TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 13. 核心索引优化
CREATE INDEX IF NOT EXISTS idx_articles_lookup ON articles(site_id, status, visibility, deleted_at);
CREATE INDEX IF NOT EXISTS idx_articles_slug ON articles(site_id, slug, locale);

CREATE INDEX IF NOT EXISTS idx_micros_lookup ON micros(site_id, status, visibility, deleted_at);
CREATE INDEX IF NOT EXISTS idx_micros_slug ON micros(site_id, slug, locale);

CREATE INDEX IF NOT EXISTS idx_pages_lookup ON pages(site_id, status, visibility, deleted_at);
CREATE INDEX IF NOT EXISTS idx_pages_slug ON pages(site_id, slug, locale);
CREATE INDEX IF NOT EXISTS idx_pages_trans_group ON pages(site_id, translation_group_id);

CREATE INDEX IF NOT EXISTS idx_themes_site ON themes(site_id, is_active, deleted_at);
CREATE INDEX IF NOT EXISTS idx_entity_versions_lookup ON entity_versions(entity_type, entity_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_entity_versions_site ON entity_versions(site_id, entity_type, deleted_at);

CREATE INDEX IF NOT EXISTS idx_relations_source ON content_relations(site_id, source_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON content_relations(site_id, target_slug);

CREATE INDEX IF NOT EXISTS idx_media_site ON media_assets(site_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_dataset_collections_site ON dataset_collections(site_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_datasets_site_collection ON datasets(site_id, collection_id, status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_datasets_sort_order ON datasets(site_id, collection_id, sort_order DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_datasets_site_schema ON datasets(site_id, schema_slug, status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_datasets_slug ON datasets(site_id, collection_id, slug);
CREATE INDEX IF NOT EXISTS idx_tasks_run ON scheduled_tasks(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_tasks_site ON scheduled_tasks(site_id, status);
CREATE INDEX IF NOT EXISTS idx_site_routes_lookup ON site_routes(site_id, path);
CREATE INDEX IF NOT EXISTS idx_site_routes_entity ON site_routes(site_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_site_routes_dirty ON site_routes(site_id, is_dirty);
CREATE INDEX IF NOT EXISTS idx_webhooks_site ON webhooks(site_id, is_active);

-- 14. 开放授权与生态直连令牌表 (API & Ecosystem Tokens)
CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_type TEXT NOT NULL DEFAULT 'commercial_pat',
    scopes TEXT NOT NULL DEFAULT '["*"]',
    created_by TEXT,
    expires_at TEXT,
    last_used_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_lookup ON api_tokens(site_id, token_hash);
