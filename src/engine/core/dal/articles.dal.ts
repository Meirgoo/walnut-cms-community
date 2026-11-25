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
import {
    findMaxEntityVersionNumberByType,
    buildInsertEntityVersionStatement,
    buildAppendEntityVersionContentStatement
} from './versions.dal';
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
import { invalidateSiteMemoryCache, findSiteById } from './sites.dal';
import { buildLocalizedRoutePath } from '../i18n';

export const findArticleForVcs = (db: D1Database, articleId: string, siteId?: string) =>
    findEntityForVcs(db, 'articles', articleId, siteId);

export const findLatestArticleVersion = (db: D1Database, articleId: string) =>
    findLatestEntityVersion(db, 'article', articleId);

export function buildUpdateArticleMetadataOnlyStatement(db: D1Database, params: any): D1PreparedStatement {
    return updStmt(
        db,
        'articles',
        'title = ?, slug = ?, locale = ?, translation_group_id = ?, maturity = ?, status = ?, visibility = ?, summary = ?, metadata = ?, published_at = COALESCE(?, CASE WHEN ? = \'published\' AND published_at IS NULL THEN CURRENT_TIMESTAMP ELSE published_at END)',
        [params.title, params.slug, params.locale, params.translationGroupId, params.maturity, params.status, params.visibility || 'public', params.summary, params.metadataStr, params.publishedAt ?? null, params.status],
        params.articleId,
        params.siteId
    );
}

export function buildInsertArticleVersionStatement(db: D1Database, params: any): D1PreparedStatement {
    return bindInsertVersion(db, 'article', params);
}

export function buildUpdateArticleWithVersionStatement(db: D1Database, params: any): D1PreparedStatement {
    return updStmt(
        db,
        'articles',
        'title = ?, slug = ?, locale = ?, translation_group_id = ?, maturity = ?, status = ?, visibility = ?, summary = ?, metadata = ?, current_version_id = ?, published_at = COALESCE(?, CASE WHEN ? = \'published\' AND published_at IS NULL THEN CURRENT_TIMESTAMP ELSE published_at END)',
        [params.title, params.slug, params.locale, params.translationGroupId, params.maturity, params.status, params.visibility || 'public', params.summary, params.metadataStr, params.versionId, params.publishedAt ?? null, params.status],
        params.articleId,
        params.siteId
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
            SELECT a.*, 'article' as type
            FROM articles a
            WHERE a.site_id = ? AND a.deleted_at IS NULL
            ORDER BY a.updated_at DESC
        `).bind(siteId),
        db.prepare(`
            SELECT COUNT(DISTINCT a.id) as total
            FROM articles a
            LEFT JOIN entity_versions v ON v.entity_type = 'article' AND v.entity_id = a.id
            WHERE a.site_id = ? AND (a.deleted_at IS NOT NULL OR v.deleted_at IS NOT NULL)
        `).bind(siteId),
        db.prepare(`SELECT * FROM sites WHERE status = 'active' ORDER BY created_at ASC`)
    ]);
    const sites = sitesRes.results || [];
    const defaultLocale = (sites.find((s: any) => s.id === siteId) as any)?.default_locale || 'zh-CN';
    const articles = (artRes.results || []).map((r: any) => mapContentEntityRow(r, 'article')) as Array<Node & { translation_group_name?: string | null }>;
    const groupNameMap = new Map<string, string>();
    for (const a of articles) {
        const gid = a.translation_group_id || a.metadata?.translation_group_id;
        if (!gid) continue;
        if (!groupNameMap.has(gid) || a.locale === defaultLocale) {
            groupNameMap.set(gid, a.title || gid);
        }
    }
    for (const a of articles) {
        const gid = a.translation_group_id || a.metadata?.translation_group_id;
        if (gid) a.translation_group_name = groupNameMap.get(gid) || gid;
    }
    const trashCount = Number((trashRes.results?.[0] as any)?.total || 0);
    return { articles, trashCount, sites };
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
): Promise<{
    id: string;
    versionId: string;
    chunkMode: string;
    siteId?: string;
    localizedPath?: string;
    oldLocalizedPath?: string | null;
    translationGroupId?: string | null;
    oldTranslationGroupId?: string | null;
}> {
    const nowIso = new Date().toISOString();
    const { siteId, articleId, versionId, chunkMode, chunkText } = params;
    const cleanSlug = (s?: string) => String(s || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();

    if (chunkMode === 'init') {
        const [existingArt, maxVer] = await Promise.all([
            db.prepare(`SELECT id, slug FROM articles WHERE id = ? AND site_id = ? LIMIT 1`).bind(articleId, siteId).first<{ id: string; slug: string }>(),
            findMaxEntityVersionNumberByType(db, 'article', articleId)
        ]);
        const nextVerNum = maxVer + 1;
        const targetSlug = cleanSlug(params.slug) || existingArt?.slug || articleId;

        const site = await findSiteById(db, siteId).catch(() => null);
        const siteDefaultLocale = site?.default_locale || 'zh-CN';
        const initLocale = params.locale || siteDefaultLocale;

        if (!existingArt) {
            const routeCheck = inspectSpecialRoute(targetSlug, null, initLocale);
            if (routeCheck.level === 'forbidden') {
                throw new Error(routeCheck.message);
            }
            await assertSiteRouteUnique(db, siteId, `/${targetSlug}`, null, initLocale, siteDefaultLocale);
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
            buildInsertEntityVersionStatement(db, {
                id: versionId,
                siteId,
                entityType: 'article',
                entityId: articleId,
                versionNumber: nextVerNum,
                title: params.title || 'Untitled Article',
                summary: params.summary || '',
                contentRaw: chunkText,
                metadataSnapshot: metaStr,
                commitMessage: 'Chunked save init',
                authorId: params.authorId || 'admin',
                createdAt: nowIso,
                upsertContentOnConflict: true
            })
        );
        await db.batch(stmts);
        return { id: articleId, versionId, chunkMode };
    }

    if (chunkMode === 'append') {
        await buildAppendEntityVersionContentStatement(db, {
            versionId,
            entityType: 'article',
            entityId: articleId,
            chunkText
        }).run();
        return { id: articleId, versionId, chunkMode };
    }

    const existingRow = await db.prepare(
        `SELECT slug, status, locale, title, translation_group_id FROM articles WHERE id = ? AND site_id = ? LIMIT 1`
    ).bind(articleId, siteId).first<{ slug: string; status: string; locale: string; title: string; translation_group_id: string | null }>();

    const site = await findSiteById(db, siteId).catch(() => null);
    const siteDefaultLocale = site?.default_locale || 'zh-CN';
    const normSlug = cleanSlug(params.slug) || existingRow?.slug || articleId;
    const normPath = normSlug === '' || normSlug === 'index' ? '/' : `/${normSlug}`;
    const finalStatus = params.status || existingRow?.status || 'published';
    const finalLocale = params.locale || existingRow?.locale || siteDefaultLocale;
    const localizedPath = buildLocalizedRoutePath(normPath, finalLocale, siteDefaultLocale);
    const finalTitle = params.title || existingRow?.title || 'Untitled Article';
    const oldTranslationGroupId = existingRow?.translation_group_id ?? null;
    const finalTransGroup = params.translationGroupId !== undefined ? params.translationGroupId : oldTranslationGroupId;
    const oldNormPath = existingRow?.slug
        ? (existingRow.slug === '' || existingRow.slug === 'index' ? '/' : `/${existingRow.slug}`)
        : null;
    const oldLocalizedPath = oldNormPath
        ? buildLocalizedRoutePath(oldNormPath, existingRow?.locale || siteDefaultLocale, siteDefaultLocale)
        : null;

    if (finalStatus === 'published') {
        const routeCheck = inspectSpecialRoute(normSlug, null, finalLocale);
        if (routeCheck.level === 'forbidden') {
            throw new Error(routeCheck.message);
        }
        await assertSiteRouteUnique(db, siteId, normPath, articleId, finalLocale, siteDefaultLocale);
    }

    const metaStr = params.metadata ? JSON.stringify(params.metadata) : null;
    const commitStmts: D1PreparedStatement[] = [
        buildAppendEntityVersionContentStatement(db, {
            versionId,
            entityType: 'article',
            entityId: articleId,
            chunkText,
            title: params.title ?? null,
            summary: params.summary ?? null,
            metadataSnapshot: metaStr
        }),
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
        buildDeleteOtherSiteRoutesStatement(db, siteId, articleId, localizedPath),
        finalStatus === 'published'
            ? buildUpsertSiteRouteStatement(db, {
                siteId,
                path: localizedPath,
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
            `UPDATE site_routes SET is_dirty = 1, rendered_html = NULL, version = version + 1, updated_at = ? WHERE site_id = ? AND path IN ('/', '/sitemap.xml', '/feed.xml', '/feed.json', '/rss.xml', '/en/feed.xml', '/en/feed.json', '/en/rss.xml', '/llm.txt', '/llms.txt')`
        ).bind(nowIso, siteId)
    ];
    await db.batch(commitStmts);
    invalidateSiteMemoryCache(siteId);
    await markRoutesDirtyByDependency(db, siteId, ['article:*'], []);
    const purgeTargets = [localizedPath, '/', '/sitemap.xml', '/feed.xml', '/feed.json', '/rss.xml', '/en/feed.xml', '/en/feed.json', '/en/rss.xml', '/llm.txt', '/llms.txt'];
    if (oldLocalizedPath && oldLocalizedPath !== localizedPath) {
        purgeTargets.unshift(oldLocalizedPath);
    }
    await purgeEdgeAndZoneCache(db, siteId, purgeTargets);

    return {
        id: articleId,
        versionId,
        chunkMode,
        siteId,
        localizedPath,
        oldLocalizedPath,
        translationGroupId: finalTransGroup,
        oldTranslationGroupId
    };
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
