import type { D1Database } from '@cloudflare/workers-types';
import { hashPassword, DEFAULT_DEV_HOST, nanoId } from '../../engine';

export const CURRENT_SCHEMA_VERSION = '0.9.0';

export interface SetupInitialParams {
    superadminEmail: string;
    superadminUsername: string;
    superadminPassword?: string;
    cfAccessSub?: string;
    initialTenantName?: string;
    initialSiteName?: string;
    primaryDomain?: string;
}

const PK = 'id TEXT PRIMARY KEY';
const TS = 'created_at DATETIME DEFAULT CURRENT_TIMESTAMP';
const TM = `${TS}, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`;
const DL = ', deleted_at DATETIME';
const S = ', site_id TEXT NOT NULL';
const V = (fk: string) => `${PK}, ${fk} TEXT NOT NULL, version_number INTEGER NOT NULL, title TEXT NOT NULL, summary TEXT, content_raw TEXT NOT NULL DEFAULT '', content_rendered TEXT DEFAULT '', metadata_snapshot TEXT, commit_message TEXT, author_id TEXT, ${TS}${DL}, UNIQUE(${fk}, version_number)`;

const TABLE_DEFS: [string, string][] = [
    ['system_meta', `key TEXT PRIMARY KEY, value TEXT NOT NULL, ${TM}`],
    ['tenants', `${PK}, name TEXT NOT NULL, status TEXT DEFAULT 'active', ${TM}`],
    ['sites', `${PK}, tenant_id TEXT NOT NULL, name TEXT NOT NULL, primary_domain TEXT NOT NULL UNIQUE, custom_domains TEXT, default_locale TEXT DEFAULT 'zh-CN', theme_id TEXT, is_media_bed_only INTEGER DEFAULT 0, license_key TEXT, settings TEXT, robots_txt TEXT, status TEXT DEFAULT 'active', ${TM}`],
    ['users', `${PK}, email TEXT UNIQUE NOT NULL, username TEXT UNIQUE NOT NULL, password_hash TEXT, cf_access_sub TEXT UNIQUE, global_role TEXT DEFAULT 'user', avatar_url TEXT, ${TM}`],
    ['site_members', `${PK}${S}, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin', ${TS}, UNIQUE(site_id, user_id)`],
    ['articles', `${PK}${S}, slug TEXT NOT NULL, locale TEXT DEFAULT 'zh-CN', translation_group_id TEXT, status TEXT DEFAULT 'draft', visibility TEXT DEFAULT 'public', maturity TEXT DEFAULT 'none', password TEXT, title TEXT NOT NULL, summary TEXT, cover_image_url TEXT, metadata TEXT, current_version_id TEXT, curator_id TEXT, published_at DATETIME, ${TM}${DL}, UNIQUE(site_id, slug, locale)`],
    ['article_versions', V('article_id')],
    ['micros', `${PK}${S}, slug TEXT NOT NULL, locale TEXT DEFAULT 'zh-CN', status TEXT DEFAULT 'published', visibility TEXT DEFAULT 'public', progress TEXT DEFAULT '', title TEXT NOT NULL, content_raw TEXT NOT NULL DEFAULT '', metadata TEXT, current_version_id TEXT, curator_id TEXT, published_at DATETIME, ${TM}${DL}, UNIQUE(site_id, slug, locale)`],
    ['micro_versions', `${PK}, micro_id TEXT NOT NULL, version_number INTEGER NOT NULL, title TEXT NOT NULL, content_raw TEXT NOT NULL DEFAULT '', metadata_snapshot TEXT, commit_message TEXT, author_id TEXT, ${TS}${DL}, UNIQUE(micro_id, version_number)`],
    ['pages', `${PK}${S}, slug TEXT NOT NULL, parent_id TEXT, locale TEXT DEFAULT 'zh-CN', status TEXT DEFAULT 'draft', visibility TEXT DEFAULT 'public', password TEXT, title TEXT NOT NULL, summary TEXT, cover_image_url TEXT, metadata TEXT, current_version_id TEXT, curator_id TEXT, published_at DATETIME, ${TM}${DL}, UNIQUE(site_id, slug, locale, parent_id)`],
    ['page_versions', V('page_id')],
    ['themes', `${PK}${S}, slug TEXT NOT NULL, name TEXT NOT NULL, author TEXT, version TEXT DEFAULT '1.0.0', description TEXT, preview_image TEXT, is_active INTEGER DEFAULT 0, status TEXT DEFAULT 'published', metadata TEXT, current_version_id TEXT, ${TM}${DL}, UNIQUE(site_id, slug)`],
    ['theme_versions', `${PK}, theme_id TEXT NOT NULL, version_number INTEGER NOT NULL, version_tag TEXT, metadata_snapshot TEXT, commit_message TEXT, author_id TEXT, ${TS}${DL}, UNIQUE(theme_id, version_number)`],
    ['content_relations', `${PK}${S}, source_id TEXT NOT NULL, source_type TEXT NOT NULL DEFAULT 'article', target_id TEXT, target_type TEXT NOT NULL DEFAULT 'article', target_slug TEXT NOT NULL, relation_type TEXT NOT NULL DEFAULT 'wiki_link', ${TS}`],
    ['translation_groups', `${PK}${S}, name TEXT NOT NULL, description TEXT, ${TS}`],
    ['datasets', `${PK}${S}, schema_slug TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, summary TEXT, metadata TEXT, status TEXT NOT NULL DEFAULT 'published', curator_id TEXT, current_version_id TEXT, ${TM}${DL}, UNIQUE(site_id, slug)`],
    ['dataset_versions', `${PK}, dataset_id TEXT NOT NULL, version_number INTEGER NOT NULL, title TEXT NOT NULL, summary TEXT, metadata_snapshot TEXT NOT NULL, commit_message TEXT, author_id TEXT, ${TS}${DL}, UNIQUE(dataset_id, version_number)`],
    ['media_assets', `${PK}${S}, file_name TEXT NOT NULL, file_size INTEGER NOT NULL, mime_type TEXT NOT NULL, r2_key TEXT NOT NULL UNIQUE, public_url TEXT NOT NULL, metadata TEXT, is_public INTEGER DEFAULT 1, uploader_id TEXT, ${TS}${DL}`],
    ['scheduled_tasks', `${PK}, site_id TEXT, task_type TEXT NOT NULL, schedule_type TEXT DEFAULT 'recurring', interval_preset TEXT DEFAULT 'custom', payload TEXT, cron_interval_minutes INTEGER DEFAULT 5, next_run_at DATETIME NOT NULL, last_run_at DATETIME, last_result TEXT, status TEXT DEFAULT 'pending', ${TS}`],
    ['site_routes', `${PK}${S}, path TEXT NOT NULL, entity_type TEXT NOT NULL DEFAULT 'page', entity_id TEXT, locale TEXT DEFAULT 'zh-CN', translation_group_id TEXT, title TEXT, version INTEGER DEFAULT 1, rendered_html TEXT, status_code INTEGER DEFAULT 200, redirect_target TEXT, is_dirty INTEGER DEFAULT 1, changefreq TEXT DEFAULT 'weekly', priority REAL DEFAULT 0.8, images_json TEXT, template_id TEXT, schema_slug TEXT, dependencies_json TEXT, ${TM}, UNIQUE(site_id, path)`],
    ['webhooks', `${PK}${S}, name TEXT NOT NULL, url TEXT NOT NULL, events TEXT NOT NULL DEFAULT '["*"]', secret TEXT, is_active INTEGER NOT NULL DEFAULT 1, ${TS}`],
    ['api_tokens', `${PK}${S}, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_type TEXT NOT NULL DEFAULT 'commercial_pat', scopes TEXT NOT NULL DEFAULT '["*"]', created_by TEXT, expires_at TEXT, last_used_at TEXT, ${TS}`]
];

const INDEX_DEFS = [
    'articles(site_id, status, visibility, deleted_at)', 'articles(site_id, slug, locale)', 'article_versions(article_id, version_number DESC)',
    'micros(site_id, status, visibility, deleted_at)', 'micros(site_id, slug, locale)', 'micro_versions(micro_id, version_number DESC)',
    'pages(site_id, status, visibility, deleted_at)', 'pages(site_id, slug, locale)', 'page_versions(page_id, version_number DESC)',
    'themes(site_id, is_active, deleted_at)', 'theme_versions(theme_id, version_number DESC)',
    'content_relations(site_id, source_id)', 'content_relations(site_id, target_slug)', 'media_assets(site_id, deleted_at)', 'translation_groups(site_id)',
    'datasets(site_id, schema_slug, status, deleted_at)', 'datasets(site_id, slug)', 'dataset_versions(dataset_id, version_number DESC)',
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
                "ALTER TABLE scheduled_tasks ADD COLUMN schedule_type TEXT DEFAULT 'recurring'",
                "ALTER TABLE scheduled_tasks ADD COLUMN interval_preset TEXT DEFAULT 'custom'",
                "ALTER TABLE scheduled_tasks ADD COLUMN last_result TEXT",
                "CREATE TABLE IF NOT EXISTS api_tokens (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_type TEXT NOT NULL DEFAULT 'commercial_pat', scopes TEXT NOT NULL DEFAULT '[\"*\"]', created_by TEXT, expires_at TEXT, last_used_at TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)",
                "CREATE INDEX IF NOT EXISTS idx_api_tokens_lookup ON api_tokens(site_id, token_hash)"
            ]) {
                try { await db.prepare(sql).run(); } catch {}
            }
            return;
        }
    } catch {}
    await db.batch(GENESIS_SCHEMA_STATEMENTS.map(sql => db.prepare(sql)));
}

export async function installSystem(db: D1Database, params: SetupInitialParams): Promise<{
    tenantId: string;
    siteId: string;
    superadminId: string;
}> {
    await ensureSchema(db);
    const superadminId = nanoId('u');
    const siteId = 'site_default';
    const tenantId = 'tenant_default';
    const passwordHash = params.superadminPassword ? await hashPassword(params.superadminPassword) : null;

    const batchList = [
        db.prepare("INSERT INTO tenants (id, name, status) VALUES (?, ?, 'active') ON CONFLICT(id) DO NOTHING").bind(tenantId, params.initialTenantName || 'Default Tenant'),
        db.prepare('INSERT INTO sites (id, tenant_id, name, primary_domain, default_locale, theme_id, settings, status) VALUES (?, ?, ?, ?, \'zh-CN\', \'theme_univers\', \'{"site_name":"Walnut Starter","primary_color":"#10b981","primary_color_dark":"#34d399","theme_mode":"system"}\', \'active\') ON CONFLICT(id) DO NOTHING').bind(siteId, tenantId, params.initialSiteName || 'Walnut Starter', params.primaryDomain || DEFAULT_DEV_HOST),
        db.prepare("INSERT INTO users (id, email, username, password_hash, cf_access_sub, global_role) VALUES (?, ?, ?, ?, ?, 'superadmin') ON CONFLICT(email) DO UPDATE SET global_role = 'superadmin', username = excluded.username").bind(superadminId, params.superadminEmail, params.superadminUsername, passwordHash, params.cfAccessSub || null),
        db.prepare("INSERT INTO site_members (id, site_id, user_id, role) VALUES (?, ?, ?, 'admin') ON CONFLICT(site_id, user_id) DO UPDATE SET role = 'admin'").bind(nanoId('sm'), siteId, superadminId),
        db.prepare("INSERT INTO system_meta (key, value) VALUES ('installed', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = CURRENT_TIMESTAMP"),
        db.prepare("INSERT INTO system_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP").bind(CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION),
        db.prepare("INSERT INTO system_meta (key, value) VALUES ('system_salt', ?) ON CONFLICT(key) DO NOTHING").bind(nanoId('salt_', 32))
    ];

    if (params.initialSiteName || params.primaryDomain) {
        batchList.push(db.prepare("UPDATE sites SET name = COALESCE(NULLIF(?, ''), name), primary_domain = COALESCE(NULLIF(?, ''), primary_domain), updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(params.initialSiteName || null, params.primaryDomain || null, siteId));
    }
    if (params.initialTenantName) {
        batchList.push(db.prepare("UPDATE tenants SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(params.initialTenantName, tenantId));
    }
    batchList.push(
        db.prepare("UPDATE articles SET curator_id = ? WHERE site_id = ? AND curator_id = 'system'").bind(superadminId, siteId),
        db.prepare("UPDATE pages SET curator_id = ? WHERE site_id = ? AND curator_id = 'system'").bind(superadminId, siteId)
    );

    await db.batch(batchList);
    return { tenantId, siteId, superadminId };
}
