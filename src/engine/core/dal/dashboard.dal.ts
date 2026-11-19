import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { formatSiteDateTime, parseUtcDate } from '../i18n';
import { findPublishedTheme } from './themes.dal';
import {
    Node,
    NodeVersion,
    GardenMaturity,
    parseJson,
    toVirtualNode
} from './content-common';
import { getNodeBacklinks, findTranslationGroups } from './relations.dal';

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
            SELECT COUNT(DISTINCT COALESCE(NULLIF(schema_slug, ''), NULLIF(json_extract(metadata, '$.schema_slug'), ''), id)) as count
            FROM datasets WHERE site_id = ? AND deleted_at IS NULL
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
    title: string;
    slug?: string;
    nodeType?: string;
    status: string;
    versionNumber?: number;
    time: string;
    action?: string;
    isAutomated?: boolean;
}

export async function getDashboardOverviewData(
    db: D1Database,
    siteId: string,
    siteName: string,
    locale = 'zh-CN',
    timezone = 'Asia/Shanghai'
): Promise<{
    stats: DashboardOverviewStats;
    recentFeed: DashboardFeedItemDto[];
    recentContent: DashboardFeedItemDto[];
    recentSystem: DashboardFeedItemDto[];
}> {
    const batchRes = await db.batch([
        ...buildDashboardCountStatements(db, siteId),
        db.prepare(`
            SELECT a.id, a.slug, a.title, 'article' as type, a.status, a.updated_at,
                   COALESCE(MAX(v.version_number), 1) as version_number
            FROM articles a
            LEFT JOIN article_versions v ON v.article_id = a.id
            WHERE a.site_id = ? AND a.deleted_at IS NULL
            GROUP BY a.id
            ORDER BY a.updated_at DESC
            LIMIT 10
        `).bind(siteId),
        db.prepare(`
            SELECT p.id, p.slug, p.title, 'page' as type, p.status, p.updated_at, 1 as version_number
            FROM pages p
            WHERE p.site_id = ? AND p.deleted_at IS NULL
            ORDER BY p.updated_at DESC
            LIMIT 10
        `).bind(siteId),
        db.prepare(`
            SELECT m.id, '' as slug, COALESCE(NULLIF(m.title, ''), substr(m.content_raw, 1, 40), m.id) as title,
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
            LIMIT 4
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
        `).bind(siteId)
    ]);

    const counts = extractDashboardCounts(batchRes);
    const artList = (batchRes[6]?.results || []) as any[];
    const pageList = (batchRes[7]?.results || []) as any[];
    const microList = (batchRes[8]?.results || []) as any[];
    const sysTasks = (batchRes[9]?.results || []) as any[];
    const allTaskLogs = (batchRes[10]?.results || []) as any[];
    const recentLogs = allTaskLogs
        .filter((r) => r.last_run_at != null)
        .sort((a, b) => (parseUtcDate(b.last_run_at)?.getTime() || 0) - (parseUtcDate(a.last_run_at)?.getTime() || 0))
        .slice(0, 5);
    const sysLogs = allTaskLogs.slice(0, 6);

    const recentNodes = artList.slice(0, 5);
    const mixedContent = [...artList, ...pageList, ...microList]
        .sort((a, b) => (parseUtcDate(b.updated_at)?.getTime() || 0) - (parseUtcDate(a.updated_at)?.getTime() || 0))
        .slice(0, 10);
    const sysData = { tasks: sysTasks, logs: sysLogs };

    const stats: DashboardOverviewStats = {
        ...counts,
        currentSiteName: siteName
    };

    const feedItems = [
        ...(recentNodes || []).map((n) => ({
            id: n.id,
            itemType: 'article' as const,
            title: n.title,
            slug: n.slug,
            nodeType: n.type,
            status: n.status,
            versionNumber: n.version_number,
            time: formatSiteDateTime(n.updated_at || '', locale, timezone),
            timestamp: parseUtcDate(n.updated_at || '')?.getTime() || 0
        })),
        ...(recentLogs || [])
            .filter((l) => parseJson<Record<string, any>>(l.details, {}).emitActivity !== false)
            .map((l) => {
                const d = parseJson<Record<string, any>>(l.details, {});
                return {
                    id: l.id,
                    itemType: 'automated_task' as const,
                    title: d.message || l.action,
                    action: l.action,
                    status: l.status,
                    time: formatSiteDateTime(l.created_at, locale, timezone),
                    isAutomated: true,
                    timestamp: parseUtcDate(l.created_at)?.getTime() || 0
                };
            })
    ].sort((a, b) => b.timestamp - a.timestamp);

    const recentContent: DashboardFeedItemDto[] = mixedContent.map(n => ({
        id: n.id,
        itemType: (n.type || 'article') as any,
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
                title: d.message || l.action,
                action: l.action,
                status: l.status,
                time: formatSiteDateTime(l.created_at, locale, timezone)
            };
        })
    ].slice(0, 9);

    return {
        stats,
        recentFeed: feedItems.slice(0, 7).map(({ timestamp: _, ...item }) => item),
        recentContent,
        recentSystem
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
    const qVersStmt = (t: string, fk: string) => {
        const sumCol = t === 'micro_versions' ? "'' as summary" : 'summary';
        return db.prepare(`SELECT id, version_number, title, ${sumCol}, content_raw, metadata_snapshot, commit_message, created_at FROM ${t} WHERE ${fk} = ? AND deleted_at IS NULL ORDER BY version_number DESC`).bind(nodeId);
    };
    const qNodesStmt = (t: string, type: string) =>
        db.prepare(`SELECT id, title, slug, '${type}' as type FROM ${t} WHERE site_id = ? AND id != ? AND deleted_at IS NULL ORDER BY updated_at DESC`).bind(siteId, nodeId);

    const stmts: D1PreparedStatement[] = [
        db.prepare(`
            SELECT t.metadata FROM themes t
            LEFT JOIN sites s ON s.id = ?
            WHERE t.deleted_at IS NULL AND (t.site_id = ? OR t.id = s.theme_id OR t.slug = s.theme_id OR t.site_id = 'site_default')
            ORDER BY CASE WHEN t.site_id = ? AND t.is_active = 1 THEN 1 WHEN t.id = s.theme_id OR t.slug = s.theme_id THEN 2 WHEN t.site_id = ? THEN 3 ELSE 4 END ASC, t.updated_at DESC
            LIMIT 1
        `).bind(siteId, siteId, siteId, siteId),
        db.prepare(`SELECT p.id, p.slug, p.title, p.metadata, pv.content_raw FROM pages p LEFT JOIN page_versions pv ON p.current_version_id = pv.id WHERE p.site_id = ? AND p.deleted_at IS NULL ORDER BY p.title ASC`).bind(siteId),
        qVersStmt('article_versions', 'article_id'),
        qVersStmt('micro_versions', 'micro_id'),
        qNodesStmt('articles', 'article'),
        qNodesStmt('micros', 'micro'),
        db.prepare(`SELECT id, name FROM translation_groups WHERE site_id = ? ORDER BY created_at DESC`).bind(siteId)
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

    const themeRow = batchRes[0]?.results?.[0] as { metadata?: string } | undefined;
    const themeMeta = parseJson<Record<string, any>>(themeRow?.metadata, {});
    const schemas = themeMeta.schemas || themeMeta.schemaNodes || [];
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
        db.prepare(`SELECT id, site_id, slug, 'theme' as type, name as title, author, version, description as summary, metadata, is_active, status, current_version_id, created_at, updated_at FROM themes WHERE site_id = ? AND deleted_at IS NULL ORDER BY is_active DESC, updated_at DESC`).bind(siteId),
        db.prepare(`SELECT id, site_id, slug, 'theme' as type, name as title, author, version, description as summary, metadata, is_active, status, current_version_id, created_at, updated_at, deleted_at FROM themes WHERE site_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`).bind(siteId)
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
