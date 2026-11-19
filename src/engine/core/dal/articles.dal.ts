import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import {
    Node,
    mapContentEntityRow,
    findEntityForVcs,
    findLatestEntityVersion,
    updStmt,
    bindInsertVersion,
    insEntity
} from './content-common';
import { findContentEditorDependencies } from './dashboard.dal';
import {
    buildUpsertSiteRouteStatement,
    buildDeleteEntitySiteRoutesStatement,
    buildDeleteOtherSiteRoutesStatement,
    assertSiteRouteUnique,
    inspectSpecialRoute,
    markRoutesDirtyByDependency,
    purgeEdgeAndZoneCache
} from './cache-index.dal';
import { invalidateSiteMemoryCache } from './sites.dal';

export const findArticleForVcs = (db: D1Database, articleId: string) =>
    findEntityForVcs(db, 'articles', articleId);

export const findLatestArticleVersion = (db: D1Database, articleId: string) =>
    findLatestEntityVersion(db, 'article_versions', 'article_id', articleId);

export function buildUpdateArticleMetadataOnlyStatement(db: D1Database, params: any): D1PreparedStatement {
    return updStmt(
        db,
        'articles',
        'title = ?, slug = ?, locale = ?, translation_group_id = ?, maturity = ?, status = ?, summary = ?, metadata = ?, published_at = CASE WHEN ? = \'published\' AND published_at IS NULL THEN CURRENT_TIMESTAMP ELSE published_at END',
        [params.title, params.slug, params.locale, params.translationGroupId, params.maturity, params.status, params.summary, params.metadataStr, params.status],
        params.articleId
    );
}

export function buildInsertArticleVersionStatement(db: D1Database, params: any): D1PreparedStatement {
    return bindInsertVersion(db, 'article_versions', 'article_id', params);
}

export function buildUpdateArticleWithVersionStatement(db: D1Database, params: any): D1PreparedStatement {
    return updStmt(
        db,
        'articles',
        'title = ?, slug = ?, locale = ?, translation_group_id = ?, maturity = ?, status = ?, summary = ?, metadata = ?, current_version_id = ?, published_at = CASE WHEN ? = \'published\' AND published_at IS NULL THEN CURRENT_TIMESTAMP ELSE published_at END',
        [params.title, params.slug, params.locale, params.translationGroupId, params.maturity, params.status, params.summary, params.metadataStr, params.versionId, params.status],
        params.articleId
    );
}

export const buildInsertArticleStatement = (db: D1Database, p: any) =>
    insEntity(db, 'articles', 'locale, translation_group_id, maturity, ', [p.locale, p.translationGroupId, p.maturity], p);

// Single db.batch() avoids sequential D1 round-trips.
export async function findArticlesListBundle(
    db: D1Database,
    siteId: string
): Promise<{
    articles: Array<Node & { translation_group_name?: string | null }>;
    trashCount: number;
    sites: any[];
}> {
    const [artRes, trashRes, sitesRes] = await db.batch([
        db.prepare(`
            SELECT a.*, 'article' as type, tg.name as translation_group_name
            FROM articles a
            LEFT JOIN translation_groups tg ON tg.id = a.translation_group_id
            WHERE a.site_id = ? AND a.deleted_at IS NULL
            ORDER BY a.updated_at DESC
        `).bind(siteId),
        db.prepare(`
            SELECT (
                SELECT COUNT(DISTINCT a.id) FROM articles a LEFT JOIN article_versions v ON v.article_id = a.id WHERE a.site_id = ? AND (a.deleted_at IS NOT NULL OR v.deleted_at IS NOT NULL)
            ) + (
                SELECT COUNT(DISTINCT p.id) FROM pages p LEFT JOIN page_versions v ON v.page_id = p.id WHERE p.site_id = ? AND (p.deleted_at IS NOT NULL OR v.deleted_at IS NOT NULL)
            ) as total
        `).bind(siteId, siteId),
        db.prepare(`SELECT * FROM sites WHERE status = 'active' ORDER BY created_at ASC`)
    ]);
    const articles = (artRes.results || []).map((r: any) => mapContentEntityRow(r, 'article')) as Array<Node & { translation_group_name?: string | null }>;
    const trashCount = Number((trashRes.results?.[0] as any)?.total || 0);
    return { articles, trashCount, sites: sitesRes.results || [] };
}

// Append chunks directly in D1 to avoid buffering large bodies in Worker memory; dirty routes only on commit.
export async function saveArticleChunkInPlace(
    db: D1Database,
    params: {
        siteId: string;
        articleId: string;
        versionId: string;
        chunkMode: 'init' | 'append' | 'commit';
        chunkText: string;
        title?: string;
        slug?: string;
        summary?: string;
        locale?: string;
        status?: string;
        authorId?: string;
        metadata?: Record<string, any>;
        maturity?: string;
        translationGroupId?: string | null;
    }
): Promise<{ id: string; versionId: string; chunkMode: string }> {
    const nowIso = new Date().toISOString();
    const { siteId, articleId, versionId, chunkMode, chunkText } = params;
    const cleanSlug = (s?: string) => String(s || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();

    if (chunkMode === 'init') {
        const [artRes, verRes] = await db.batch([
            db.prepare(`SELECT id, slug FROM articles WHERE id = ? AND site_id = ? LIMIT 1`).bind(articleId, siteId),
            db.prepare(`SELECT COALESCE(MAX(version_number), 0) as max_ver FROM article_versions WHERE article_id = ?`).bind(articleId)
        ]);
        const existingArt = (artRes.results?.[0] as { id: string; slug: string } | undefined) || null;
        const maxVer = Number((verRes.results?.[0] as any)?.max_ver || 0);
        const nextVerNum = maxVer + 1;
        const targetSlug = cleanSlug(params.slug) || existingArt?.slug || articleId;

        if (!existingArt) {
            const routeCheck = inspectSpecialRoute(targetSlug, null, params.locale || 'zh-CN');
            if (routeCheck.level === 'forbidden') {
                throw new Error(routeCheck.message);
            }
            await assertSiteRouteUnique(db, siteId, `/${targetSlug}`);
        }

        const metaStr = params.metadata ? JSON.stringify(params.metadata) : '{}';
        const stmts: D1PreparedStatement[] = [];
        if (!existingArt) {
            stmts.push(
                db.prepare(`
                    INSERT INTO articles (id, site_id, slug, locale, translation_group_id, maturity, title, summary, metadata, status, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
                `).bind(
                    articleId,
                    siteId,
                    targetSlug,
                    params.locale || 'zh-CN',
                    params.translationGroupId ?? null,
                    params.maturity || 'none',
                    params.title || 'Untitled Article',
                    params.summary || '',
                    metaStr,
                    nowIso,
                    nowIso
                )
            );
        }
        stmts.push(
            db.prepare(`
                INSERT INTO article_versions (id, article_id, version_number, title, summary, content_raw, metadata_snapshot, commit_message, author_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'Chunked save init', ?, ?)
                ON CONFLICT(id) DO UPDATE SET content_raw = excluded.content_raw
            `).bind(
                versionId,
                articleId,
                nextVerNum,
                params.title || 'Untitled Article',
                params.summary || '',
                chunkText,
                metaStr,
                params.authorId || 'admin',
                nowIso
            )
        );
        await db.batch(stmts);
        return { id: articleId, versionId, chunkMode };
    }

    if (chunkMode === 'append') {
        await db.prepare(
            `UPDATE article_versions SET content_raw = COALESCE(content_raw, '') || ? WHERE id = ? AND article_id = ?`
        ).bind(chunkText, versionId, articleId).run();
        return { id: articleId, versionId, chunkMode };
    }

    const existingRow = await db.prepare(
        `SELECT slug, status, locale, title, translation_group_id FROM articles WHERE id = ? AND site_id = ? LIMIT 1`
    ).bind(articleId, siteId).first<{ slug: string; status: string; locale: string; title: string; translation_group_id: string | null }>();

    const normSlug = cleanSlug(params.slug) || existingRow?.slug || articleId;
    const normPath = normSlug === '' || normSlug === 'index' ? '/' : `/${normSlug}`;
    const finalStatus = params.status || existingRow?.status || 'published';
    const finalLocale = params.locale || existingRow?.locale || 'zh-CN';
    const finalTitle = params.title || existingRow?.title || 'Untitled Article';
    const finalTransGroup = params.translationGroupId !== undefined ? params.translationGroupId : (existingRow?.translation_group_id ?? null);

    if (finalStatus === 'published') {
        const routeCheck = inspectSpecialRoute(normSlug, null, finalLocale);
        if (routeCheck.level === 'forbidden') {
            throw new Error(routeCheck.message);
        }
        await assertSiteRouteUnique(db, siteId, normPath, articleId);
    }

    const metaStr = params.metadata ? JSON.stringify(params.metadata) : null;
    const commitStmts: D1PreparedStatement[] = [
        db.prepare(
            `UPDATE article_versions SET content_raw = COALESCE(content_raw, '') || ?, title = COALESCE(?, title), summary = COALESCE(?, summary), metadata_snapshot = COALESCE(?, metadata_snapshot) WHERE id = ? AND article_id = ?`
        ).bind(chunkText, params.title ?? null, params.summary ?? null, metaStr, versionId, articleId),
        db.prepare(
            `UPDATE articles SET title = ?, slug = ?, summary = COALESCE(?, summary), status = ?, locale = ?, translation_group_id = ?, maturity = COALESCE(?, maturity), metadata = COALESCE(?, metadata), current_version_id = ?, published_at = CASE WHEN ? = 'published' AND published_at IS NULL THEN ? ELSE published_at END, updated_at = ? WHERE id = ? AND site_id = ?`
        ).bind(
            finalTitle,
            normSlug,
            params.summary ?? null,
            finalStatus,
            finalLocale,
            finalTransGroup,
            params.maturity ?? null,
            metaStr,
            versionId,
            finalStatus,
            nowIso,
            nowIso,
            articleId,
            siteId
        ),
        buildDeleteOtherSiteRoutesStatement(db, siteId, articleId, normPath),
        finalStatus === 'published'
            ? buildUpsertSiteRouteStatement(db, {
                siteId,
                path: normPath,
                entityType: 'article',
                entityId: articleId,
                locale: finalLocale,
                translationGroupId: finalTransGroup,
                title: finalTitle,
                renderedHtml: null,
                statusCode: 200,
                isDirty: 1
            })
            : buildDeleteEntitySiteRoutesStatement(db, siteId, articleId),
        db.prepare(
            `UPDATE site_routes SET is_dirty = 1, rendered_html = NULL, version = version + 1, updated_at = ? WHERE site_id = ? AND path IN ('/', '/sitemap.xml', '/feed.xml', '/feed.json')`
        ).bind(nowIso, siteId)
    ];
    await db.batch(commitStmts);
    invalidateSiteMemoryCache(siteId);
    await markRoutesDirtyByDependency(db, siteId, ['article:*'], []);
    await purgeEdgeAndZoneCache(db, siteId, [normPath, '/', '/sitemap.xml', '/feed.xml', '/feed.json']);

    return { id: articleId, versionId, chunkMode };
}

export async function findNewArticleEditorDependencies(
    db: D1Database,
    siteId: string
): Promise<{
    siteNodes: Array<{ id: string; title: string; slug: string; type: string }>;
    templatePages: Array<{ id: string; title: string; slug: string; metadata?: any }>;
    schemaNodes: Array<{ id: string; title: string; slug: string; summary?: string; metadata?: any }>;
    translationGroups: Array<{ id: string; name: string }>;
}> {
    const deps = await findContentEditorDependencies(db, siteId, '', '', '');
    return {
        siteNodes: deps.siteNodes,
        templatePages: deps.templatePages,
        schemaNodes: deps.schemaNodes,
        translationGroups: deps.translationGroups
    };
}
