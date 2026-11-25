import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { formatRelativeOrShortTime, formatSiteDateTime, parseUtcDate, t } from '../i18n';
import { findPublishedTheme } from './themes.dal';
import {
    Node,
    NodeVersion,
    GardenMaturity,
    parseJson,
    toVirtualNode
} from './content-common';
import { getNodeBacklinks, findTranslationGroups } from './relations.dal';
import { findRecentAbnormalAuditLogs } from './audit.dal';

interface DashboardCounts {
    totalNodes: number;
    publishedCount: number;
    draftCount: number;
    mediaCount: number;
    microCount: number;
    microFolderCount: number;
    pageCount: number;
    dirtyRouteCount: number;
    datasetGroupCount: number;
    routeCount: number;
}

function buildDashboardCountStatements(db: D1Database, siteId: string): D1PreparedStatement[] {
    return [
        db.prepare(`
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) as pub,
                   SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as draft
            FROM articles WHERE site_id = ? AND deleted_at IS NULL
        `).bind(siteId),
        db.prepare(`SELECT COUNT(*) as count FROM media_assets WHERE site_id = ? AND deleted_at IS NULL`).bind(siteId),
        db.prepare(`
            SELECT COUNT(*) as count,
                   COUNT(DISTINCT NULLIF(json_extract(metadata, '$.folder'), '')) as folder_count
            FROM micros WHERE site_id = ? AND deleted_at IS NULL
        `).bind(siteId),
        db.prepare(`
            SELECT COUNT(*) as total
            FROM pages WHERE site_id = ? AND deleted_at IS NULL
        `).bind(siteId),
        db.prepare(`
            SELECT COUNT(*) as count
            FROM dataset_collections WHERE site_id = ? AND deleted_at IS NULL
        `).bind(siteId),
        db.prepare(`
            SELECT COUNT(*) as count,
                   SUM(CASE WHEN is_dirty = 1 THEN 1 ELSE 0 END) as dirty
            FROM site_routes WHERE site_id = ?
        `).bind(siteId)
    ];
}

function extractDashboardCounts(batchRes: any[]): DashboardCounts {
    const art = batchRes[0]?.results?.[0] as { total: number; pub: number; draft: number } | undefined;
    const mediaRes = batchRes[1]?.results?.[0] as { count: number } | undefined;
    const microRes = batchRes[2]?.results?.[0] as { count: number; folder_count: number } | undefined;
    const pageRes = batchRes[3]?.results?.[0] as { total: number } | undefined;
    const dsRes = batchRes[4]?.results?.[0] as { count: number } | undefined;
    const routeRes = batchRes[5]?.results?.[0] as { count: number; dirty: number } | undefined;

    return {
        totalNodes: art?.total || 0,
        publishedCount: art?.pub || 0,
        draftCount: art?.draft || 0,
        mediaCount: mediaRes?.count || 0,
        microCount: microRes?.count || 0,
        microFolderCount: microRes?.folder_count || 0,
        pageCount: pageRes?.total || 0,
        dirtyRouteCount: routeRes?.dirty || 0,
        datasetGroupCount: dsRes?.count || 0,
        routeCount: routeRes?.count || 0
    };
}

export async function getDashboardCountsFromDb(
    db: D1Database,
    siteId: string
): Promise<DashboardCounts> {
    const batchRes = await db.batch(buildDashboardCountStatements(db, siteId));
    return extractDashboardCounts(batchRes);
}

export interface DashboardOverviewStats {
    totalNodes: number;
    publishedCount: number;
    draftCount: number;
    mediaCount: number;
    microCount: number;
    microFolderCount: number;
    pageCount: number;
    dirtyRouteCount: number;
    datasetGroupCount: number;
    routeCount: number;
    currentSiteName: string;
}

export interface DashboardFeedItemDto {
    id: string;
    itemType: 'article' | 'page' | 'micro' | 'automated_task' | 'audit_log';
    category: 'content' | 'system';
    title: string;
    slug?: string;
    nodeType?: string;
    status: string;
    versionNumber?: number;
    time: string;
    timeShort?: string;
    action?: string;
    isAutomated?: boolean;
}

const AUDIT_ACTION_SEVERITY_MAP: Record<string, 'critical' | 'warning'> = {
    LOGIN_FAILED: 'critical',
    AUTH_FAILED: 'critical',
    CF_ACCESS_DENIED: 'critical',
    HONEYPOT_BLOCKED: 'critical',
    WAF_BLOCKED: 'critical',
    API_SHIELD_BLOCKED: 'critical',
    R2_UPLOAD_FAILED: 'critical',
    D1_SNAPSHOT_EXPORT: 'critical',
    WORKER_BRIDGE_EVENT: 'critical',
    WEBHOOK_DISPATCH: 'warning'
};

function classifyAuditSeverity(action: string): 'critical' | 'warning' {
    const upper = String(action || '').toUpperCase();
    if (AUDIT_ACTION_SEVERITY_MAP[upper]) return AUDIT_ACTION_SEVERITY_MAP[upper];
    if (/(AUTH|LOGIN|PASSWORD|ACCESS|TOKEN|HONEYPOT|WAF|SHIELD|BLOCK|R2|STORAGE|BACKUP|SNAPSHOT|EXPORT|WORKER|EXTENSION|LICENSE)/.test(upper)) {
        return 'critical';
    }
    return 'warning';
}

export interface DashboardActionItem {
    id: string;
    tier: 'critical' | 'warning' | 'scheduled';
    icon: string;
    titleKey: string;
    titleParams?: Record<string, string | number>;
    rawTitle?: string;
    meta?: string;
    actionType?: 'rebuild_dirty_routes' | 'link';
    actionLabelKey?: string;
    actionHref?: string;
}

export async function getDashboardOverviewData(
    db: D1Database,
    siteId: string,
    siteName: string,
    locale = 'zh-CN',
    timezone = '+08:00',
    hasR2Bucket = true
): Promise<{
    stats: DashboardOverviewStats;
    recentFeed: DashboardFeedItemDto[];
    recentContent: DashboardFeedItemDto[];
    recentSystem: DashboardFeedItemDto[];
    actionAlerts: DashboardActionItem[];
}> {
    const batchRes = await db.batch([
        ...buildDashboardCountStatements(db, siteId),
        db.prepare(`
            SELECT a.id, a.slug, a.title, 'article' as type, a.status, a.updated_at,
                   COALESCE(MAX(v.version_number), 1) as version_number
            FROM articles a
            LEFT JOIN entity_versions v ON v.entity_type = 'article' AND v.entity_id = a.id
            WHERE a.site_id = ? AND a.deleted_at IS NULL
            GROUP BY a.id
            ORDER BY a.updated_at DESC
            LIMIT 10
        `).bind(siteId),
        db.prepare(`
            SELECT p.id, p.slug, p.title, 'page' as type, p.status, p.updated_at, 1 as version_number
            FROM pages p
            WHERE p.site_id = ? AND p.deleted_at IS NULL
              AND COALESCE(json_extract(p.metadata, '$.page_type'), '') != 'template'
            ORDER BY p.updated_at DESC
            LIMIT 10
        `).bind(siteId),
        db.prepare(`
            SELECT m.id, '' as slug, COALESCE(NULLIF(m.title, ''), substr(m.content_raw, 1, 160), m.id) as title,
                   'micro' as type, m.status, m.updated_at, 1 as version_number
            FROM micros m
            WHERE m.site_id = ? AND m.deleted_at IS NULL
            ORDER BY m.updated_at DESC
            LIMIT 10
        `).bind(siteId),
        db.prepare(`
            SELECT id, task_type, status, next_run_at, last_run_at
            FROM scheduled_tasks
            WHERE site_id = ? AND status != 'disabled'
            ORDER BY next_run_at ASC
            LIMIT 5
        `).bind(siteId),
        db.prepare(`
            SELECT id,
                   ('CRON_' || UPPER(task_type)) as action,
                   payload as details,
                   status,
                   last_run_at,
                   COALESCE(last_run_at, next_run_at, created_at) as created_at
            FROM scheduled_tasks
            WHERE (site_id = ? OR site_id IS NULL)
            ORDER BY COALESCE(last_run_at, created_at) DESC
            LIMIT 10
        `).bind(siteId),
        db.prepare(`
            SELECT COUNT(*) as count
            FROM articles
            WHERE site_id = ? AND deleted_at IS NULL AND (slug = 'guide' OR slug LIKE 'guide-%')
        `).bind(siteId)
    ]);

    const counts = extractDashboardCounts(batchRes);
    const artList = (batchRes[6]?.results || []) as any[];
    const pageList = (batchRes[7]?.results || []) as any[];
    const microList = (batchRes[8]?.results || []) as any[];
    const sysTasks = (batchRes[9]?.results || []) as any[];
    const allTaskLogs = (batchRes[10]?.results || []) as any[];
    const guideCount = ((batchRes[11]?.results?.[0] as { count: number } | undefined)?.count) || 0;

    const recentLogs = allTaskLogs
        .filter((r) => r.last_run_at != null)
        .sort((a, b) => (parseUtcDate(b.last_run_at)?.getTime() || 0) - (parseUtcDate(a.last_run_at)?.getTime() || 0))
        .slice(0, 6);
    const sysLogs = allTaskLogs.slice(0, 6);

    const mixedContent = [...artList, ...pageList, ...microList]
        .sort((a, b) => (parseUtcDate(b.updated_at)?.getTime() || 0) - (parseUtcDate(a.updated_at)?.getTime() || 0))
        .slice(0, 10);
    const sysData = { tasks: sysTasks, logs: sysLogs };

    const stats: DashboardOverviewStats = {
        ...counts,
        currentSiteName: siteName
    };

    const feedItems = [
        ...mixedContent.map((n) => {
            const ts = formatRelativeOrShortTime(n.updated_at || '', locale, timezone);
            return {
                id: n.id,
                itemType: (n.type || 'article') as 'article' | 'page' | 'micro',
                category: 'content' as const,
                title: n.title,
                slug: n.slug || '',
                nodeType: n.type,
                status: n.status,
                versionNumber: n.version_number || 1,
                time: ts.full,
                timeShort: ts.short,
                timestamp: parseUtcDate(n.updated_at || '')?.getTime() || 0
            };
        }),
        ...recentLogs
            .filter((l) => parseJson<Record<string, any>>(l.details, {}).emitActivity !== false)
            .map((l) => {
                const d = parseJson<Record<string, any>>(l.details, {});
                const ts = formatRelativeOrShortTime(l.created_at || '', locale, timezone);
                return {
                    id: l.id,
                    itemType: 'automated_task' as const,
                    category: 'system' as const,
                    title: d.message || l.action,
                    action: l.action,
                    status: l.status,
                    time: ts.full,
                    timeShort: ts.short,
                    isAutomated: true,
                    timestamp: parseUtcDate(l.created_at)?.getTime() || 0
                };
            })
    ].sort((a, b) => b.timestamp - a.timestamp);

    const recentContent: DashboardFeedItemDto[] = mixedContent.map(n => ({
        id: n.id,
        itemType: (n.type || 'article') as any,
        category: 'content' as const,
        title: n.title,
        slug: n.slug || '',
        nodeType: n.type,
        status: n.status,
        versionNumber: n.version_number || 1,
        time: formatSiteDateTime(n.updated_at || '', locale, timezone)
    }));

    const recentSystem: DashboardFeedItemDto[] = [
        ...sysData.tasks.map(t => ({
            id: t.id,
            itemType: 'automated_task' as const,
            category: 'system' as const,
            title: t.task_type,
            action: t.task_type,
            status: t.status,
            time: formatSiteDateTime(t.next_run_at || t.last_run_at || '', locale, timezone),
            isAutomated: true
        })),
        ...sysData.logs.map(l => {
            const d = parseJson<Record<string, any>>(l.details, {});
            return {
                id: l.id,
                itemType: 'audit_log' as const,
                category: 'system' as const,
                title: d.message || l.action,
                action: l.action,
                status: l.status,
                time: formatSiteDateTime(l.created_at, locale, timezone)
            };
        })
    ].slice(0, 9);

    const actionAlerts: DashboardActionItem[] = [];

    if (!hasR2Bucket) {
        actionAlerts.push({
            id: 'r2_not_ready',
            tier: 'critical',
            icon: 'cloud_off',
            titleKey: 'dashboard.alert_r2_unconfigured',
            actionType: 'link',
            actionLabelKey: 'dashboard.action_check_settings',
            actionHref: '/admin/settings'
        });
    }

    if (allTaskLogs.some((l) => l.status === 'failed')) {
        actionAlerts.push({
            id: 'failed_tasks',
            tier: 'critical',
            icon: 'error',
            titleKey: 'dashboard.alert_failed_tasks',
            actionType: 'link',
            actionLabelKey: 'dashboard.view_all',
            actionHref: '/admin/tasks'
        });
    }

    if (counts.dirtyRouteCount > 0) {
        actionAlerts.push({
            id: 'dirty_routes',
            tier: 'warning',
            icon: 'sync_problem',
            titleKey: 'dashboard.alert_dirty_routes',
            titleParams: { count: counts.dirtyRouteCount },
            actionType: 'rebuild_dirty_routes',
            actionLabelKey: 'dashboard.btn_rebuild_now'
        });
    }

    if (counts.draftCount > 0) {
        actionAlerts.push({
            id: 'pending_drafts',
            tier: 'warning',
            icon: 'edit_document',
            titleKey: 'dashboard.alert_pending_drafts',
            titleParams: { count: counts.draftCount },
            actionType: 'link',
            actionLabelKey: 'dashboard.action_review_drafts',
            actionHref: '/admin/articles?status=draft'
        });
    }

    if (guideCount > 0) {
        actionAlerts.push({
            id: 'guide_sample',
            tier: 'warning',
            icon: 'cleaning_services',
            titleKey: 'dashboard.alert_guide_sample',
            titleParams: { count: guideCount },
            actionType: 'link',
            actionLabelKey: 'dashboard.action_manage_articles',
            actionHref: '/admin/articles'
        });
    }

    const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const abnormalAuditLogs = await findRecentAbnormalAuditLogs(db, siteId, sevenDaysAgoIso, 5);
    for (const log of abnormalAuditLogs) {
        const severity = classifyAuditSeverity(log.action);
        const ts = formatRelativeOrShortTime(log.created_at, locale, timezone);
        const detailsObj = parseJson<Record<string, any>>(log.details, {});
        const detailText = detailsObj.error || detailsObj.message || log.status;
        actionAlerts.push({
            id: `audit_${log.id}`,
            tier: severity,
            icon: severity === 'critical' ? 'gpp_maybe' : 'warning',
            titleKey: 'dashboard.alert_audit_anomaly',
            titleParams: { action: log.action, status: String(detailText || log.status) },
            meta: ts.short,
            actionType: 'link',
            actionLabelKey: 'dashboard.view_all',
            actionHref: '/admin/audit?tab=logs'
        });
    }

    for (const task of sysTasks) {
        const ts = formatRelativeOrShortTime(task.next_run_at || task.last_run_at || '', locale, timezone);
        actionAlerts.push({
            id: task.id,
            tier: 'scheduled',
            icon: 'schedule',
            titleKey: `tasks.type_${task.task_type}`,
            rawTitle: task.task_type,
            meta: ts.short,
            actionType: 'link',
            actionLabelKey: 'dashboard.view_all',
            actionHref: '/admin/tasks'
        });
    }

    return {
        stats,
        recentFeed: feedItems.slice(0, 10).map(({ timestamp: _, ...item }) => item),
        recentContent,
        recentSystem,
        actionAlerts
    };
}

export async function findContentEditorDependencies(
    db: D1Database,
    siteId: string,
    nodeId: string,
    _slug: string,
    title: string,
    translationGroupId?: string | null
): Promise<{
    versions: NodeVersion[];
    siteNodes: Array<{ id: string; title: string; slug: string; type: string }>;
    backlinks: Array<{ id: string; title: string; slug: string; type: string; maturity: GardenMaturity }>;
    templatePages: Array<{ id: string; title: string; slug: string; metadata?: any }>;
    schemaNodes: Array<{ id: string; title: string; slug: string; summary?: string; metadata?: any }>;
    translationGroups: Array<{ id: string; name: string }>;
    peerTranslations: Array<{ id: string; title: string; slug: string; locale: string }>;
}> {
    const qVersStmt = (entityType: string) =>
        db.prepare(`SELECT id, version_number, title, summary, content_raw, metadata_snapshot, commit_message, created_at FROM entity_versions WHERE entity_type = ? AND entity_id = ? AND deleted_at IS NULL ORDER BY version_number DESC`).bind(entityType, nodeId);
    const qNodesStmt = (t: string, type: string) =>
        db.prepare(`SELECT id, title, slug, '${type}' as type FROM ${t} WHERE site_id = ? AND id != ? AND deleted_at IS NULL ORDER BY updated_at DESC`).bind(siteId, nodeId);

    const stmts: D1PreparedStatement[] = [
        db.prepare(`
            SELECT t.metadata, s.settings as site_settings FROM themes t
            LEFT JOIN sites s ON s.id = ?
            WHERE t.deleted_at IS NULL
            ORDER BY CASE WHEN t.id = s.theme_id OR t.slug = s.theme_id THEN 1 WHEN t.site_id = ? AND t.is_active = 1 THEN 2 WHEN t.is_active = 1 THEN 3 ELSE 4 END ASC, t.updated_at DESC
            LIMIT 1
        `).bind(siteId, siteId),
        db.prepare(`SELECT p.id, p.slug, p.title, p.metadata, pv.content_raw FROM pages p LEFT JOIN entity_versions pv ON p.current_version_id = pv.id AND pv.entity_type = 'page' WHERE p.site_id = ? AND p.deleted_at IS NULL ORDER BY p.title ASC`).bind(siteId),
        qVersStmt('article'),
        qVersStmt('micro'),
        qNodesStmt('articles', 'article'),
        qNodesStmt('micros', 'micro'),
        db.prepare(`
            SELECT tg_id as id, COALESCE(MAX(CASE WHEN LOWER(locale) = LOWER(s.default_locale) THEN title END), MAX(title), tg_id) as name
            FROM (
                SELECT site_id, COALESCE(NULLIF(translation_group_id, ''), json_extract(metadata, '$.translation_group_id')) as tg_id, locale, title
                FROM articles WHERE site_id = ? AND deleted_at IS NULL
                UNION ALL
                SELECT site_id, COALESCE(NULLIF(translation_group_id, ''), json_extract(metadata, '$.translation_group_id')) as tg_id, locale, title
                FROM pages WHERE site_id = ? AND deleted_at IS NULL
            ) g
            LEFT JOIN sites s ON s.id = g.site_id
            WHERE g.tg_id IS NOT NULL AND g.tg_id != ''
            GROUP BY g.tg_id
            ORDER BY name ASC
        `).bind(siteId, siteId)
    ];
    if (translationGroupId) {
        stmts.push(
            db.prepare(`SELECT id, title, slug, locale FROM articles WHERE site_id = ? AND translation_group_id = ? AND id != ? AND deleted_at IS NULL`).bind(siteId, translationGroupId, nodeId)
        );
    }

    const [batchRes, backlinksRes] = await Promise.all([
        db.batch(stmts),
        nodeId ? getNodeBacklinks(db, siteId, nodeId, title) : Promise.resolve([])
    ]);

    const themeRow = batchRes[0]?.results?.[0] as { metadata?: string; site_settings?: string } | undefined;
    const themeMeta = parseJson<Record<string, any>>(themeRow?.metadata, {});
    const siteSettings = parseJson<Record<string, any>>(themeRow?.site_settings, {});
    const themeSchemas = themeMeta.schemas || themeMeta.schemaNodes || [];
    const customSchemas = Array.isArray(siteSettings.custom_schemas)
        ? siteSettings.custom_schemas.map((s: any) => ({ ...s, is_custom: true }))
        : [];
    const seenSchemaSlugs = new Set<string>();
    const schemas = [...themeSchemas, ...customSchemas].filter((s: any) => {
        const k = String(s?.slug || s?.type || '').trim();
        if (!k || seenSchemaSlugs.has(k)) return false;
        seenSchemaSlugs.add(k);
        return true;
    });
    const rawPages = (batchRes[1]?.results || []) as any[];
    const artVers = (batchRes[2]?.results || []) as NodeVersion[];
    const microVers = (batchRes[3]?.results || []) as NodeVersion[];
    const articlesList = (batchRes[4]?.results || []) as any[];
    const microsList = (batchRes[5]?.results || []) as any[];
    const transGroupsRes = (batchRes[6]?.results || []) as Array<{ id: string; name: string }>;
    const peerTranslations = translationGroupId
        ? ((batchRes[7]?.results || []) as Array<{ id: string; title: string; slug: string; locale: string }>)
        : [];

    const themeComps = Array.isArray(themeMeta.components)
        ? themeMeta.components
        : (Array.isArray(themeMeta.componentNodes) ? themeMeta.componentNodes : []);
    const articleCapableComps = new Set<string>(['@slot:article_content', 'slot:article_content']);
    for (const comp of themeComps) {
        const cSlug = String(comp?.slug || comp?.type || '').trim();
        const tplHtml = String(comp?.template_html || comp?.templateHtml || '');
        if (!cSlug) continue;
        if (
            comp?.category === 'article' ||
            comp?.supports_article === true ||
            cSlug.includes('article-view') ||
            cSlug.includes('article-detail') ||
            tplHtml.includes('content_html')
        ) {
            articleCapableComps.add(cSlug);
        }
    }

    // Restrict article template choices to template pages whose blocks include an article-content-capable component.
    const templatePages = rawPages.filter((p: any) => {
        const meta = parseJson<Record<string, any>>(p.metadata, {});
        if (meta.page_type !== 'template') return false;
        const blocks = Array.isArray(meta.blocks) ? meta.blocks : parseJson<any[]>(p.content_raw, []);
        if (!Array.isArray(blocks) || blocks.length === 0) return false;
        return blocks.some((b: any) => {
            const compName = String(b?.component || b?.componentSlug || b?.componentType || b?.type || b?.id || '').trim();
            return articleCapableComps.has(compName);
        });
    }).map((p: any) => ({
        id: p.id,
        title: p.title || p.slug,
        slug: p.slug,
        metadata: p.metadata
    }));

    const schemaNodes = schemas.map((s: any) => ({
        id: s.id || `schema_${s.slug || s.type}`,
        title: s.name || s.title || s.slug,
        slug: s.slug || s.type,
        summary: s.description || s.summary || '',
        metadata: s
    }));

    const versions = artVers.length > 0 ? artVers : microVers;
    const siteNodes = [...articlesList, ...microsList];

    return {
        versions,
        siteNodes,
        backlinks: backlinksRes,
        templatePages,
        schemaNodes,
        translationGroups: transGroupsRes,
        peerTranslations
    };
}

export async function getContentEditorInitData(
    db: D1Database,
    siteId: string,
    node: Node
) {
    const deps = await findContentEditorDependencies(
        db,
        siteId,
        node.id,
        node.slug,
        node.title,
        node.translation_group_id
    );
    return {
        ...deps,
        latestVersion: deps.versions[0] || undefined
    };
}

export interface BrokenComponentPageItem {
    id: string;
    title: string;
    slug: string;
    page_type: 'single' | 'template';
    missing_components: string[];
}

export interface BrokenComponentsDiagnostic {
    broken_pages_count: number;
    broken_blocks_count: number;
    items: BrokenComponentPageItem[];
}

const VIRTUAL_COMPONENT_WHITELIST = new Set(['@slot:page_content', 'slot:page_content', '@ext:island', 'ext:island']);

/** Scans non-deleted single/template pages for blocks referencing components absent in the active theme. */
export async function findBrokenPageBlocksBySite(
    db: D1Database,
    siteId: string
): Promise<BrokenComponentsDiagnostic> {
    const [theme, pagesRes] = await Promise.all([
        findPublishedTheme(db, siteId),
        db.prepare(`
            SELECT p.id, p.title, p.slug, p.metadata, v.content_raw
            FROM pages p
            LEFT JOIN entity_versions v ON v.id = p.current_version_id AND v.entity_type = 'page'
            WHERE p.site_id = ? AND p.deleted_at IS NULL
            ORDER BY p.updated_at DESC
        `).bind(siteId).all<{ id: string; title: string; slug: string; metadata: string; content_raw?: string | null }>()
    ]);

    const validComponents = new Set<string>(VIRTUAL_COMPONENT_WHITELIST);
    const rawComps: any[] = theme?.metadata?.components || theme?.metadata?.componentNodes || [];
    for (const c of rawComps) {
        if (!c || typeof c !== 'object') continue;
        const cMeta = parseJson<Record<string, any>>(c.metadata, {});
        for (const candidate of [c.slug, c.type, cMeta.slug, cMeta.type]) {
            if (typeof candidate === 'string' && candidate.trim()) {
                validComponents.add(candidate.trim().toLowerCase());
            }
        }
    }

    const items: BrokenComponentPageItem[] = [];
    let brokenBlocksCount = 0;

    for (const row of pagesRes.results || []) {
        const meta = parseJson<Record<string, any>>(row.metadata, {});
        const pageType = String(meta.page_type || 'single').toLowerCase();
        if (pageType !== 'single' && pageType !== 'template') continue;

        let blocks: any[] = [];
        if (typeof row.content_raw === 'string' && row.content_raw.trim().startsWith('[')) {
            const parsedRaw = parseJson<any>(row.content_raw.trim(), null);
            if (Array.isArray(parsedRaw)) blocks = parsedRaw;
            else if (parsedRaw && Array.isArray(parsedRaw.blocks)) blocks = parsedRaw.blocks;
        }
        if (blocks.length === 0 && Array.isArray(meta.blocks)) {
            blocks = meta.blocks;
        }

        const missingSet = new Set<string>();
        for (const blk of blocks) {
            if (!blk || typeof blk !== 'object') continue;
            const compSlug = String(blk.component || blk.componentSlug || blk.componentType || blk.type || '').trim();
            if (!compSlug) continue;
            if (!validComponents.has(compSlug.toLowerCase())) {
                brokenBlocksCount++;
                missingSet.add(compSlug);
            }
        }

        if (missingSet.size > 0) {
            items.push({
                id: row.id,
                title: row.title || row.slug || row.id,
                slug: row.slug || '/',
                page_type: pageType as 'single' | 'template',
                missing_components: Array.from(missingSet)
            });
        }
    }

    items.sort((a, b) => (a.page_type === 'template' ? 0 : 1) - (b.page_type === 'template' ? 0 : 1));
    return {
        broken_pages_count: items.length,
        broken_blocks_count: brokenBlocksCount,
        items
    };
}

export async function getThemesManagementData(
    db: D1Database,
    siteId: string
): Promise<{
    allThemes: Node[];
    deletedThemes: Node[];
    templateNodes: Node[];
    componentNodes: Node[];
    schemaNodes: Node[];
}> {
    const mapTh = (r: any[] = []) => r.map((th: any) => ({ ...th, metadata: parseJson(th.metadata, {}) })) as Node[];
    const [themes, delThemes] = await db.batch([
        db.prepare(`
            SELECT t.id, t.site_id, t.slug, 'theme' as type, t.name as title, t.author, t.version, t.description as summary, t.metadata,
                   CASE WHEN s.theme_id IS NOT NULL THEN (CASE WHEN t.id = s.theme_id OR t.slug = s.theme_id THEN 1 ELSE 0 END) ELSE t.is_active END as is_active,
                   t.status, t.current_version_id, t.created_at, t.updated_at
            FROM themes t
            LEFT JOIN sites s ON s.id = ?
            WHERE t.deleted_at IS NULL
            ORDER BY is_active DESC, t.updated_at DESC
        `).bind(siteId),
        db.prepare(`SELECT id, site_id, slug, 'theme' as type, name as title, author, version, description as summary, metadata, is_active, status, current_version_id, created_at, updated_at, deleted_at FROM themes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`)
    ]);

    const allThemes = mapTh(themes.results);
    const deletedThemes = mapTh(delThemes.results);

    const activeTheme = allThemes.find((t: any) => t.is_active === 1) || allThemes[0];
    const activeMeta = (activeTheme?.metadata as any) || {};

    const templateNodes: Node[] = (activeMeta.templates || activeMeta.templateNodes || []).map((t: any) => toVirtualNode(t, 'template', siteId, 'slug'));
    const componentNodes: Node[] = (activeMeta.components || activeMeta.componentNodes || []).map((c: any) => toVirtualNode(c, 'component', siteId, 'slug'));
    const schemaNodes: Node[] = (activeMeta.schemas || activeMeta.schemaNodes || []).map((s: any) => toVirtualNode(s, 'schema', siteId, 'slug'));

    return {
        allThemes,
        deletedThemes,
        templateNodes,
        componentNodes,
        schemaNodes
    };
}
