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
    markTranslationGroupPeersDirty,
    removeEntityFromSiteRoutes,
    purgeEdgeAndZoneCache,
    buildClearWikiRelationsStatement,
    findWikiTargetArticleId,
    findWikiTargetMicroId,
    buildInsertContentRelationStatement,
    findSiteMemberRole,
    invalidateSiteMemoryCache,
    isRestrictedAccess
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
    publishedAt?: string | null;
    published_at?: string | null;
    metadata?: Record<string, any>;
    commitMessage?: string;
    isEdit?: boolean;
}

const ALIAS_FORBIDDEN_PREFIXES = new Set([
    'admin', 'api', 'shared', 'assets', 'content', 'theme', 'commercial', 'cdn-cgi', '.well-known'
]);
const ALIAS_FORBIDDEN_PATHS = new Set([
    '/', '/404', '/500', '/503', '/maintenance', '/sitemap.xml', '/robots.txt',
    '/feed.xml', '/feed.json', '/rss.xml', '/llm.txt', '/llms.txt'
]);

export function normalizePublishedAtInput(raw: unknown, existingVal?: string | null): string | undefined {
    if (raw === undefined || raw === null) return undefined;
    const s = String(raw).trim();
    if (!s) return undefined;
    // Preserve full second-level precision when a datetime-local input matches the existing UTC prefix.
    if (existingVal && existingVal.startsWith(s)) {
        return existingVal;
    }
    let isoCandidate = s;
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
        const base = s.replace(' ', 'T');
        isoCandidate = (base.length === 16 ? base + ':00' : base) + 'Z';
    }
    const ts = Date.parse(isoCandidate);
    if (!Number.isNaN(ts)) return new Date(ts).toISOString();
    const rawTs = Date.parse(s);
    return Number.isNaN(rawTs) ? undefined : new Date(rawTs).toISOString();
}

export function normalizeAliasesList(raw: unknown, canonicalPath?: string): string[] {
    const rawItems: string[] = Array.isArray(raw)
        ? raw.map(v => String(v ?? ''))
        : (typeof raw === 'string' ? raw.split(/[\r\n,]+/) : []);
    const normCanonical = canonicalPath ? normalizeRoutePath(canonicalPath) : '';
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of rawItems) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        const norm = normalizeRoutePath(trimmed);
        const firstSeg = norm.slice(1).split('/')[0]?.toLowerCase() || '';
        if (ALIAS_FORBIDDEN_PATHS.has(norm.toLowerCase()) || ALIAS_FORBIDDEN_PREFIXES.has(firstSeg)) continue;
        if (normCanonical && norm === normCanonical) continue;
        if (!seen.has(norm)) {
            seen.add(norm);
            out.push(norm);
        }
    }
    return out;
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
    extraDirtyPaths?: string[];
    extraPurgePaths?: string[];
    oldTranslationGroupId?: string | null;
    translationGroupId?: string | null;
    isTemplate?: boolean;
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
    if (!user) {
        throw new Error('SECURITY_UNAUTHORIZED: Authentication required.');
    }
    if (user.auth_provider === 'api_token') {
        if (user.token_site_id !== siteId) {
            throw new Error(`SECURITY_UNAUTHORIZED: API token is not scoped to site "${siteId}".`);
        }
        return;
    }
    if (user.global_role !== 'superadmin') {
        const memberRole = await findSiteMemberRole(dal.db, siteId, user.id);
        if (memberRole !== 'admin') {
            throw new Error(`SECURITY_UNAUTHORIZED: User "${user.id}" is not an authorized administrator of site "${siteId}".`);
        }
    }
}

export async function requireScopedSiteAdmin(ctx: HookContext<any>, explicitSiteId?: string): Promise<string> {
    const siteId = await resolveActiveSiteId(ctx.dal, explicitSiteId ?? ctx.data?.siteId ?? ctx.siteId);
    await assertSiteAdmin(ctx.dal, siteId, ctx.user);
    return siteId;
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
    content: string,
    preferredLocale?: string
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

        const targetArtId = await findWikiTargetArticleId(dal.db, siteId, targetSlug, cleanSlugCandidate, preferredLocale);
        if (targetArtId) {
            targetId = targetArtId;
            targetType = 'article';
        } else {
            const targetMicId = await findWikiTargetMicroId(dal.db, siteId, targetSlug, cleanSlugCandidate, preferredLocale);
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
    const explicitTgId = ctx.data?.translationGroupId ?? ctx.data?.metadata?.translation_group_id ?? null;
    const tgUnion = Array.from(new Set([
        explicitTgId,
        res.translationGroupId,
        res.oldTranslationGroupId
    ].map(v => String(v || '').trim()).filter(Boolean)));
    const extraDirty = Array.isArray(res.extraDirtyPaths) ? res.extraDirtyPaths : [];
    const extraPurge = Array.isArray(res.extraPurgePaths) ? res.extraPurgePaths : [];
    const pageType = ctx.data.metadata?.page_type;
    const isTemplate = Boolean(res.isTemplate || pageType === 'template');
    const normPath = normalizeRoutePath(res.slug);

    if (ctx.meta?.skipSyncCompile) {
        if (isMicro) {
            await markRoutesDirtyByDependency(db, res.siteId, ['micro:*'], ['/']);
            return;
        }
        const peerPaths = await markTranslationGroupPeersDirty(db, res.siteId, res.nodeId, tgUnion);
        await markSiteRoutesDirty(
            db,
            res.siteId,
            [normPath, ...peerPaths, ...extraDirty, '/', '/sitemap.xml', '/feed.xml', '/feed.json', '/rss.xml', '/en/feed.xml', '/en/feed.json', '/en/rss.xml', '/llm.txt', '/llms.txt'],
            { purgeEverything: isTemplate }
        );
        if (extraPurge.length > 0) {
            await purgeEdgeAndZoneCache(db, res.siteId, extraPurge);
        }
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

    const isRestricted = isRestrictedAccess(ctx.data?.visibility, ctx.data?.metadata);
    const peerPaths = tgUnion.length > 0
        ? await markTranslationGroupPeersDirty(db, res.siteId, res.nodeId, tgUnion)
        : ((!isTemplate && !isRestricted) ? await markTranslationGroupPeersDirty(db, res.siteId, res.nodeId) : []);

    if (res.status === 'published' && !isTemplate && !isRestricted) {
        await compileAndSaveSiteRoute(db, site, normPath, ctx.host);
    } else if (res.status !== 'published' || isRestricted) {
        await removeEntityFromSiteRoutes(db, res.siteId, res.nodeId);
    }

    if (normPath !== '/') {
        await compileAndSaveSiteRoute(db, site, '/', ctx.host);
    }
    if (extraDirty.length > 0) {
        await markSiteRoutesDirty(db, res.siteId, extraDirty);
    }
    if (res.type === 'article') {
        await markRoutesDirtyByDependency(db, res.siteId, ['article:*'], []);
    }
    await rebuildSiteSitemapRoute(db, site, ctx.host);
    invalidateSiteMemoryCache(res.siteId);
    await purgeEdgeAndZoneCache(
        db,
        res.siteId,
        [normPath, ...peerPaths, ...extraDirty, ...extraPurge, '/', '/sitemap.xml', '/feed.xml', '/feed.json', '/rss.xml', '/en/feed.xml', '/en/feed.json', '/en/rss.xml', '/llm.txt', '/llms.txt'],
        { purgeEverything: isTemplate }
    );
}
