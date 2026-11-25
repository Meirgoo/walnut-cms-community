import type { D1Database } from '@cloudflare/workers-types';
import { hashPassword, DEFAULT_DEV_HOST, nanoId, WALNUT_SCHEMA_VERSION } from '../../engine';

export const CURRENT_SCHEMA_VERSION = WALNUT_SCHEMA_VERSION;

export interface SetupInitialParams {
    superadminEmail: string;
    superadminUsername: string;
    superadminPassword?: string;
    cfAccessSub?: string;
    initialSiteName?: string;
    primaryDomain?: string;
}

const PK = 'id TEXT PRIMARY KEY';
const TS = 'created_at DATETIME DEFAULT CURRENT_TIMESTAMP';
const TM = `${TS}, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`;
const DL = ', deleted_at DATETIME';
const S = ', site_id TEXT NOT NULL';

const TABLE_DEFS: [string, string][] = [
    ['system_meta', `key TEXT PRIMARY KEY, value TEXT NOT NULL, ${TM}`],
    ['sites', `${PK}, name TEXT NOT NULL, primary_domain TEXT NOT NULL UNIQUE, custom_domains TEXT, default_locale TEXT DEFAULT 'zh-CN', theme_id TEXT, license_key TEXT, settings TEXT, robots_txt TEXT, status TEXT DEFAULT 'active', ${TM}`],
    ['users', `${PK}, email TEXT UNIQUE NOT NULL, username TEXT UNIQUE NOT NULL, password_hash TEXT, cf_access_sub TEXT UNIQUE, global_role TEXT DEFAULT 'user', avatar_url TEXT, ${TM}`],
    ['site_members', `${PK}${S}, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', ${TS}, UNIQUE(site_id, user_id)`],
    ['articles', `${PK}${S}, slug TEXT NOT NULL, locale TEXT DEFAULT 'zh-CN', translation_group_id TEXT, status TEXT DEFAULT 'draft', visibility TEXT DEFAULT 'public', maturity TEXT DEFAULT 'none', password TEXT, title TEXT NOT NULL, summary TEXT, cover_image_url TEXT, metadata TEXT, current_version_id TEXT, curator_id TEXT, published_at DATETIME, ${TM}${DL}, UNIQUE(site_id, slug, locale)`],
    ['micros', `${PK}${S}, slug TEXT NOT NULL, locale TEXT DEFAULT 'zh-CN', status TEXT DEFAULT 'published', visibility TEXT DEFAULT 'public', progress TEXT DEFAULT '', title TEXT NOT NULL, content_raw TEXT NOT NULL DEFAULT '', content_html TEXT DEFAULT '', metadata TEXT, current_version_id TEXT, curator_id TEXT, published_at DATETIME, ${TM}${DL}, UNIQUE(site_id, slug, locale)`],
    ['pages', `${PK}${S}, slug TEXT NOT NULL, parent_id TEXT NOT NULL DEFAULT '', locale TEXT DEFAULT 'zh-CN', translation_group_id TEXT, status TEXT DEFAULT 'draft', visibility TEXT DEFAULT 'public', password TEXT, title TEXT NOT NULL, summary TEXT, cover_image_url TEXT, metadata TEXT, current_version_id TEXT, curator_id TEXT, published_at DATETIME, ${TM}${DL}, UNIQUE(site_id, slug, locale, parent_id)`],
    ['themes', `${PK}${S}, slug TEXT NOT NULL, name TEXT NOT NULL, author TEXT, version TEXT DEFAULT '1.0.0', description TEXT, preview_image TEXT, is_active INTEGER DEFAULT 0, status TEXT DEFAULT 'published', metadata TEXT, current_version_id TEXT, ${TM}${DL}, UNIQUE(site_id, slug)`],
    ['entity_versions', `${PK}${S}, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, version_number INTEGER NOT NULL, version_tag TEXT, title TEXT NOT NULL DEFAULT '', summary TEXT, content_raw TEXT NOT NULL DEFAULT '', content_rendered TEXT DEFAULT '', metadata_snapshot TEXT, commit_message TEXT, author_id TEXT, ${TS}${DL}, UNIQUE(entity_type, entity_id, version_number)`],
    ['content_relations', `${PK}${S}, source_id TEXT NOT NULL, source_type TEXT NOT NULL DEFAULT 'article', target_id TEXT, target_type TEXT NOT NULL DEFAULT 'article', target_slug TEXT NOT NULL, relation_type TEXT NOT NULL DEFAULT 'wiki_link', ${TS}`],
    ['dataset_collections', `${PK}${S}, slug TEXT NOT NULL, name TEXT NOT NULL, schema_key TEXT NOT NULL, description TEXT, ${TM}${DL}, UNIQUE(site_id, slug)`],
    ['datasets', `${PK}${S}, collection_id TEXT NOT NULL DEFAULT '', schema_slug TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, summary TEXT, metadata TEXT, status TEXT NOT NULL DEFAULT 'published', sort_order INTEGER DEFAULT 0, curator_id TEXT, current_version_id TEXT, ${TM}${DL}, UNIQUE(site_id, collection_id, slug)`],
    ['media_assets', `${PK}${S}, file_name TEXT NOT NULL, file_size INTEGER NOT NULL, mime_type TEXT NOT NULL, r2_key TEXT NOT NULL UNIQUE, public_url TEXT NOT NULL, metadata TEXT, is_public INTEGER DEFAULT 1, uploader_id TEXT, ${TS}${DL}`],
    ['scheduled_tasks', `${PK}, site_id TEXT, task_type TEXT NOT NULL, schedule_type TEXT DEFAULT 'recurring', interval_preset TEXT DEFAULT 'custom', payload TEXT, cron_interval_minutes INTEGER DEFAULT 5, next_run_at DATETIME NOT NULL, last_run_at DATETIME, last_result TEXT, status TEXT DEFAULT 'pending', ${TS}`],
    ['site_routes', `${PK}${S}, path TEXT NOT NULL, entity_type TEXT NOT NULL DEFAULT 'page', entity_id TEXT, locale TEXT DEFAULT 'zh-CN', translation_group_id TEXT, title TEXT, version INTEGER DEFAULT 1, rendered_html TEXT, status_code INTEGER DEFAULT 200, redirect_target TEXT, is_dirty INTEGER DEFAULT 1, changefreq TEXT DEFAULT 'weekly', priority REAL DEFAULT 0.8, images_json TEXT, template_id TEXT, schema_slug TEXT, dependencies_json TEXT, ${TM}, UNIQUE(site_id, path)`],
    ['webhooks', `${PK}${S}, name TEXT NOT NULL, url TEXT NOT NULL, events TEXT NOT NULL DEFAULT '["*"]', secret TEXT, is_active INTEGER NOT NULL DEFAULT 1, ${TS}`],
    ['api_tokens', `${PK}${S}, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_type TEXT NOT NULL DEFAULT 'commercial_pat', scopes TEXT NOT NULL DEFAULT '["*"]', created_by TEXT, expires_at TEXT, last_used_at TEXT, ${TS}`]
];

const INDEX_DEFS = [
    'articles(site_id, status, visibility, deleted_at)', 'articles(site_id, slug, locale)',
    'micros(site_id, status, visibility, deleted_at)', 'micros(site_id, slug, locale)',
    'pages(site_id, status, visibility, deleted_at)', 'pages(site_id, slug, locale)', 'pages(site_id, translation_group_id)',
    'themes(site_id, is_active, deleted_at)',
    'entity_versions(entity_type, entity_id, version_number DESC)', 'entity_versions(site_id, entity_type, deleted_at)',
    'content_relations(site_id, source_id)', 'content_relations(site_id, target_slug)', 'media_assets(site_id, deleted_at)',
    'dataset_collections(site_id, deleted_at)', 'datasets(site_id, collection_id, status, deleted_at)', 'datasets(site_id, schema_slug, status, deleted_at)', 'datasets(site_id, collection_id, slug)',
    'scheduled_tasks(status, next_run_at)', 'scheduled_tasks(site_id, status)',
    'site_routes(site_id, path)', 'site_routes(site_id, entity_id)', 'site_routes(site_id, is_dirty)',
    'webhooks(site_id, is_active)',
    'api_tokens(site_id, token_hash)'
].map((cols, i) => `idx_g_${i} ON ${cols}`);

export const GENESIS_SCHEMA_STATEMENTS = [
    ...TABLE_DEFS.map(([name, schema]) => `CREATE TABLE IF NOT EXISTS ${name} (${schema})`),
    ...INDEX_DEFS.map((clause) => `CREATE INDEX IF NOT EXISTS ${clause}`)
];

export async function ensureSchema(db: D1Database): Promise<void> {
    try {
        const check = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='site_routes' LIMIT 1").first<{ name: string }>();
        if (check) {
            for (const sql of [
                "ALTER TABLE sites ADD COLUMN robots_txt TEXT",
                "ALTER TABLE pages ADD COLUMN translation_group_id TEXT",
                "ALTER TABLE micros ADD COLUMN content_html TEXT DEFAULT ''",
                "ALTER TABLE datasets ADD COLUMN sort_order INTEGER DEFAULT 0",
                "CREATE INDEX IF NOT EXISTS idx_datasets_sort_order ON datasets(site_id, collection_id, sort_order DESC, updated_at DESC)",
                "CREATE INDEX IF NOT EXISTS idx_pages_trans_group ON pages(site_id, translation_group_id)",
                "ALTER TABLE scheduled_tasks ADD COLUMN schedule_type TEXT DEFAULT 'recurring'",
                "ALTER TABLE scheduled_tasks ADD COLUMN interval_preset TEXT DEFAULT 'custom'",
                "ALTER TABLE scheduled_tasks ADD COLUMN last_result TEXT",
                "CREATE TABLE IF NOT EXISTS api_tokens (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_type TEXT NOT NULL DEFAULT 'commercial_pat', scopes TEXT NOT NULL DEFAULT '[\"*\"]', created_by TEXT, expires_at TEXT, last_used_at TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
                "CREATE INDEX IF NOT EXISTS idx_api_tokens_lookup ON api_tokens(site_id, token_hash)",
                "CREATE TABLE IF NOT EXISTS entity_versions (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, version_number INTEGER NOT NULL, version_tag TEXT, title TEXT NOT NULL DEFAULT '', summary TEXT, content_raw TEXT NOT NULL DEFAULT '', content_rendered TEXT DEFAULT '', metadata_snapshot TEXT, commit_message TEXT, author_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_at DATETIME, UNIQUE(entity_type, entity_id, version_number))",
                "CREATE INDEX IF NOT EXISTS idx_entity_versions_lookup ON entity_versions(entity_type, entity_id, version_number DESC)",
                "CREATE INDEX IF NOT EXISTS idx_entity_versions_site ON entity_versions(site_id, entity_type, deleted_at)",
                "CREATE TABLE IF NOT EXISTS dataset_collections (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL, schema_key TEXT NOT NULL, description TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, deleted_at DATETIME, UNIQUE(site_id, slug))",
                "CREATE INDEX IF NOT EXISTS idx_dataset_collections_site ON dataset_collections(site_id, deleted_at)",
                "CREATE INDEX IF NOT EXISTS idx_datasets_site_collection ON datasets(site_id, collection_id, status, deleted_at)",
                "INSERT INTO dataset_collections (id, site_id, slug, name, schema_key) SELECT DISTINCT CASE WHEN site_id = 'site_default' AND schema_slug = 'projects' THEN 'col_projects' ELSE 'col_' || site_id || '_' || schema_slug END, site_id, schema_slug, schema_slug, schema_slug FROM datasets WHERE deleted_at IS NULL AND schema_slug IS NOT NULL AND schema_slug != '' ON CONFLICT(site_id, slug) DO NOTHING",
                "UPDATE datasets SET collection_id = (SELECT dc.id FROM dataset_collections dc WHERE dc.site_id = datasets.site_id AND dc.slug = datasets.schema_slug AND dc.deleted_at IS NULL LIMIT 1) WHERE (collection_id IS NULL OR collection_id = '') AND deleted_at IS NULL"
            ]) {
                try { await db.prepare(sql).run(); } catch {}
            }
            return;
        }
    } catch {}
    await db.batch(GENESIS_SCHEMA_STATEMENTS.map(sql => db.prepare(sql)));
}

export async function installSystem(db: D1Database, params: SetupInitialParams): Promise<{
    siteId: string;
    superadminId: string;
}> {
    await ensureSchema(db);
    const superadminId = nanoId('u');
    const siteId = 'site_default';
    const passwordHash = params.superadminPassword ? await hashPassword(params.superadminPassword) : null;

    const batchList = [
        db.prepare('INSERT INTO sites (id, name, primary_domain, default_locale, theme_id, settings, status) VALUES (?, ?, ?, \'zh-CN\', \'theme_univers\', \'{"site_name":"Walnut Starter","primary_color":"#342E7A","primary_color_dark":"#8B7CF6","theme_mode":"system"}\', \'active\') ON CONFLICT(id) DO NOTHING').bind(siteId, params.initialSiteName || 'Walnut Starter', params.primaryDomain || DEFAULT_DEV_HOST),
        db.prepare("INSERT INTO users (id, email, username, password_hash, cf_access_sub, global_role) VALUES (?, ?, ?, ?, ?, 'superadmin') ON CONFLICT(email) DO UPDATE SET global_role = 'superadmin', username = excluded.username").bind(superadminId, params.superadminEmail, params.superadminUsername, passwordHash, params.cfAccessSub || null),
        db.prepare("INSERT INTO site_members (id, site_id, user_id, role) VALUES (?, ?, ?, 'admin') ON CONFLICT(site_id, user_id) DO UPDATE SET role = 'admin'").bind(nanoId('sm'), siteId, superadminId),
        db.prepare("INSERT INTO system_meta (key, value) VALUES ('installed', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = CURRENT_TIMESTAMP"),
        db.prepare("INSERT INTO system_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP").bind(CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION),
        db.prepare("INSERT INTO system_meta (key, value) VALUES ('system_salt', ?) ON CONFLICT(key) DO NOTHING").bind(nanoId('salt_', 32))
    ];

    if (params.initialSiteName || params.primaryDomain) {
        batchList.push(db.prepare("UPDATE sites SET name = COALESCE(NULLIF(?, ''), name), primary_domain = COALESCE(NULLIF(?, ''), primary_domain), updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(params.initialSiteName || null, params.primaryDomain || null, siteId));
    }
    batchList.push(
        db.prepare("UPDATE articles SET curator_id = ? WHERE site_id = ? AND curator_id = 'system'").bind(superadminId, siteId),
        db.prepare("UPDATE pages SET curator_id = ? WHERE site_id = ? AND curator_id = 'system'").bind(superadminId, siteId)
    );

    await db.batch(batchList);
    return { siteId, superadminId };
}
