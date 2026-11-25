import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { buildLocalizedRoutePath } from '../i18n';
import { GardenMaturity, parseJson } from './content-common';
import { loadPublishedPageParentResolver } from './pages.dal';

export async function getNodeBacklinks(
    db: D1Database,
    siteId: string,
    targetSlugOrId: string,
    targetTitle?: string
): Promise<Array<{
    id: string;
    title: string;
    slug: string;
    type: string;
    maturity: GardenMaturity;
}>> {
    const nowIso = new Date().toISOString();
    const { results } = await db.prepare(`
        SELECT DISTINCT a.id, a.title, a.slug, 'article' as type, a.maturity
        FROM content_relations r
        JOIN articles a ON a.id = r.source_id
        WHERE r.site_id = ? AND (r.target_id = ? OR r.target_slug = ? OR r.target_slug = ?)
          AND a.status = 'published' AND (a.visibility = 'public' OR a.visibility IS NULL) AND (a.published_at IS NULL OR REPLACE(a.published_at, ' ', 'T') <= ?) AND a.deleted_at IS NULL
        UNION
        SELECT DISTINCT m.id, m.title, m.slug, 'micro' as type, m.progress as maturity
        FROM content_relations r
        JOIN micros m ON m.id = r.source_id
        WHERE r.site_id = ? AND (r.target_id = ? OR r.target_slug = ? OR r.target_slug = ?)
          AND m.status = 'published' AND (m.visibility = 'public' OR m.visibility IS NULL) AND (m.published_at IS NULL OR REPLACE(m.published_at, ' ', 'T') <= ?) AND m.deleted_at IS NULL
    `).bind(
        siteId, targetSlugOrId, targetSlugOrId, targetTitle || targetSlugOrId, nowIso,
        siteId, targetSlugOrId, targetSlugOrId, targetTitle || targetSlugOrId, nowIso
    ).all<any>();

    return results || [];
}

export async function findPeerTranslationNodes(
    db: D1Database,
    siteId: string,
    translationGroupId: string
): Promise<Array<{ id: string; slug: string; locale: string }>> {
    const nowIso = new Date().toISOString();
    const { results } = await db.prepare(
        `SELECT id, slug, locale, NULL as parent_id, metadata FROM articles
         WHERE site_id = ? AND (translation_group_id = ? OR json_extract(metadata, '$.translation_group_id') = ?)
           AND status = 'published' AND (visibility = 'public' OR visibility IS NULL) AND (published_at IS NULL OR REPLACE(published_at, ' ', 'T') <= ?) AND deleted_at IS NULL
         UNION ALL
         SELECT id, slug, locale, parent_id, metadata FROM pages
         WHERE site_id = ? AND (translation_group_id = ? OR json_extract(metadata, '$.translation_group_id') = ?)
           AND status = 'published' AND (visibility = 'public' OR visibility IS NULL) AND (published_at IS NULL OR REPLACE(published_at, ' ', 'T') <= ?) AND deleted_at IS NULL`
    ).bind(siteId, translationGroupId, translationGroupId, nowIso, siteId, translationGroupId, translationGroupId, nowIso).all<{ id: string; slug: string; locale: string; parent_id?: string | null; metadata?: string | null }>();
    const rows = results || [];
    const resolveParent = await loadPublishedPageParentResolver(db, siteId, rows.some(r => Boolean(r.parent_id)));
    const resolved: Array<{ id: string; slug: string; locale: string }> = [];
    for (const r of rows) {
        const meta = parseJson<Record<string, any>>(r.metadata, {});
        if (meta?.page_type === 'template' || meta?.page_type === 'redirect') continue;
        let fullSlug = r.slug;
        if (r.parent_id) {
            const parentPath = resolveParent(r.parent_id);
            if (parentPath) {
                const cleanSelf = String(r.slug || '').replace(/^\/+|\/+$/g, '');
                fullSlug = cleanSelf && cleanSelf !== 'index' ? `${parentPath}/${cleanSelf}` : parentPath;
            }
        }
        resolved.push({ id: r.id, slug: fullSlug, locale: r.locale });
    }
    return resolved;
}

export async function findNodeTranslationInfo(
    db: D1Database,
    nodeIdOrSlug: string
): Promise<{ id: string; translation_group_id: string | null; slug: string; locale: string } | null> {
    return await db.prepare(
        `SELECT id, COALESCE(NULLIF(translation_group_id, ''), json_extract(metadata, '$.translation_group_id')) as translation_group_id, slug, locale FROM articles WHERE (id = ? OR slug = ?)
         UNION ALL
         SELECT id, COALESCE(NULLIF(translation_group_id, ''), json_extract(metadata, '$.translation_group_id')) as translation_group_id, slug, locale FROM pages WHERE (id = ? OR slug = ?) LIMIT 1`
    ).bind(nodeIdOrSlug, nodeIdOrSlug, nodeIdOrSlug, nodeIdOrSlug).first<any>();
}

export async function getPeerTranslationLinks(
    db: D1Database,
    siteId: string,
    targetNodeIdOrSlug: string,
    _primaryDomain?: string,
    siteDefaultLocale: string = 'zh-CN'
): Promise<Array<{ slug: string; locale: string; url: string; isCurrent: boolean }>> {
    const node = await findNodeTranslationInfo(db, targetNodeIdOrSlug);
    if (!node || !node.translation_group_id) return [];

    const peers = await findPeerTranslationNodes(db, siteId, node.translation_group_id);
    return peers.map((p) => {
        const url = buildLocalizedRoutePath(p.slug, p.locale, siteDefaultLocale);
        return {
            slug: p.slug,
            locale: p.locale,
            url,
            isCurrent: p.id === node.id || (p.slug === node.slug && p.locale === node.locale)
        };
    });
}

export async function findTranslationGroups(
    db: D1Database,
    siteId: string
): Promise<Array<{ id: string; name: string }>> {
    const { results } = await db.prepare(`
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
    `).bind(siteId, siteId).all<{ id: string; name: string }>();
    return results || [];
}

export const getTranslationGroupsData = (db: D1Database, siteId: string) => findTranslationGroups(db, siteId);

export function buildDeleteTranslationGroupStatements(
    db: D1Database,
    groupId: string,
    siteId: string
): D1PreparedStatement[] {
    return [
        db.prepare(`UPDATE articles SET translation_group_id = NULL WHERE translation_group_id = ? AND site_id = ?`).bind(groupId, siteId),
        db.prepare(`UPDATE pages SET translation_group_id = NULL WHERE (translation_group_id = ? OR json_extract(metadata, '$.translation_group_id') = ?) AND site_id = ?`).bind(groupId, groupId, siteId)
    ];
}

export function buildJoinTranslationGroupStatement(
    db: D1Database,
    nodeId: string,
    groupId: string,
    siteId?: string
): D1PreparedStatement {
    return siteId
        ? db.prepare(`UPDATE articles SET translation_group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?`).bind(groupId, nodeId, siteId)
        : db.prepare(`UPDATE articles SET translation_group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(groupId, nodeId);
}

export function buildLeaveTranslationGroupStatement(
    db: D1Database,
    nodeId: string,
    siteId?: string
): D1PreparedStatement {
    return siteId
        ? db.prepare(`UPDATE articles SET translation_group_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?`).bind(nodeId, siteId)
        : db.prepare(`UPDATE articles SET translation_group_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(nodeId);
}

export function buildClearWikiRelationsStatement(db: D1Database, sourceId: string): D1PreparedStatement {
    return db.prepare(`DELETE FROM content_relations WHERE source_id = ? AND relation_type = 'wiki_link'`).bind(sourceId);
}

const findWikiTarget = (
    db: D1Database,
    table: string,
    siteId: string,
    targetSlug: string,
    cleanSlug: string,
    preferredLocale?: string
) => {
    const whereClause = `WHERE site_id = ? AND (slug = ? OR title = ? OR slug = ?) AND status = 'published' AND (visibility = 'public' OR visibility IS NULL) AND deleted_at IS NULL`;
    if (preferredLocale) {
        return db.prepare(`SELECT id FROM ${table} ${whereClause} ORDER BY CASE WHEN LOWER(locale) = LOWER(?) THEN 0 ELSE 1 END ASC LIMIT 1`)
            .bind(siteId, targetSlug, targetSlug, cleanSlug, preferredLocale).first<{ id: string }>().then(r => r?.id ?? null);
    }
    return db.prepare(`SELECT id FROM ${table} ${whereClause} LIMIT 1`)
        .bind(siteId, targetSlug, targetSlug, cleanSlug).first<{ id: string }>().then(r => r?.id ?? null);
};

export const findWikiTargetArticleId = (
    db: D1Database,
    siteId: string,
    targetSlug: string,
    cleanSlug: string,
    preferredLocale?: string
) => findWikiTarget(db, 'articles', siteId, targetSlug, cleanSlug, preferredLocale);

export const findWikiTargetMicroId = (
    db: D1Database,
    siteId: string,
    targetSlug: string,
    cleanSlug: string,
    preferredLocale?: string
) => findWikiTarget(db, 'micros', siteId, targetSlug, cleanSlug, preferredLocale);

export async function resolveWikiLinkTargetsMap(
    db: D1Database,
    siteId: string,
    rawTargets: string[],
    currentLocale: string,
    defaultLocale: string
): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const targets = Array.from(new Set(rawTargets.map(t => String(t || '').trim()).filter(Boolean)));
    if (targets.length === 0) return out;

    const nowIso = new Date().toISOString();
    const { results } = await db.prepare(`
        SELECT slug, title, locale
        FROM articles
        WHERE site_id = ? AND status = 'published' AND (visibility = 'public' OR visibility IS NULL) AND (published_at IS NULL OR REPLACE(published_at, ' ', 'T') <= ?) AND deleted_at IS NULL
        ORDER BY CASE WHEN LOWER(locale) = LOWER(?) THEN 0 ELSE 1 END ASC
    `).bind(siteId, nowIso, currentLocale || defaultLocale).all<{ slug: string; title: string; locale: string }>();

    const rows = results || [];
    for (const rawTarget of targets) {
        const cleanCand = rawTarget.replace(/^\/+/, '');
        const lowerCand = cleanCand.toLowerCase();
        const hit = rows.find((r) => {
            const s = String(r.slug || '').replace(/^\/+/, '').toLowerCase();
            const t = String(r.title || '').trim().toLowerCase();
            return s === lowerCand || t === rawTarget.toLowerCase();
        });
        if (hit) {
            out[rawTarget] = buildLocalizedRoutePath(hit.slug, hit.locale || currentLocale || defaultLocale, defaultLocale);
        } else {
            out[rawTarget] = buildLocalizedRoutePath(cleanCand, currentLocale || defaultLocale, defaultLocale);
        }
    }
    return out;
}

export async function findInboundRelationSourcePaths(
    db: D1Database,
    siteId: string,
    entityId: string,
    slugCandidates: string[],
    defaultLocale: string
): Promise<string[]> {
    const cleanCands = Array.from(new Set(slugCandidates.map(s => String(s || '').trim()).filter(Boolean)));
    const ph = cleanCands.length > 0 ? cleanCands.map(() => '?').join(', ') : `'__none__'`;
    const { results } = await db.prepare(`
        SELECT DISTINCT a.slug, a.locale, 'article' as type, NULL as parent_id
        FROM content_relations r
        JOIN articles a ON a.id = r.source_id
        WHERE r.site_id = ? AND (r.target_id = ? OR r.target_slug IN (${ph})) AND a.deleted_at IS NULL
        UNION
        SELECT DISTINCT p.slug, p.locale, 'page' as type, p.parent_id
        FROM content_relations r
        JOIN pages p ON p.id = r.source_id
        WHERE r.site_id = ? AND (r.target_id = ? OR r.target_slug IN (${ph})) AND p.deleted_at IS NULL
    `).bind(
        siteId, entityId, ...(cleanCands.length > 0 ? cleanCands : []),
        siteId, entityId, ...(cleanCands.length > 0 ? cleanCands : [])
    ).all<{ slug: string; locale: string; type: string; parent_id?: string | null }>();

    const rows = results || [];
    const resolveParent = await loadPublishedPageParentResolver(
        db,
        siteId,
        rows.some(r => r.type === 'page' && Boolean(r.parent_id))
    );
    const paths: string[] = [];
    for (const r of rows) {
        let fullSlug = String(r.slug || '').replace(/^\/+|\/+$/g, '');
        if (r.type === 'page' && r.parent_id) {
            const parentPath = resolveParent(r.parent_id);
            if (parentPath) fullSlug = fullSlug && fullSlug !== 'index' ? `${parentPath}/${fullSlug}` : parentPath;
        }
        paths.push(buildLocalizedRoutePath(fullSlug || '/', r.locale || defaultLocale, defaultLocale));
    }
    return Array.from(new Set(paths));
}

export function buildInsertContentRelationStatement(
    db: D1Database,
    params: {
        id: string;
        siteId: string;
        sourceId: string;
        sourceType: string;
        targetId: string | null;
        targetType: string;
        targetSlug: string;
        relationType?: string;
        createdAt: string;
    }
): D1PreparedStatement {
    return db.prepare(
        `INSERT INTO content_relations (id, site_id, source_id, source_type, target_id, target_type, target_slug, relation_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
        params.id,
        params.siteId,
        params.sourceId,
        params.sourceType,
        params.targetId,
        params.targetType,
        params.targetSlug,
        params.relationType || 'wiki_link',
        params.createdAt
    );
}

export interface ImpactGraphNode {
    id: string;
    slug: string;
    title: string;
    type: 'route' | 'page' | 'article' | 'note' | 'micro' | 'dataset' | 'topic' | string;
    layer: 'route' | 'content' | 'data' | 'concept' | string;
    level: number;
    path?: string;
    status?: string;
    maturity?: string | null;
    summary?: string | null;
    heat?: number;
    is_dirty?: boolean;
    translation_group_id?: string | null;
    entity_type?: string | null;
    entity_id?: string | null;
    created_at?: string | null;
}

export interface ImpactGraphRelation {
    source_id: string;
    source_title: string;
    source_slug: string;
    source_type: string;
    target_id?: string | null;
    target_slug: string;
    target_title?: string | null;
    target_type?: string | null;
    relation_type: 'route_binds' | 'wiki_link' | 'dataset_ref' | 'parent_child' | 'translation' | 'data_source' | string;
}

export async function findSiteImpactAnalysisGraph(
    db: D1Database,
    siteId: string
): Promise<{ nodes: ImpactGraphNode[]; relations: ImpactGraphRelation[] }> {
    const [routesBatch, entityBatch, relBatch] = await db.batch([
        db.prepare(`SELECT id, path, entity_type, entity_id, title, status_code, is_dirty, created_at FROM site_routes WHERE site_id = ? AND entity_type != 'sitemap' ORDER BY priority DESC, path ASC`).bind(siteId),
        db.prepare(`SELECT id, slug, title, 'page' as type, 'page' as layer, 1 as level, parent_id, status, metadata, NULL as maturity, COALESCE(NULLIF(translation_group_id, ''), json_extract(metadata, '$.translation_group_id')) as translation_group_id, NULL as schema_slug, created_at FROM pages WHERE site_id = ? AND deleted_at IS NULL UNION ALL SELECT id, slug, title, 'article', 'article', 1, NULL, status, metadata, maturity, translation_group_id, NULL as schema_slug, created_at FROM articles WHERE site_id = ? AND deleted_at IS NULL UNION ALL SELECT id, slug, title, 'micro', 'micro', 2, NULL, status, metadata, progress as maturity, NULL as translation_group_id, NULL as schema_slug, created_at FROM micros WHERE site_id = ? AND deleted_at IS NULL UNION ALL SELECT id, slug, title, 'dataset', 'dataset', 2, NULL, status, metadata, NULL, NULL as translation_group_id, schema_slug, created_at FROM datasets WHERE site_id = ? AND deleted_at IS NULL`).bind(siteId, siteId, siteId, siteId),
        db.prepare(`SELECT source_id, source_type, target_id, target_type, target_slug, relation_type FROM content_relations WHERE site_id = ? ORDER BY created_at DESC`).bind(siteId)
    ]);
    const routesRes = { results: (routesBatch.results || []) as any[] };
    const entityRes = { results: (entityBatch.results || []) as any[] };
    const relRes = { results: (relBatch.results || []) as any[] };

    const nodes: ImpactGraphNode[] = [], relations: ImpactGraphRelation[] = [], nodeMap = new Map<string, ImpactGraphNode>();
    const indexNode = (n: ImpactGraphNode) => {
        nodes.push(n);
        nodeMap.set(n.id, n);
        if (n.slug) { nodeMap.set(n.slug, n); nodeMap.set(n.slug.toLowerCase(), n); }
    };
    const addRel = (srcId: string, srcTitle: string, srcSlug: string, srcType: string, tgt: { id: string; title: string; slug: string; type: string }, relType: string) => {
        relations.push({ source_id: srcId, source_title: srcTitle, source_slug: srcSlug, source_type: srcType, target_id: tgt.id, target_title: tgt.title, target_slug: tgt.slug, target_type: tgt.type, relation_type: relType });
    };

    for (const r of routesRes.results || []) {
        const routeId = r.id || `route_${r.path === '/' ? 'root' : r.path.replace(/^\/+/, '').replace(/[\/\-]/g, '_')}`;
        indexNode({
            id: routeId,
            slug: r.path,
            title: r.title || r.path,
            type: 'route',
            layer: 'route',
            level: 0,
            path: r.path,
            status: String(r.status_code || 200),
            is_dirty: r.is_dirty === 1,
            heat: 0,
            entity_type: r.entity_type || null,
            entity_id: r.entity_id || null,
            created_at: r.created_at || null
        });
    }
    const datasetHubs = new Map<string, { schemaSlug: string; count: number }>();
    const microHubs = new Map<string, { folder: string; count: number; firstId: string }>();
    let totalMicroCount = 0;

    for (const item of entityRes.results || []) {
        const type = item.type;
        let parsedMeta: any = {};
        if (item.metadata && typeof item.metadata === 'string') {
            try { parsedMeta = JSON.parse(item.metadata) || {}; } catch {}
        }
        if (type === 'dataset') {
            const schemaSlug = String(item.schema_slug || parsedMeta.schema_slug || parsedMeta.schema || item.slug || 'default').trim();
            const cur = datasetHubs.get(schemaSlug) || { schemaSlug, count: 0 };
            cur.count++;
            datasetHubs.set(schemaSlug, cur);
            continue;
        }
        if (type === 'micro') {
            totalMicroCount++;
            const folder = String(parsedMeta.folder || 'default').trim() || 'default';
            const cur = microHubs.get(folder) || { folder, count: 0, firstId: item.id };
            cur.count++;
            microHubs.set(folder, cur);
            continue;
        }
        const heatVal = Number(parsedMeta.heat || parsedMeta.views || parsedMeta.visits || 0);
        const isDirty = item.status === 'draft' || item.status === 'dirty' || item.status === 'pending';
        indexNode({
            id: item.id,
            slug: item.slug,
            title: item.title || item.slug,
            type,
            layer: item.layer,
            level: item.level,
            path: item.type === 'article' ? `/${item.slug}` : item.slug,
            status: item.status || 'published',
            maturity: item.maturity,
            summary: item.metadata,
            heat: heatVal,
            is_dirty: isDirty,
            translation_group_id: item.translation_group_id || null,
            created_at: item.created_at || null
        });
    }

    for (const { schemaSlug, count } of datasetHubs.values()) {
        indexNode({
            id: `hub_dataset_${schemaSlug}`,
            slug: schemaSlug,
            title: `📦 ${schemaSlug} (${count})`,
            type: 'dataset',
            layer: 'dataset',
            level: 2,
            path: `/admin/datasets/collection/${encodeURIComponent(schemaSlug)}`,
            status: 'published',
            heat: count
        });
    }
    for (const { folder, count, firstId } of microHubs.values()) {
        indexNode({
            id: `hub_micro_${folder}`,
            slug: folder,
            title: `🗂️ ${folder} (${count})`,
            type: 'micro',
            layer: 'micro',
            level: 2,
            path: count === 1 ? `/admin/micros/edit/${encodeURIComponent(firstId)}` : `/admin/micros?folder=${encodeURIComponent(folder)}`,
            status: 'published',
            heat: count,
            entity_type: count === 1 ? 'micro' : null,
            entity_id: count === 1 ? firstId : null
        });
    }
    for (const r of routesRes.results || []) {
        const routeId = r.id || `route_${r.path === '/' ? 'root' : r.path.replace(/^\/+/, '').replace(/[\/\-]/g, '_')}`;
        let target = r.entity_id ? nodeMap.get(r.entity_id) : undefined;
        if (!target) {
            if (r.path === '/' || r.path === '') {
                target = nodeMap.get('/') || nodeMap.get('home') || nodeMap.get('index') || nodeMap.get('page_home');
            } else {
                const clean = r.path.replace(/^\/+/, '');
                target = nodeMap.get(clean) || nodeMap.get(r.path);
            }
        }
        if (target) {
            const routeNode = nodeMap.get(routeId);
            if (routeNode && !routeNode.entity_id) {
                routeNode.entity_id = target.id;
                routeNode.entity_type = target.type;
            }
            addRel(routeId, r.path, r.path, 'route', target, 'route_binds');
        }
    }
    for (const item of entityRes.results || []) {
        if (item.parent_id) {
            const p = nodeMap.get(item.parent_id);
            if (p) addRel(p.id, p.title, p.slug, 'page', item, 'parent_child');
        }
    }
    for (const r of relRes.results || []) {
        const s = nodeMap.get(r.source_id);
        let t = (r.target_id ? nodeMap.get(r.target_id) : undefined) || (r.target_slug ? (nodeMap.get(r.target_slug) || nodeMap.get(r.target_slug.toLowerCase())) : undefined);
        if (!t && r.target_slug) {
            t = { id: `concept_${r.target_slug}`, slug: r.target_slug, title: r.target_slug, type: 'topic', layer: 'concept', level: 3 };
            indexNode(t);
        }
        if (t) addRel(r.source_id, s?.title || r.source_id, s?.slug || r.source_id, r.source_type, t, r.relation_type || 'wiki_link');
    }

    const tgMap = new Map<string, ImpactGraphNode[]>();
    for (const it of entityRes.results || []) {
        const n = it.translation_group_id && nodeMap.get(it.id);
        if (n) tgMap.set(it.translation_group_id, [...(tgMap.get(it.translation_group_id) || []), n]);
    }
    for (const g of tgMap.values()) {
        for (let i = 0; i < g.length; i++)
            for (let j = i + 1; j < g.length; j++)
                addRel(g[i].id, g[i].title, g[i].slug, g[i].type, g[j], 'translation');
    }

    for (const it of entityRes.results || []) {
        if (it.type !== 'page' || !it.metadata) continue;
        const mStr = typeof it.metadata === 'string' ? it.metadata : JSON.stringify(it.metadata);
        const linkedHubs = new Set<string>();
        for (const m of mStr.match(/@api:(?:dataset|datasets):([^\s"'\\]+)/g) || []) {
            const raw = m.replace(/^@api:(?:dataset|datasets):/, '').split('?')[0];
            const sch = raw.match(/schema=([a-zA-Z0-9_-]+)/)?.[1] || raw.match(/id=([a-zA-Z0-9_-]+)/)?.[1] || raw;
            const hub = nodeMap.get(`hub_dataset_${sch}`) || nodeMap.get(sch);
            if (hub && !linkedHubs.has(hub.id)) {
                linkedHubs.add(hub.id);
                addRel(it.id, it.title, it.slug, 'page', hub, 'data_source');
            }
        }
        for (const m of mStr.match(/@api:micros?:([^\s"'\\]*)/g) || []) {
            const rawFolder = m.match(/folder=([^&\s"'\\]+)/)?.[1];
            const folderMatch = rawFolder ? decodeURIComponent(rawFolder) : '';
            if (folderMatch) {
                const hub = nodeMap.get(`hub_micro_${folderMatch}`);
                if (hub && !linkedHubs.has(hub.id)) {
                    linkedHubs.add(hub.id);
                    addRel(it.id, it.title, it.slug, 'page', hub, 'data_source');
                }
            } else if (totalMicroCount > 0) {
                let allHub = nodeMap.get('hub_micro_all');
                if (!allHub) {
                    allHub = {
                        id: 'hub_micro_all',
                        slug: 'all',
                        title: `🗂️ * (${totalMicroCount})`,
                        type: 'micro',
                        layer: 'micro',
                        level: 2,
                        path: '/admin/micros',
                        status: 'published',
                        heat: totalMicroCount
                    };
                    indexNode(allHub);
                }
                if (!linkedHubs.has(allHub.id)) {
                    linkedHubs.add(allHub.id);
                    addRel(it.id, it.title, it.slug, 'page', allHub, 'data_source');
                }
            }
        }
    }

    return { nodes, relations };
}
