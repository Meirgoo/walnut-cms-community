import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { ENTITY_TABLE_CONFIGS } from './content-common';

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
        db.prepare(`
            SELECT DISTINCT a.id, a.title, a.slug, 'article' as type, a.deleted_at FROM articles a LEFT JOIN article_versions v ON v.article_id = a.id WHERE a.site_id = ? AND (a.deleted_at IS NOT NULL OR v.deleted_at IS NOT NULL)
            UNION ALL
            SELECT DISTINCT m.id, m.title, m.slug, 'micro', m.deleted_at FROM micros m LEFT JOIN micro_versions v ON v.micro_id = m.id WHERE m.site_id = ? AND (m.deleted_at IS NOT NULL OR v.deleted_at IS NOT NULL)
            UNION ALL
            SELECT DISTINCT p.id, p.title, p.slug, 'page', p.deleted_at FROM pages p LEFT JOIN page_versions v ON v.page_id = p.id WHERE p.site_id = ? AND (p.deleted_at IS NOT NULL OR v.deleted_at IS NOT NULL)
            ORDER BY deleted_at DESC
        `).bind(siteId, siteId, siteId),
        db.prepare(`
            SELECT v.article_id as node_id, v.id as versionId, v.version_number as versionNumber, v.commit_message as commitMessage, v.content_raw as contentRaw, v.deleted_at as deletedAt, v.created_at as createdAt
            FROM article_versions v INNER JOIN articles a ON a.id = v.article_id WHERE a.site_id = ? AND v.deleted_at IS NOT NULL
            UNION ALL
            SELECT v.micro_id, v.id, v.version_number, v.commit_message, v.content_raw, v.deleted_at, v.created_at
            FROM micro_versions v INNER JOIN micros m ON m.id = v.micro_id WHERE m.site_id = ? AND v.deleted_at IS NOT NULL
            UNION ALL
            SELECT v.page_id, v.id, v.version_number, v.commit_message, v.content_raw, v.deleted_at, v.created_at
            FROM page_versions v INNER JOIN pages p ON p.id = v.page_id WHERE p.site_id = ? AND v.deleted_at IS NOT NULL
        `).bind(siteId, siteId, siteId)
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
    let articleCount = 0, microCount = 0;
    for (const { node, versions } of items) {
        (node.type === 'micro' ? microCount++ : articleCount++);
        if (node.deleted_at || versions?.length) {
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
    return { groups, articleCount, microCount };
}

export async function findDeletedEntityIdsForEmptyTrash(
    db: D1Database,
    siteId: string,
    isMicro: boolean
): Promise<string[]> {
    if (isMicro) {
        const { results } = await db.prepare(
            `SELECT id FROM micros WHERE site_id = ? AND deleted_at IS NOT NULL`
        ).bind(siteId).all<{ id: string }>();
        return (results || []).map(r => r.id);
    }
    const [artRes, pageRes] = await Promise.all([
        db.prepare(`SELECT id FROM articles WHERE site_id = ? AND deleted_at IS NOT NULL`).bind(siteId).all<{ id: string }>(),
        db.prepare(`SELECT id FROM pages WHERE site_id = ? AND deleted_at IS NOT NULL`).bind(siteId).all<{ id: string }>()
    ]);
    return [...(artRes.results || []).map(r => r.id), ...(pageRes.results || []).map(r => r.id)];
}

export function buildSoftDeleteNodeStatements(
    db: D1Database,
    nodeId: string,
    entityType?: 'article' | 'page' | 'micro'
): D1PreparedStatement[] {
    const configs = entityType
        ? ENTITY_TABLE_CONFIGS.filter(c => c.type === entityType)
        : ENTITY_TABLE_CONFIGS;
    return configs.flatMap(c => [
        db.prepare(`UPDATE ${c.table} SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(nodeId),
        db.prepare(`UPDATE ${c.verTable} SET deleted_at = CURRENT_TIMESTAMP WHERE ${c.fk} = ?`).bind(nodeId)
    ]);
}

export function buildRestoreNodeStatements(
    db: D1Database,
    nodeId: string,
    activeVersions: { artVerId?: string | null; pageVerId?: string | null; microVerId?: string | null },
    entityType?: 'article' | 'page' | 'micro'
): D1PreparedStatement[] {
    const configs = entityType
        ? ENTITY_TABLE_CONFIGS.filter(c => c.type === entityType)
        : ENTITY_TABLE_CONFIGS;
    return configs.flatMap((c) => {
        const vId = c.type === 'article' ? activeVersions.artVerId : (c.type === 'page' ? activeVersions.pageVerId : activeVersions.microVerId);
        return [
            db.prepare(`UPDATE ${c.table} SET deleted_at = NULL, current_version_id = COALESCE(?, current_version_id), updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(vId || null, nodeId),
            db.prepare(`UPDATE ${c.verTable} SET deleted_at = NULL WHERE ${c.fk} = ?`).bind(nodeId)
        ];
    });
}

export function buildHardDeleteNodeStatements(
    db: D1Database,
    nodeId: string,
    entityType?: 'article' | 'page' | 'micro'
): D1PreparedStatement[] {
    const configs = entityType
        ? ENTITY_TABLE_CONFIGS.filter(c => c.type === entityType)
        : ENTITY_TABLE_CONFIGS;
    return [
        ...configs.flatMap(c => [
            db.prepare(`DELETE FROM ${c.verTable} WHERE ${c.fk} = ?`).bind(nodeId),
            db.prepare(`DELETE FROM ${c.table} WHERE id = ?`).bind(nodeId)
        ]),
        db.prepare(`DELETE FROM content_relations WHERE source_id = ? OR target_id = ?`).bind(nodeId, nodeId)
    ];
}

export function buildSoftDeleteVersionStatements(db: D1Database, versionId: string): D1PreparedStatement[] {
    return ENTITY_TABLE_CONFIGS.map(c =>
        db.prepare(`UPDATE ${c.verTable} SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(versionId)
    );
}

export function buildRestoreVersionStatements(db: D1Database, versionId: string, nodeId?: string): D1PreparedStatement[] {
    const stmts = ENTITY_TABLE_CONFIGS.map(c =>
        db.prepare(`UPDATE ${c.verTable} SET deleted_at = NULL WHERE id = ?`).bind(versionId)
    );
    if (nodeId) {
        stmts.unshift(
            ...ENTITY_TABLE_CONFIGS.map(c =>
                db.prepare(`UPDATE ${c.table} SET deleted_at = NULL, current_version_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(versionId, nodeId)
            )
        );
    }
    return stmts;
}

export function buildHardDeleteVersionStatements(db: D1Database, versionId: string): D1PreparedStatement[] {
    return ENTITY_TABLE_CONFIGS.map(c =>
        db.prepare(`DELETE FROM ${c.verTable} WHERE id = ?`).bind(versionId)
    );
}
