import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { ENTITY_TABLE_CONFIGS } from './content-common';
import type { EntityVersionRow } from './versions.dal';

export type TrashCategory = 'article' | 'page' | 'micro' | 'dataset';

const CATEGORY_TABLE_MAP: Record<TrashCategory, string> = {
    article: 'articles',
    page: 'pages',
    micro: 'micros',
    dataset: 'datasets'
};

export function normalizeTrashCategory(raw?: string | boolean | null): TrashCategory {
    if (raw === true || raw === 'micro') return 'micro';
    if (raw === 'page') return 'page';
    if (raw === 'dataset') return 'dataset';
    return 'article';
}

export async function findTrashNodesAndVersions(
    db: D1Database,
    siteId: string
): Promise<Array<{
    node: { id: string; title: string; slug: string; type: string; deleted_at: string | null };
    versions: Array<{
        versionId: string;
        versionNumber: number;
        commitMessage?: string;
        contentRaw?: string;
        deletedAt?: string;
        createdAt: string;
    }>;
}>> {
    const [nodesRes, versRes] = await db.batch([
        // Subquery prevents SQLite "1st ORDER BY term does not match" on UNION ALL with qualified columns.
        db.prepare(`
            SELECT id, title, slug, type, deleted_at FROM (
                SELECT DISTINCT a.id, a.title, a.slug, 'article' as type, a.deleted_at as deleted_at FROM articles a LEFT JOIN entity_versions v ON v.entity_type = 'article' AND v.entity_id = a.id WHERE a.site_id = ? AND (a.deleted_at IS NOT NULL OR v.deleted_at IS NOT NULL)
                UNION ALL
                SELECT DISTINCT p.id, p.title, p.slug, 'page' as type, p.deleted_at as deleted_at FROM pages p LEFT JOIN entity_versions v ON v.entity_type = 'page' AND v.entity_id = p.id WHERE p.site_id = ? AND (p.deleted_at IS NOT NULL OR v.deleted_at IS NOT NULL)
                UNION ALL
                SELECT DISTINCT m.id, m.title, m.slug, 'micro' as type, m.deleted_at as deleted_at FROM micros m LEFT JOIN entity_versions v ON v.entity_type = 'micro' AND v.entity_id = m.id WHERE m.site_id = ? AND (m.deleted_at IS NOT NULL OR v.deleted_at IS NOT NULL)
                UNION ALL
                SELECT DISTINCT d.id, d.title, d.slug, 'dataset' as type, d.deleted_at as deleted_at FROM datasets d LEFT JOIN entity_versions v ON v.entity_type = 'dataset' AND v.entity_id = d.id WHERE d.site_id = ? AND (d.deleted_at IS NOT NULL OR v.deleted_at IS NOT NULL)
            )
            ORDER BY deleted_at DESC
        `).bind(siteId, siteId, siteId, siteId),
        db.prepare(`
            SELECT v.entity_id as node_id, v.id as versionId, v.version_number as versionNumber, v.commit_message as commitMessage, v.content_raw as contentRaw, v.deleted_at as deletedAt, v.created_at as createdAt
            FROM entity_versions v
            WHERE v.site_id = ? AND v.entity_type IN ('article', 'page', 'micro', 'dataset') AND v.deleted_at IS NOT NULL
        `).bind(siteId)
    ]);

    const versMap = new Map<string, any[]>();
    for (const v of (versRes.results || []) as any[]) {
        const l = versMap.get(v.node_id);
        if (l) l.push(v); else versMap.set(v.node_id, [v]);
    }

    return (nodesRes.results || []).map((node: any) => ({
        node,
        versions: versMap.get(node.id) || []
    }));
}

export async function getTrashListData(
    db: D1Database,
    siteId: string
) {
    const items = await findTrashNodesAndVersions(db, siteId);
    const groups: any[] = [];
    let articleCount = 0, pageCount = 0, microCount = 0, datasetCount = 0;
    for (const { node, versions } of items) {
        if (node.deleted_at || versions?.length) {
            if (node.type === 'micro') microCount++;
            else if (node.type === 'page') pageCount++;
            else if (node.type === 'dataset') datasetCount++;
            else articleCount++;
            groups.push({
                nodeId: node.id,
                title: node.title,
                slug: node.slug,
                type: node.type,
                isNodeDeleted: !!node.deleted_at,
                deletedAt: node.deleted_at || versions?.[0]?.deletedAt || new Date().toISOString(),
                versions: versions || []
            });
        }
    }
    return { groups, articleCount, pageCount, microCount, datasetCount };
}

export async function findDeletedEntityIdsForEmptyTrash(
    db: D1Database,
    siteId: string,
    category: TrashCategory | boolean
): Promise<string[]> {
    const cat = normalizeTrashCategory(category);
    const table = CATEGORY_TABLE_MAP[cat];
    const { results } = await db.prepare(
        `SELECT DISTINCT t.id FROM ${table} t LEFT JOIN entity_versions v ON v.entity_type = ? AND v.entity_id = t.id WHERE t.site_id = ? AND (t.deleted_at IS NOT NULL OR v.deleted_at IS NOT NULL)`
    ).bind(cat, siteId).all<{ id: string }>();
    return (results || []).map(r => r.id);
}

export async function findDeletedItemIdsForEmptyTrash(
    db: D1Database,
    siteId: string,
    category: TrashCategory
): Promise<{ fullyDeletedIds: string[]; softDeletedVersionOnlyIds: string[] }> {
    const table = CATEGORY_TABLE_MAP[category];
    const [nodesRes, verOnlyRes] = await db.batch([
        db.prepare(`SELECT id FROM ${table} WHERE site_id = ? AND deleted_at IS NOT NULL`).bind(siteId),
        db.prepare(`SELECT DISTINCT t.id FROM ${table} t INNER JOIN entity_versions v ON v.entity_type = ? AND v.entity_id = t.id WHERE t.site_id = ? AND t.deleted_at IS NULL AND v.deleted_at IS NOT NULL`).bind(category, siteId)
    ]);
    return {
        fullyDeletedIds: ((nodesRes.results || []) as Array<{ id: string }>).map(r => r.id),
        softDeletedVersionOnlyIds: ((verOnlyRes.results || []) as Array<{ id: string }>).map(r => r.id)
    };
}

export function buildSoftDeleteNodeStatements(
    db: D1Database,
    nodeId: string,
    entityType?: TrashCategory,
    siteId?: string
): D1PreparedStatement[] {
    const configs = entityType
        ? ENTITY_TABLE_CONFIGS.filter(c => c.type === entityType)
        : ENTITY_TABLE_CONFIGS;
    if (siteId) {
        return configs.flatMap(c => [
            db.prepare(`UPDATE ${c.table} SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?`).bind(nodeId, siteId),
            db.prepare(`UPDATE entity_versions SET deleted_at = CURRENT_TIMESTAMP WHERE entity_type = ? AND entity_id = ? AND site_id = ?`).bind(c.type, nodeId, siteId)
        ]);
    }
    return configs.flatMap(c => [
        db.prepare(`UPDATE ${c.table} SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(nodeId),
        db.prepare(`UPDATE entity_versions SET deleted_at = CURRENT_TIMESTAMP WHERE entity_type = ? AND entity_id = ?`).bind(c.type, nodeId)
    ]);
}

export function buildRestoreNodeStatements(
    db: D1Database,
    nodeId: string,
    activeVersions: { artVerId?: string | null; pageVerId?: string | null; microVerId?: string | null; datasetVerId?: string | null },
    entityType?: TrashCategory,
    siteId?: string
): D1PreparedStatement[] {
    const configs = entityType
        ? ENTITY_TABLE_CONFIGS.filter(c => c.type === entityType)
        : ENTITY_TABLE_CONFIGS;
    return configs.flatMap((c) => {
        const vId = c.type === 'article'
            ? activeVersions.artVerId
            : (c.type === 'page' ? activeVersions.pageVerId : (c.type === 'micro' ? activeVersions.microVerId : activeVersions.datasetVerId));
        const stmts: D1PreparedStatement[] = siteId
            ? [
                db.prepare(`UPDATE ${c.table} SET deleted_at = NULL, current_version_id = COALESCE(?, current_version_id), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?`).bind(vId || null, nodeId, siteId),
                db.prepare(`UPDATE entity_versions SET deleted_at = NULL WHERE entity_type = ? AND entity_id = ? AND site_id = ?`).bind(c.type, nodeId, siteId)
            ]
            : [
                db.prepare(`UPDATE ${c.table} SET deleted_at = NULL, current_version_id = COALESCE(?, current_version_id), updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(vId || null, nodeId),
                db.prepare(`UPDATE entity_versions SET deleted_at = NULL WHERE entity_type = ? AND entity_id = ?`).bind(c.type, nodeId)
            ];
        if (c.type === 'dataset') {
            stmts.push(
                siteId
                    ? db.prepare(`UPDATE dataset_collections SET deleted_at = NULL WHERE site_id = ? AND id = (SELECT collection_id FROM datasets WHERE id = ? AND site_id = ?)`).bind(siteId, nodeId, siteId)
                    : db.prepare(`UPDATE dataset_collections SET deleted_at = NULL WHERE id = (SELECT collection_id FROM datasets WHERE id = ?)`).bind(nodeId)
            );
        }
        return stmts;
    });
}

export function buildHardDeleteNodeStatements(
    db: D1Database,
    nodeId: string,
    entityType?: TrashCategory,
    siteId?: string
): D1PreparedStatement[] {
    const configs = entityType
        ? ENTITY_TABLE_CONFIGS.filter(c => c.type === entityType)
        : ENTITY_TABLE_CONFIGS;
    if (siteId) {
        return [
            ...configs.flatMap(c => [
                db.prepare(`DELETE FROM entity_versions WHERE entity_type = ? AND entity_id = ? AND site_id = ?`).bind(c.type, nodeId, siteId),
                db.prepare(`DELETE FROM ${c.table} WHERE id = ? AND site_id = ?`).bind(nodeId, siteId)
            ]),
            db.prepare(`DELETE FROM content_relations WHERE site_id = ? AND (source_id = ? OR target_id = ?)`).bind(siteId, nodeId, nodeId)
        ];
    }
    return [
        ...configs.flatMap(c => [
            db.prepare(`DELETE FROM entity_versions WHERE entity_type = ? AND entity_id = ?`).bind(c.type, nodeId),
            db.prepare(`DELETE FROM ${c.table} WHERE id = ?`).bind(nodeId)
        ]),
        db.prepare(`DELETE FROM content_relations WHERE source_id = ? OR target_id = ?`).bind(nodeId, nodeId)
    ];
}

export function buildCleanupOrphanedDeletedDatasetCollectionsStatement(db: D1Database, siteId: string): D1PreparedStatement {
    return db.prepare(`
        DELETE FROM dataset_collections
        WHERE site_id = ? AND deleted_at IS NOT NULL
          AND id NOT IN (SELECT collection_id FROM datasets WHERE site_id = ? AND collection_id != '')
    `).bind(siteId, siteId);
}

export function buildHardDeleteDeletedVersionsForEntityStatements(
    db: D1Database,
    entityType: TrashCategory,
    entityId: string,
    siteId: string
): D1PreparedStatement[] {
    return [
        db.prepare(`DELETE FROM entity_versions WHERE entity_type = ? AND entity_id = ? AND site_id = ? AND deleted_at IS NOT NULL`).bind(entityType, entityId, siteId)
    ];
}

export function buildSoftDeleteVersionStatements(db: D1Database, versionId: string, siteId?: string): D1PreparedStatement[] {
    if (siteId) {
        return [db.prepare(`UPDATE entity_versions SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?`).bind(versionId, siteId)];
    }
    return [db.prepare(`UPDATE entity_versions SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(versionId)];
}

export function buildRestoreVersionStatements(
    db: D1Database,
    versionId: string,
    nodeId?: string,
    siteId?: string,
    snapshot?: EntityVersionRow | null
): D1PreparedStatement[] {
    const stmts: D1PreparedStatement[] = [
        siteId
            ? db.prepare(`UPDATE entity_versions SET deleted_at = NULL WHERE id = ? AND site_id = ?`).bind(versionId, siteId)
            : db.prepare(`UPDATE entity_versions SET deleted_at = NULL WHERE id = ?`).bind(versionId)
    ];
    const targetNodeId = nodeId || snapshot?.entity_id;
    const targetType = snapshot?.entity_type;
    if (targetNodeId) {
        const configs = targetType && targetType !== 'theme'
            ? ENTITY_TABLE_CONFIGS.filter(c => c.type === targetType)
            : ENTITY_TABLE_CONFIGS;
        for (const c of configs) {
            const extraCols = c.type === 'micro'
                ? `, title = COALESCE(NULLIF(?, ''), title), content_raw = COALESCE(?, content_raw), metadata = COALESCE(?, metadata)`
                : `, title = COALESCE(NULLIF(?, ''), title), summary = COALESCE(?, summary), metadata = COALESCE(?, metadata)`;
            const extraBinds = snapshot
                ? (c.type === 'micro'
                    ? [snapshot.title || '', snapshot.content_raw ?? null, snapshot.metadata_snapshot ?? null]
                    : [snapshot.title || '', snapshot.summary ?? null, snapshot.metadata_snapshot ?? null])
                : null;
            if (extraBinds) {
                stmts.unshift(
                    siteId
                        ? db.prepare(`UPDATE ${c.table} SET deleted_at = NULL, current_version_id = ?${extraCols}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?`).bind(versionId, ...extraBinds, targetNodeId, siteId)
                        : db.prepare(`UPDATE ${c.table} SET deleted_at = NULL, current_version_id = ?${extraCols}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(versionId, ...extraBinds, targetNodeId)
                );
            } else {
                stmts.unshift(
                    siteId
                        ? db.prepare(`UPDATE ${c.table} SET deleted_at = NULL, current_version_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?`).bind(versionId, targetNodeId, siteId)
                        : db.prepare(`UPDATE ${c.table} SET deleted_at = NULL, current_version_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(versionId, targetNodeId)
                );
            }
            if (c.type === 'dataset') {
                stmts.push(
                    siteId
                        ? db.prepare(`UPDATE dataset_collections SET deleted_at = NULL WHERE site_id = ? AND id = (SELECT collection_id FROM datasets WHERE id = ? AND site_id = ?)`).bind(siteId, targetNodeId, siteId)
                        : db.prepare(`UPDATE dataset_collections SET deleted_at = NULL WHERE id = (SELECT collection_id FROM datasets WHERE id = ?)`).bind(targetNodeId)
                );
            }
        }
    }
    return stmts;
}

export function buildHardDeleteVersionStatements(db: D1Database, versionId: string, siteId?: string): D1PreparedStatement[] {
    if (siteId) {
        return [db.prepare(`DELETE FROM entity_versions WHERE id = ? AND site_id = ?`).bind(versionId, siteId)];
    }
    return [db.prepare(`DELETE FROM entity_versions WHERE id = ?`).bind(versionId)];
}
