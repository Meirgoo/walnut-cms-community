import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { DAL } from '../dal';
import { nanoId } from '../kernel';
import type { HookContext, ArticleMaturity, ArticleStatus, AuthenticatedUser } from '../types';
import {
    normalizeRoutePath,
    compileAndSaveSiteRoute,
    rebuildSiteSitemapRoute,
    markSiteRoutesDirty,
    markRoutesDirtyByDependency,
    removeEntityFromSiteRoutes,
    purgeEdgeAndZoneCache,
    buildClearWikiRelationsStatement,
    findWikiTargetArticleId,
    findWikiTargetMicroId,
    buildInsertContentRelationStatement,
    findSiteMemberRole,
    invalidateSiteMemoryCache
} from '../core/dal';
import { parseJson, isSiteAdminUser } from '../core/utils';

export interface SaveEntityPayload {
    id?: string;
    siteId?: string;
    slug?: string;
    type?: string;
    locale?: string;
    parentId?: string | null;
    translationGroupId?: string | null;
    maturity?: ArticleMaturity;
    progress?: string;
    visibility?: string;
    status?: ArticleStatus;
    title?: string;
    summary?: string;
    contentRaw?: string;
    metadata?: Record<string, any>;
    commitMessage?: string;
    isEdit?: boolean;
}

export type SaveNodePayload = SaveEntityPayload;

export interface SaveEntityResult {
    id: string;
    nodeId: string;
    versionId: string;
    versionNumber: number;
    isEdit: boolean;
    unchanged: boolean;
    siteId: string;
    slug: string;
    title: string;
    type: string;
    locale: string;
    status: ArticleStatus;
}

export type SaveNodeResult = SaveEntityResult;

export async function resolveActiveSiteId(dal: DAL, candidateSiteId?: string): Promise<string> {
    if (candidateSiteId && candidateSiteId.trim()) {
        return candidateSiteId.trim();
    }
    const defaultSite = await dal.findFirstActiveSite();
    return defaultSite?.id || 'site_default';
}

export function assertAdminUser(ctx: HookContext<any>): void {
    if (!isSiteAdminUser(ctx.user)) {
        throw new Error('UNAUTHORIZED_ACCESS_REQUIRED');
    }
}

export async function assertSiteAdmin(dal: DAL, siteId: string, user?: AuthenticatedUser | null): Promise<void> {
    if (user && user.global_role !== 'superadmin') {
        const memberRole = await findSiteMemberRole(dal.db, siteId, user.id);
        if (memberRole !== 'admin') {
            throw new Error(`SECURITY_UNAUTHORIZED: User "${user.id}" is not an authorized administrator of site "${siteId}".`);
        }
    }
}

export function normalizeEntitySlug(rawSlugInput: string | undefined, defaultPrefix: string): string {
    const raw = (rawSlugInput || '').trim();
    if (raw === '/' || raw.toLowerCase() === 'index') return '/';
    const clean = raw.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/').toLowerCase();
    return clean || nanoId(defaultPrefix, 8);
}

export async function syncWikiRelationsBatch(
    dal: DAL,
    siteId: string,
    sourceId: string,
    sourceType: 'article' | 'micro' | 'page',
    content: string
): Promise<void> {
    await dal.batch([
        buildClearWikiRelationsStatement(dal.db, sourceId)
    ]);

    if (!content) return;

    const wikiRegex = /\[\[([^\[\]\n|]+)(?:\|[^\[\]\n]+)?\]\]/g;
    const matches = Array.from(content.matchAll(wikiRegex));
    const targetSlugs = Array.from(new Set(matches.map((m) => m[1].trim())))
        .filter(Boolean)
        .filter((item) => !item.includes(':') && !item.includes('：'));

    if (targetSlugs.length === 0) return;

    const nowIso = new Date().toISOString();
    const batchStatements: D1PreparedStatement[] = [];

    for (const targetSlug of targetSlugs) {
        const cleanSlugCandidate =
            targetSlug
                .toLowerCase()
                .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]+/g, '-')
                .replace(/^-+|-+$/g, '') || `item-${Date.now().toString(36)}`;

        let targetId: string | null = null;
        let targetType: 'article' | 'micro' | 'unknown' = 'unknown';

        const targetArtId = await findWikiTargetArticleId(dal.db, siteId, targetSlug, cleanSlugCandidate);
        if (targetArtId) {
            targetId = targetArtId;
            targetType = 'article';
        } else {
            const targetMicId = await findWikiTargetMicroId(dal.db, siteId, targetSlug, cleanSlugCandidate);
            if (targetMicId) {
                targetId = targetMicId;
                targetType = 'micro';
            }
        }

        const relationId = nanoId('rel');
        batchStatements.push(
            buildInsertContentRelationStatement(dal.db, {
                id: relationId,
                siteId,
                sourceId,
                sourceType,
                targetId,
                targetType,
                targetSlug,
                relationType: 'wiki_link',
                createdAt: nowIso
            })
        );
    }

    if (batchStatements.length > 0) {
        await dal.batch(batchStatements);
    }
}

export async function syncSavedEntityCacheAfterHook(
    ctx: HookContext<SaveEntityPayload, SaveEntityResult>
): Promise<void> {
    const res = ctx.result;
    if (!res || res.unchanged) return;

    const db = ctx.dal.db;
    const isMicro = res.type === 'micro';
    if (ctx.meta?.skipSyncCompile) {
        if (isMicro) {
            await markRoutesDirtyByDependency(db, res.siteId, ['micro:*'], ['/']);
            return;
        }
        const normPath = normalizeRoutePath(res.slug);
        await markSiteRoutesDirty(db, res.siteId, [normPath, '/', '/sitemap.xml', '/feed.xml', '/feed.json']);
        if (res.type === 'article') {
            await markRoutesDirtyByDependency(db, res.siteId, ['article:*'], []);
        }
        return;
    }

    const site = await ctx.dal.findSiteById(res.siteId);
    if (!site) return;

    site.settings = parseJson<Record<string, any>>(site.settings, {});

    if (isMicro) {
        await markRoutesDirtyByDependency(db, res.siteId, ['micro:*'], ['/']);
        await compileAndSaveSiteRoute(db, site, '/', ctx.host);
        await purgeEdgeAndZoneCache(db, res.siteId, ['/', '/feed.xml', '/feed.json']);
        return;
    }

    const pageType = ctx.data.metadata?.page_type;
    const normPath = normalizeRoutePath(res.slug);

    if (res.status === 'published' && pageType !== 'template') {
        await compileAndSaveSiteRoute(db, site, normPath, ctx.host);
    } else if (res.status !== 'published') {
        await removeEntityFromSiteRoutes(db, res.siteId, res.nodeId);
    }

    if (normPath !== '/') {
        await compileAndSaveSiteRoute(db, site, '/', ctx.host);
    }
    if (res.type === 'article') {
        await markRoutesDirtyByDependency(db, res.siteId, ['article:*'], []);
    }
    await rebuildSiteSitemapRoute(db, site, ctx.host);
    invalidateSiteMemoryCache(res.siteId);
    await purgeEdgeAndZoneCache(db, res.siteId, [normPath, '/', '/sitemap.xml', '/feed.xml', '/feed.json']);
}
