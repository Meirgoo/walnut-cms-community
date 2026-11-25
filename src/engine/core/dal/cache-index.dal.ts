import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { Site } from '../../types';
import { renderDynamicVisitorPage } from '../../render';
import { invalidateSiteMemoryCache, findSiteById } from './sites.dal';
import { findPageSlugById, createPageParentPathResolver, loadPublishedPageParentResolver } from './pages.dal';
import { isLocalHost, resolveEffectiveDomain } from '../url';
import { t, buildLocalizedRoutePath, normalizeLocaleCode, getLocaleShortPrefix } from '../i18n';
import { parseJson } from '../utils';
import { isRestrictedAccess } from './content-common';
import { vaultDecrypt } from '../crypto/vault';
import {
    normalizeRoutePath,
    inspectSpecialRoute,
    buildSpecialRouteCacheRequest,
    putSpecialRouteToEdgeCache,
    matchSpecialRouteFromEdgeCache,
    renderFallbackErrorHtml,
    type SpecialRouteCheckResult
} from './route-fallback.dal';
import {
    rebuildSiteSitemapRoute,
    renderRichSitemapXml,
    rebuildSiteFeedRoute,
    rebuildSiteLlmTxtRoute
} from './site-feeds.dal';

export {
    normalizeRoutePath,
    inspectSpecialRoute,
    buildSpecialRouteCacheRequest,
    putSpecialRouteToEdgeCache,
    matchSpecialRouteFromEdgeCache,
    renderFallbackErrorHtml,
    rebuildSiteSitemapRoute,
    renderRichSitemapXml,
    rebuildSiteFeedRoute,
    rebuildSiteLlmTxtRoute,
    type SpecialRouteCheckResult
};

export interface CacheIndexRebuildNodeRow {
    id: string;
    slug: string;
    parent_id?: string | null;
    type: string;
    locale: string;
    visibility?: string | null;
    translation_group_id?: string | null;
    title: string;
    summary?: string | null;
    cover_image_url?: string | null;
    metadata?: string | null;
    updated_at: string;
    published_at?: string | null;
}

export interface SitemapImageItem {
    loc: string;
    title?: string;
    caption?: string;
}

export interface SiteCacheEntry {
    path: string;
    version: number;
    updated_at: string;
    node_id?: string;
    type?: string;
    title?: string;
    locale?: string;
    translations?: Array<{ locale: string; path: string }>;
    images?: SitemapImageItem[];
    changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
    priority?: number;
}

export type SiteCacheIndex = Record<string, SiteCacheEntry>;

export interface SiteRouteRow {
    id: string;
    site_id: string;
    path: string;
    entity_type: 'home' | 'article' | 'page' | 'redirect' | 'sitemap' | string;
    entity_id: string | null;
    locale: string;
    translation_group_id: string | null;
    title: string | null;
    version: number;
    rendered_html: string | null;
    status_code: number;
    redirect_target: string | null;
    is_dirty: number;
    changefreq: string | null;
    priority: number | null;
    images_json: string | null;
    template_id?: string | null;
    schema_slug?: string | null;
    dependencies_json?: string | null;
    created_at: string;
    updated_at: string;
}

export interface UpsertSiteRouteInput {
    id?: string;
    siteId: string;
    path: string;
    entityType: 'home' | 'article' | 'page' | 'redirect' | 'sitemap' | string;
    entityId?: string | null;
    locale?: string;
    translationGroupId?: string | null;
    title?: string | null;
    version?: number;
    renderedHtml?: string | null;
    statusCode?: number;
    redirectTarget?: string | null;
    isDirty?: number;
    changefreq?: string;
    priority?: number;
    images?: SitemapImageItem[];
    templateId?: string | null;
    schemaSlug?: string | null;
    dependencies?: Record<string, any> | Array<any>;
}

// Resolve collisions using the final localized canonical path so different locales may share a slug while identical effective URLs are blocked.
export async function assertSiteRouteUnique(
    db: D1Database,
    siteId: string,
    rawPath: string,
    currentEntityId?: string | null,
    locale: string = 'zh-CN',
    siteDefaultLocale?: string
): Promise<string> {
    const specialCheck = inspectSpecialRoute(rawPath, null, locale);
    if (specialCheck.level === 'forbidden') {
        throw new Error(specialCheck.message || t(locale, 'common.error'));
    }

    const defaultLocale = siteDefaultLocale || (await findSiteById(db, siteId).catch(() => null))?.default_locale || 'zh-CN';
    const targetLocale = locale || defaultLocale;
    const localizedPath = buildLocalizedRoutePath(specialCheck.normPath, targetLocale, defaultLocale);
    const excludeId = currentEntityId || '';

    const routeConflict = await db.prepare(`
        SELECT entity_id as id, title, entity_type as type FROM site_routes
        WHERE site_id = ? AND path = ? AND entity_id IS NOT NULL AND entity_id != ?
        LIMIT 1
    `).bind(siteId, localizedPath, excludeId).first<{ id: string; title: string; type: string }>();

    if (routeConflict) {
        const typeLabel = routeConflict.type === 'article' ? 'article' : (routeConflict.type === 'page' ? 'page' : 'route');
        throw new Error(
            `Same-site route conflict: path [${localizedPath}] is already occupied by ${typeLabel} [${routeConflict.title || routeConflict.id}], please change Slug`
        );
    }

    const bareLocalized = localizedPath === '/' ? '' : localizedPath.slice(1);
    const lastSeg = bareLocalized.split('/').pop() || '';
    const rawBare = specialCheck.normPath === '/' ? '' : specialCheck.normPath.slice(1);
    const rawLastSeg = rawBare.split('/').pop() || '';
    const slugCandidates = Array.from(new Set([
        '/', 'index', '',
        ...(lastSeg ? [lastSeg, `/${lastSeg}`] : []),
        ...(rawLastSeg ? [rawLastSeg, `/${rawLastSeg}`] : []),
        ...(bareLocalized ? [bareLocalized, `/${bareLocalized}`] : []),
        ...(rawBare ? [rawBare, `/${rawBare}`] : [])
    ]));
    const placeholders = slugCandidates.map(() => '?').join(', ');
    const likeLast = lastSeg ? `%/${lastSeg}` : '%';

    const [artCandidates, pageCandidates] = await db.batch([
        db.prepare(`
            SELECT id, title, slug, locale FROM articles
            WHERE site_id = ? AND id != ? AND deleted_at IS NULL AND (slug IN (${placeholders}) OR slug LIKE ?)
        `).bind(siteId, excludeId, ...slugCandidates, likeLast),
        db.prepare(`
            SELECT id, title, slug, parent_id, locale FROM pages
            WHERE site_id = ? AND id != ? AND deleted_at IS NULL
              AND (metadata NOT LIKE '%"page_type":"template"%' OR metadata IS NULL)
              AND (slug IN (${placeholders}) OR slug LIKE ?)
        `).bind(siteId, excludeId, ...slugCandidates, likeLast)
    ]);

    for (const art of (artCandidates.results || []) as Array<{ id: string; title: string; slug: string; locale?: string }>) {
        const artLocalized = buildLocalizedRoutePath(normalizeRoutePath(art.slug), art.locale || defaultLocale, defaultLocale);
        if (artLocalized === localizedPath) {
            throw new Error(
                `Same-site route conflict: path [${localizedPath}] is already occupied by article [${art.title || art.id}], please change Slug`
            );
        }
    }

    const pageRows = (pageCandidates.results || []) as Array<{ id: string; title: string; slug: string; parent_id?: string | null; locale?: string }>;
    const resolveParent = await loadPublishedPageParentResolver(db, siteId, pageRows.some(pg => Boolean(pg.parent_id)));
    for (const pg of pageRows) {
        const parentPath = pg.parent_id ? resolveParent(pg.parent_id) : null;
        const pageRaw = normalizeRoutePath(pg.slug, parentPath);
        const pageLocalized = buildLocalizedRoutePath(pageRaw, pg.locale || defaultLocale, defaultLocale);
        if (pageLocalized === localizedPath) {
            throw new Error(
                `Same-site route conflict: path [${localizedPath}] is already occupied by page [${pg.title || pg.id}], please change Slug`
            );
        }
    }

    return localizedPath;
}

async function mutateAndFlushRoutes(
    db: D1Database,
    siteId: string,
    customStatements: D1PreparedStatement[] = [],
    flushHomeAndSitemap = true
): Promise<void> {
    try {
        const nowIso = new Date().toISOString();
        const stmts: D1PreparedStatement[] = [...customStatements];
        if (flushHomeAndSitemap) {
            stmts.push(buildMarkHomeAndSitemapRoutesDirtyStatement(db, siteId, nowIso));
        }
        stmts.push(buildTouchSiteUpdatedAtStatement(db, siteId, nowIso));
        await db.batch(stmts);
    } catch (e) {
        console.warn(`[SiteRoutes] Batch flush warning for site ${siteId}:`, e);
    }

    invalidateSiteMemoryCache(siteId);
    const edgeCache: Cache | undefined = (globalThis as any).caches?.default;
    if (edgeCache) {
        edgeCache.delete(buildSpecialRouteCacheRequest(siteId, '500')).catch(() => {});
        edgeCache.delete(buildSpecialRouteCacheRequest(siteId, '503')).catch(() => {});
    }
}

export async function purgeEdgeAndZoneCache(
    db: D1Database,
    siteId: string,
    paths?: string[],
    opts: { purgeEverything?: boolean; requestOrigin?: string; siteOverride?: any } = {}
): Promise<void> {
    const edgeCache: Cache | undefined = (globalThis as any).caches?.default;
    const basePaths = (paths && paths.length > 0 ? paths : ['/']).map(p => (p === '/sitemap.xml' ? '/sitemap.xml' : normalizeRoutePath(p)));
    const expandedPaths = new Set<string>(basePaths);
    for (const p of basePaths) {
        if (
            p.startsWith('/theme/') ||
            p.startsWith('/content/') ||
            ['/sitemap.xml', '/feed.xml', '/feed.json', '/rss.xml', '/en/feed.xml', '/en/feed.json', '/en/rss.xml', '/zh/feed.xml', '/zh/feed.json', '/zh/rss.xml', '/llm.txt', '/llms.txt', '/robots.txt'].includes(p)
        ) continue;
        for (const pref of ['/en', '/en-US', '/zh', '/zh-CN']) {
            expandedPaths.add(p === '/' ? pref : `${pref}${p}`);
        }
    }
    const targetPaths = Array.from(expandedPaths);
    const site = opts.siteOverride !== undefined ? opts.siteOverride : await findSiteById(db, siteId).catch(() => null);
    const siteSettings = parseJson<Record<string, any>>(site?.settings, {});
    const rawDomain = (site?.primary_domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    const origins: string[] = ['http://localhost:8787'];
    for (const cand of [rawDomain, siteSettings.sitemap_domain, siteSettings.seo?.sitemap_domain]) {
        const cleanDom = String(cand || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
        if (cleanDom && cleanDom !== '*') {
            const proto = isLocalHost(cleanDom) ? 'http' : 'https';
            origins.push(`${proto}://${cleanDom}`);
        }
    }
    if (opts.requestOrigin) origins.push(opts.requestOrigin);
    const knownOrigins: Set<string> | undefined = (globalThis as any).__WALNUT_KNOWN_ORIGINS__;
    if (knownOrigins) {
        for (const o of knownOrigins) {
            if (o) origins.push(o);
        }
    }

    const purgeUrls: string[] = [];
    const deletePromises: Promise<boolean>[] = [];
    for (const origin of Array.from(new Set(origins))) {
        for (const p of targetPaths) {
            const fullUrl = `${origin}${p}`;
            purgeUrls.push(fullUrl);
            if (edgeCache) {
                deletePromises.push(edgeCache.delete(new Request(fullUrl, { method: 'GET' })).catch(() => false));
            }
        }
    }
    if (deletePromises.length > 0) {
        await Promise.allSettled(deletePromises);
    }

    const cfEnv = (globalThis as any).__CF_ENV__;
    const zoneId = cfEnv?.CF_ZONE_ID || siteSettings.cf_zone_id;
    const rawApiToken = String(cfEnv?.CF_API_TOKEN || siteSettings.cf_api_token || '').trim();
    const apiToken = rawApiToken.startsWith('enc:v1:')
        ? await vaultDecrypt(rawApiToken, siteId, 'cf_api_token', cfEnv, db).catch(() => '')
        : rawApiToken;

    if (zoneId && apiToken && rawDomain && rawDomain !== '*' && !isLocalHost(rawDomain)) {
        const purgeEndpoint = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`;
        const reqHeaders = {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
        };
        if (opts.purgeEverything) {
            await fetch(purgeEndpoint, {
                method: 'POST',
                headers: reqHeaders,
                body: JSON.stringify({ purge_everything: true })
            }).catch(() => {});
            return;
        }
        const zoneFiles = Array.from(new Set(purgeUrls.filter(u => !u.startsWith('http://localhost'))));
        // Cloudflare purge_cache rejects payloads exceeding 30 URLs per request.
        for (let i = 0; i < zoneFiles.length; i += 30) {
            const chunk = zoneFiles.slice(i, i + 30);
            await fetch(purgeEndpoint, {
                method: 'POST',
                headers: reqHeaders,
                body: JSON.stringify({ files: chunk })
            }).catch(() => {});
        }
    }
}

export function buildUpsertSiteRouteStatement(db: D1Database, input: UpsertSiteRouteInput): D1PreparedStatement {
    const normPath = normalizeRoutePath(input.path);
    const sanitizedSlug = normPath === '/' ? 'home' : normPath.replace(/[^a-zA-Z0-9_-]/g, '_');
    const pathHash = normPath.length > 40
        ? `_${Array.from(normPath).reduce((acc, ch) => ((acc * 31 + ch.charCodeAt(0)) >>> 0), 0).toString(36)}`
        : '';
    const routeId = input.id || `sr_${input.siteId}_${sanitizedSlug.slice(0, 40)}${pathHash}`;
    const imagesJson = input.images && input.images.length > 0 ? JSON.stringify(input.images) : null;
    const dependenciesJson = input.dependencies ? JSON.stringify(input.dependencies) : null;

    return db.prepare(`
        INSERT INTO site_routes (
            id, site_id, path, entity_type, entity_id, locale, translation_group_id,
            title, version, rendered_html, status_code, redirect_target, is_dirty,
            changefreq, priority, images_json, template_id, schema_slug, dependencies_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(site_id, path) DO UPDATE SET
            entity_type = excluded.entity_type, entity_id = excluded.entity_id, locale = excluded.locale,
            translation_group_id = excluded.translation_group_id, title = excluded.title, version = site_routes.version + 1,
            rendered_html = excluded.rendered_html, status_code = excluded.status_code, redirect_target = excluded.redirect_target,
            is_dirty = excluded.is_dirty, changefreq = excluded.changefreq, priority = excluded.priority,
            images_json = COALESCE(excluded.images_json, site_routes.images_json),
            template_id = COALESCE(excluded.template_id, site_routes.template_id),
            schema_slug = COALESCE(excluded.schema_slug, site_routes.schema_slug),
            dependencies_json = COALESCE(excluded.dependencies_json, site_routes.dependencies_json),
            updated_at = excluded.updated_at
    `).bind(
        routeId, input.siteId, normPath, input.entityType, input.entityId ?? null,
        input.locale || 'zh-CN', input.translationGroupId ?? null, input.title ?? null,
        input.version ?? 1, input.renderedHtml ?? null, input.statusCode ?? 200,
        input.redirectTarget ?? null, input.isDirty ?? 1,
        input.changefreq || (normPath === '/' ? 'daily' : 'weekly'),
        input.priority ?? (normPath === '/' ? 1.0 : input.entityType === 'article' ? 0.8 : 0.6),
        imagesJson, input.templateId ?? null, input.schemaSlug ?? null,
        dependenciesJson, new Date().toISOString()
    );
}

export async function findSiteRouteByPath(
    db: D1Database,
    siteId: string,
    rawPath: string
): Promise<SiteRouteRow | null> {
    const normPath = rawPath === '/sitemap.xml' ? '/sitemap.xml' : normalizeRoutePath(rawPath);
    try {
        return await db.prepare(`SELECT * FROM site_routes WHERE site_id = ? AND path = ? LIMIT 1`).bind(siteId, normPath).first<SiteRouteRow>();
    } catch {
        return null;
    }
}

export async function markSiteRoutesDirty(
    db: D1Database,
    siteId: string,
    paths?: string[],
    opts: { purgeEverything?: boolean; requestOrigin?: string } = {}
): Promise<void> {
    const nowIso = new Date().toISOString();
    let purgePaths = paths;
    let purgeEverything = Boolean(opts.purgeEverything);
    let stmt: D1PreparedStatement;
    if (paths && paths.length > 0) {
        const normPaths = Array.from(new Set(paths.map(p => (p === '/sitemap.xml' ? '/sitemap.xml' : normalizeRoutePath(p)))));
        const placeholders = normPaths.map(() => '?').join(', ');
        stmt = db.prepare(`
            UPDATE site_routes
            SET is_dirty = 1, rendered_html = NULL, version = version + 1, updated_at = ?
            WHERE site_id = ? AND path IN (${placeholders})
        `).bind(nowIso, siteId, ...normPaths);
    } else {
        purgeEverything = true;
        const collected: string[] = [];
        const pageSize = 200;
        let offset = 0;
        try {
            while (true) {
                const pageRows = await db.prepare(
                    `SELECT path FROM site_routes WHERE site_id = ? ORDER BY path ASC LIMIT ? OFFSET ?`
                ).bind(siteId, pageSize, offset).all<{ path: string }>();
                const list = pageRows.results || [];
                for (const r of list) {
                    if (r.path) collected.push(r.path);
                }
                if (list.length < pageSize) break;
                offset += pageSize;
            }
        } catch {}
        if (collected.length > 0) {
            purgePaths = collected;
        }
        stmt = db.prepare(`
            UPDATE site_routes
            SET is_dirty = 1, rendered_html = NULL, version = version + 1, updated_at = ?
            WHERE site_id = ?
        `).bind(nowIso, siteId);
    }
    await mutateAndFlushRoutes(db, siteId, [stmt], false);
    await purgeEdgeAndZoneCache(db, siteId, purgePaths, { purgeEverything, requestOrigin: opts.requestOrigin });
}

export async function markRoutesDirtyByDependency(
    db: D1Database,
    siteId: string,
    depKeys: string[],
    fallbackPaths: string[] = ['/']
): Promise<void> {
    const targetPaths = new Set<string>(
        fallbackPaths.map(p => (p === '/sitemap.xml' ? '/sitemap.xml' : normalizeRoutePath(p)))
    );
    const keySet = new Set(depKeys.filter(Boolean));
    const hasDatasetDep = Array.from(keySet).some(k => k.startsWith('dataset:'));

    try {
        const rows = await db.prepare(
            `SELECT path, dependencies_json FROM site_routes WHERE site_id = ? AND is_dirty = 0 AND dependencies_json IS NOT NULL`
        ).bind(siteId).all<{ path: string; dependencies_json: string | null }>();

        for (const row of rows.results || []) {
            if (!row.dependencies_json) continue;
            try {
                const deps = JSON.parse(row.dependencies_json);
                if (!Array.isArray(deps)) continue;
                const matched = deps.some((d: string) =>
                    keySet.has(d) ||
                    (hasDatasetDep && d === 'dataset:*') ||
                    (keySet.has('dataset:*') && d.startsWith('dataset:'))
                );
                if (matched) targetPaths.add(row.path);
            } catch {}
        }
    } catch {}

    if (targetPaths.size > 0) {
        await markSiteRoutesDirty(db, siteId, Array.from(targetPaths));
    }
}

export async function removeEntityFromSiteRoutes(
    db: D1Database,
    siteId: string,
    entityId: string
): Promise<void> {
    await mutateAndFlushRoutes(db, siteId, [buildDeleteEntitySiteRoutesStatement(db, siteId, entityId)], true);
}

const LOCALE_PREFIX_TO_CODE: Record<string, string> = {
    'en': 'en-US',
    'en-us': 'en-US',
    'zh': 'zh-CN',
    'zh-cn': 'zh-CN'
};

export async function compileAndSaveSiteRoute(
    db: D1Database,
    site: Site,
    rawPath: string,
    host?: string
): Promise<{ html: string; status: number; redirectUrl?: string }> {
    const normPath = normalizeRoutePath(rawPath);
    const targetHost = resolveEffectiveDomain(site.primary_domain, host);
    const defaultLocale = site.default_locale || 'zh-CN';
    const existing = await findSiteRouteByPath(db, site.id, normPath);

    const firstSeg = (normPath.slice(1).split('/')[0] || '').toLowerCase();
    const prefixLocale = LOCALE_PREFIX_TO_CODE[firstSeg];
    const locale = existing?.locale || prefixLocale || defaultLocale;
    const expectedPrefix = normalizeLocaleCode(locale) !== normalizeLocaleCode(defaultLocale)
        ? getLocaleShortPrefix(locale)
        : '';
    const hasExpectedPrefix = Boolean(expectedPrefix && (normPath === `/${expectedPrefix}` || normPath.startsWith(`/${expectedPrefix}/`)));
    const renderPath = hasExpectedPrefix ? (normPath.slice(expectedPrefix.length + 1) || '/') : normPath;

    const renderResult = await renderDynamicVisitorPage(db, site, renderPath, targetHost, locale, undefined, false, undefined, {
        requestPath: normPath,
        hasExplicitLocalePrefix: hasExpectedPrefix
    });

    const isSpecial404 = normPath === '/404';
    const isSpecial500 = normPath === '/500';
    const isSpecial503 = normPath === '/503' || normPath === '/maintenance';
    const isSpecialRoute = isSpecial404 || isSpecial500 || isSpecial503;

    if (renderResult.status === 404 && !isSpecialRoute) {
        await mutateAndFlushRoutes(db, site.id, [
            db.prepare(`DELETE FROM site_routes WHERE site_id = ? AND path = ?`).bind(site.id, normPath)
        ], false);
        return renderResult;
    }

    const targetStatusCode = isSpecial404 ? 404 : (isSpecial500 ? 500 : (isSpecial503 ? 503 : renderResult.status));

    if (renderResult.html && (targetStatusCode === 200 || targetStatusCode === 301 || targetStatusCode === 302 || isSpecialRoute)) {
        try {
            const upsertStmt = buildUpsertSiteRouteStatement(db, {
                id: existing?.id,
                siteId: site.id,
                path: normPath,
                entityType: renderResult.redirectUrl ? 'redirect' : (renderResult.entityType || existing?.entity_type || 'page'),
                entityId: renderResult.entityId || existing?.entity_id || null,
                locale: existing?.locale || locale,
                translationGroupId: existing?.translation_group_id || null,
                title: renderResult.title || existing?.title || site.name,
                renderedHtml: renderResult.html,
                statusCode: targetStatusCode,
                redirectTarget: renderResult.redirectUrl || null,
                isDirty: 0,
                changefreq: existing?.changefreq || (normPath === '/' ? 'daily' : 'weekly'),
                priority: existing?.priority ?? (normPath === '/' ? 1.0 : (isSpecialRoute ? 0.2 : 0.8)),
                dependencies: Array.isArray(renderResult.dependencies) ? renderResult.dependencies : []
            });
            await mutateAndFlushRoutes(db, site.id, [upsertStmt], false);

            if (isSpecial500) {
                await putSpecialRouteToEdgeCache(site.id, '500', renderResult.html, 500);
            } else if (isSpecial503) {
                await putSpecialRouteToEdgeCache(site.id, '503', renderResult.html, 503);
            }
        } catch (e) {
            console.warn(`[SiteRoutes] Failed to persist compiled HTML for ${normPath}:`, e);
        }
    }

    return { ...renderResult, status: targetStatusCode };
}

export async function fetchNodesForCacheIndexRebuild(
    db: D1Database,
    siteId: string
): Promise<CacheIndexRebuildNodeRow[]> {
    const nowIso = new Date().toISOString();
    const { results } = await db.prepare(`
        SELECT id, slug, NULL as parent_id, 'article' as type, locale, visibility, translation_group_id, title, summary, cover_image_url, metadata, updated_at, published_at
        FROM articles
        WHERE site_id = ? AND status = 'published' AND (visibility = 'public' OR visibility IS NULL) AND (published_at IS NULL OR REPLACE(published_at, ' ', 'T') <= ?) AND deleted_at IS NULL
        UNION ALL
        SELECT id, slug, parent_id, 'page' as type, locale, visibility, COALESCE(NULLIF(translation_group_id, ''), json_extract(metadata, '$.translation_group_id')) as translation_group_id, title, summary, cover_image_url, metadata, updated_at, published_at
        FROM pages
        WHERE site_id = ? AND status = 'published' AND (visibility = 'public' OR visibility IS NULL) AND (published_at IS NULL OR REPLACE(published_at, ' ', 'T') <= ?) AND deleted_at IS NULL
        ORDER BY updated_at DESC
    `).bind(siteId, nowIso, siteId, nowIso).all<CacheIndexRebuildNodeRow>();
    return results || [];
}

export async function getOrBuildSiteCacheIndex(
    db: D1Database,
    _kv?: unknown,
    siteId: string = 'site_default'
): Promise<SiteCacheIndex> {
    try {
        const { results } = await db.prepare(`
            SELECT * FROM site_routes
            WHERE site_id = ? AND entity_type NOT IN ('sitemap', 'redirect')
            ORDER BY priority DESC, updated_at DESC
        `).bind(siteId).all<SiteRouteRow>();

        if (results && results.length > 0) {
            return buildCacheIndexFromRouteRows(results);
        }
    } catch (e) {
        console.warn('[SiteRoutes] Reading site_routes failed, rebuilding:', e);
    }
    return await rebuildFullSiteCacheIndex(db, undefined, siteId);
}

function linkPeerTranslations(indexTable: SiteCacheIndex, tgMap: Map<string, Array<{ locale: string; path: string }>>, tgIdLookup: (p: string) => string | undefined) {
    for (const [p, item] of Object.entries(indexTable)) {
        const tgid = tgIdLookup(p);
        if (tgid) {
            const siblings = (tgMap.get(tgid) || []).filter(s => s.path !== p);
            if (siblings.length) item.translations = siblings;
        }
    }
}

function buildCacheIndexFromRouteRows(rows: SiteRouteRow[]): SiteCacheIndex {
    const indexTable: SiteCacheIndex = {};
    const tgMap = new Map<string, Array<{ locale: string; path: string }>>();
    const rowTgMap = new Map<string, string>();

    for (const row of rows) {
        if (
            ['/sitemap.xml', '/feed.xml', '/feed.json', '/rss.xml', '/en/feed.xml', '/en/feed.json', '/en/rss.xml', '/zh/feed.xml', '/zh/feed.json', '/zh/rss.xml', '/llm.txt', '/llms.txt', '/404', '/500', '/503', '/maintenance'].includes(row.path) ||
            row.entity_type === 'redirect' ||
            row.status_code !== 200
        ) continue;

        indexTable[row.path] = {
            path: row.path,
            version: row.version || 1,
            updated_at: row.updated_at || new Date().toISOString(),
            node_id: row.entity_id || undefined,
            type: row.entity_type,
            title: row.title || 'Untitled',
            locale: row.locale || 'zh-CN',
            images: parseJson<SitemapImageItem[] | undefined>(row.images_json, undefined),
            changefreq: (row.changefreq as SiteCacheEntry['changefreq']) || (row.path === '/' ? 'daily' : 'weekly'),
            priority: row.priority ?? (row.path === '/' ? 1.0 : 0.8)
        };

        if (row.translation_group_id) {
            rowTgMap.set(row.path, row.translation_group_id);
            const list = tgMap.get(row.translation_group_id) || [];
            list.push({ locale: row.locale || 'zh-CN', path: row.path });
            tgMap.set(row.translation_group_id, list);
        }
    }

    linkPeerTranslations(indexTable, tgMap, p => rowTgMap.get(p));
    return indexTable;
}

export async function rebuildFullSiteCacheIndex(
    db: D1Database,
    _kv?: unknown,
    siteId: string = 'site_default'
): Promise<SiteCacheIndex> {
    const site = await findSiteById(db, siteId).catch(() => null);
    const siteDefaultLocale = site?.default_locale || 'zh-CN';
    const results = await fetchNodesForCacheIndexRebuild(db, siteId);
    const existingRowsRes = await db.prepare(`SELECT * FROM site_routes WHERE site_id = ?`).bind(siteId).all<SiteRouteRow>();
    const existingByPath = new Map<string, SiteRouteRow>();
    for (const r of existingRowsRes.results || []) {
        existingByPath.set(r.path, r);
    }

    const resolvePageFullPath = createPageParentPathResolver(results.filter(r => r.type === 'page'));

    const validPaths = new Set<string>(['/sitemap.xml']);
    const batchStmts: D1PreparedStatement[] = [];
    const indexTable: SiteCacheIndex = {};
    const tgMap = new Map<string, Array<{ locale: string; path: string }>>();
    const nodeTgMap = new Map<string, string>();

    for (const row of results) {
        const meta = parseJson<Record<string, any>>(row.metadata, {});
        if (row.type === 'page' && meta.page_type === 'template') continue;
        if (isRestrictedAccess(row.visibility, meta)) continue;

        const parentPath = row.parent_id ? resolvePageFullPath(row.parent_id) : null;
        const bareNormPath = normalizeRoutePath(row.slug, parentPath);
        const nodeLocale = row.locale || siteDefaultLocale;
        const normPath = buildLocalizedRoutePath(bareNormPath, nodeLocale, siteDefaultLocale);
        validPaths.add(normPath);

        const isRedirect = row.type === 'page' && meta.page_type === 'redirect';
        let statusCode = 200;
        if (isRedirect) {
            statusCode = parseInt(meta.redirect_code) || 301;
        } else if (bareNormPath === '/404') {
            statusCode = 404;
        } else if (bareNormPath === '/500') {
            statusCode = 500;
        } else if (bareNormPath === '/503' || bareNormPath === '/maintenance') {
            statusCode = 503;
        }

        const images: SitemapImageItem[] = [];
        if (meta.og_image) images.push({ loc: meta.og_image, title: row.title });
        if (row.cover_image_url) images.push({ loc: row.cover_image_url, title: row.title });

        const existing = existingByPath.get(normPath);
        const keepCompiled = existing && existing.is_dirty === 0 && existing.rendered_html && existing.entity_id === row.id;
        const tgId = row.translation_group_id || meta.translation_group_id || null;

        batchStmts.push(
            buildUpsertSiteRouteStatement(db, {
                id: existing?.id,
                siteId,
                path: normPath,
                entityType: isRedirect ? 'redirect' : row.type,
                entityId: row.id,
                locale: nodeLocale,
                translationGroupId: tgId,
                title: row.title || 'Untitled',
                renderedHtml: keepCompiled ? existing.rendered_html : null,
                statusCode,
                redirectTarget: isRedirect ? (meta.redirect_url || '/') : null,
                isDirty: keepCompiled ? 0 : 1,
                changefreq: bareNormPath === '/' ? 'daily' : 'weekly',
                priority: bareNormPath === '/' ? 1.0 : (row.type === 'article' ? 0.8 : 0.6),
                images,
                templateId: meta.template_id || meta.template_slug || null,
                schemaSlug: meta.schema_slug || null
            })
        );

        // Assemble SiteCacheIndex in memory to avoid a second full-table D1 read.
        if (
            statusCode === 200 &&
            !isRedirect &&
            bareNormPath !== '/404' &&
            bareNormPath !== '/500' &&
            bareNormPath !== '/503' &&
            bareNormPath !== '/maintenance'
        ) {
            if (Array.isArray(meta.aliases)) {
                for (const rawAlias of meta.aliases) {
                    const aliasPath = normalizeRoutePath(String(rawAlias || ''));
                    if (!aliasPath || aliasPath === '/' || aliasPath === normPath || validPaths.has(aliasPath)) continue;
                    validPaths.add(aliasPath);
                    const existingAlias = existingByPath.get(aliasPath);
                    batchStmts.push(
                        buildUpsertSiteRouteStatement(db, {
                            id: existingAlias?.id,
                            siteId,
                            path: aliasPath,
                            entityType: 'redirect',
                            entityId: row.id,
                            locale: nodeLocale,
                            translationGroupId: tgId,
                            title: row.title || 'Untitled',
                            renderedHtml: null,
                            statusCode: 301,
                            redirectTarget: normPath,
                            isDirty: 0
                        })
                    );
                }
            }
            indexTable[normPath] = {
                path: normPath,
                version: (existing?.version || 0) + (keepCompiled ? 0 : 1),
                updated_at: row.updated_at || new Date().toISOString(),
                node_id: row.id,
                type: row.type,
                title: row.title || 'Untitled',
                locale: nodeLocale,
                images: images.length > 0 ? images : undefined,
                changefreq: bareNormPath === '/' ? 'daily' : 'weekly',
                priority: bareNormPath === '/' ? 1.0 : (row.type === 'article' ? 0.8 : 0.6)
            };

            if (tgId) {
                nodeTgMap.set(normPath, tgId);
                const list = tgMap.get(tgId) || [];
                list.push({ locale: nodeLocale, path: normPath });
                tgMap.set(tgId, list);
            }
        }
    }

    for (const [pathKey, row] of existingByPath.entries()) {
        if (!validPaths.has(pathKey) && row.entity_type !== 'sitemap') {
            batchStmts.push(db.prepare(`DELETE FROM site_routes WHERE id = ?`).bind(row.id));
        }
    }

    if (batchStmts.length > 0) {
        await db.batch(batchStmts);
    }

    linkPeerTranslations(indexTable, tgMap, p => nodeTgMap.get(p));

    return indexTable;
}

export async function recompileDirtySiteRoutes(
    db: D1Database,
    siteId: string,
    limit = 25
): Promise<{ compiledCount: number; syncedCount: number; sitemapUpdated: boolean }> {
    let site: Site | null = null;
    try {
        site = await db.prepare(`SELECT * FROM sites WHERE id = ? LIMIT 1`).bind(siteId).first<Site>();
    } catch {
        return { compiledCount: 0, syncedCount: 0, sitemapUpdated: false };
    }
    if (!site) return { compiledCount: 0, syncedCount: 0, sitemapUpdated: false };

    site.settings = parseJson(site.settings, {});

    const index = await rebuildFullSiteCacheIndex(db, undefined, siteId);
    const syncedCount = Object.keys(index).length;

    const dirtyRoutesRes = await db.prepare(`
        SELECT * FROM site_routes
        WHERE site_id = ? AND (is_dirty = 1 OR rendered_html IS NULL) AND entity_type NOT IN ('redirect', 'sitemap')
        ORDER BY priority DESC, updated_at DESC
        LIMIT ?
    `).bind(siteId, limit).all<SiteRouteRow>();

    let compiledCount = 0;
    for (const route of dirtyRoutesRes.results || []) {
        try {
            const res = await compileAndSaveSiteRoute(db, site, route.path, site.primary_domain);
            if (res.status === 200) compiledCount++;
        } catch (e) {
            console.warn(`[SiteRoutes] Failed to recompile dirty route ${route.path}:`, e);
        }
    }

    await rebuildSiteSitemapRoute(db, site, site.primary_domain, index);

    if (compiledCount > 0) {
        await mutateAndFlushRoutes(db, siteId, [], false);
    }

    return { compiledCount, syncedCount, sitemapUpdated: true };
}

export async function assertAliasRoutesAvailable(
    db: D1Database,
    siteId: string,
    aliases: string[],
    currentEntityId?: string | null
): Promise<void> {
    if (!aliases || aliases.length === 0) return;
    const placeholders = aliases.map(() => '?').join(', ');
    const excludeId = currentEntityId || '';
    const conflict = await db.prepare(`
        SELECT path, entity_id, title, entity_type FROM site_routes
        WHERE site_id = ? AND path IN (${placeholders}) AND entity_id IS NOT NULL AND entity_id != ?
        LIMIT 1
    `).bind(siteId, ...aliases, excludeId).first<{ path: string; entity_id: string; title?: string; entity_type?: string }>();
    if (conflict) {
        throw new Error(`Same-site route conflict: alias [${conflict.path}] is already occupied by [${conflict.title || conflict.entity_id}]`);
    }
}

export function buildDeleteOtherSiteRoutesStatement(
    db: D1Database,
    siteId: string,
    entityId: string,
    keepPaths: string | string[]
): D1PreparedStatement {
    const list = Array.isArray(keepPaths) ? Array.from(new Set(keepPaths.filter(Boolean))) : [keepPaths];
    if (list.length === 0) {
        return buildDeleteEntitySiteRoutesStatement(db, siteId, entityId);
    }
    if (list.length === 1) {
        return db.prepare(`DELETE FROM site_routes WHERE site_id = ? AND entity_id = ? AND path != ?`).bind(siteId, entityId, list[0]);
    }
    const ph = list.map(() => '?').join(', ');
    return db.prepare(`DELETE FROM site_routes WHERE site_id = ? AND entity_id = ? AND path NOT IN (${ph})`).bind(siteId, entityId, ...list);
}

export function buildDeleteEntitySiteRoutesStatement(
    db: D1Database,
    siteId: string,
    entityId: string
): D1PreparedStatement {
    return db.prepare(`DELETE FROM site_routes WHERE site_id = ? AND entity_id = ?`).bind(siteId, entityId);
}

export function buildDeleteSiteRouteByPathStatement(
    db: D1Database,
    siteId: string,
    path: string
): D1PreparedStatement {
    return db.prepare(`DELETE FROM site_routes WHERE site_id = ? AND path = ?`).bind(siteId, path);
}

const markRoutesDirty = (db: D1Database, siteId: string, whereClause: string, nowIso = new Date().toISOString()) =>
    db.prepare(`UPDATE site_routes SET is_dirty = 1, rendered_html = NULL, version = version + 1, updated_at = ? WHERE site_id = ? AND ${whereClause}`).bind(nowIso, siteId);

export const buildMarkHomeAndSitemapRoutesDirtyStatement = (db: D1Database, siteId: string, nowIso?: string) =>
    markRoutesDirty(db, siteId, "path IN ('/', '/sitemap.xml', '/feed.xml', '/feed.json', '/rss.xml', '/en/feed.xml', '/en/feed.json', '/en/rss.xml', '/zh/feed.xml', '/zh/feed.json', '/zh/rss.xml', '/llm.txt', '/llms.txt')", nowIso);

export const buildMarkSitemapRouteDirtyStatement = (db: D1Database, siteId: string, nowIso?: string) =>
    markRoutesDirty(db, siteId, "path IN ('/sitemap.xml', '/feed.xml', '/feed.json', '/rss.xml', '/en/feed.xml', '/en/feed.json', '/en/rss.xml', '/zh/feed.xml', '/zh/feed.json', '/zh/rss.xml', '/llm.txt', '/llms.txt')", nowIso);

export const buildMarkAllNonRedirectSiteRoutesDirtyStatement = (db: D1Database, siteId: string, nowIso?: string) =>
    markRoutesDirty(db, siteId, "entity_type NOT IN ('redirect')", nowIso);

// Sibling translation pages/articles render bidirectional hreflang and switcher links,
// so adding, updating, unpublishing, or deleting one locale must dirty its siblings' cached HTML.
export async function markTranslationGroupPeersDirty(
    db: D1Database,
    siteId: string,
    entityId: string,
    explicitTgId?: string | string[] | null
): Promise<string[]> {
    const tgIds = new Set<string>();
    if (Array.isArray(explicitTgId)) {
        explicitTgId.map(v => String(v || '').trim()).filter(Boolean).forEach(v => tgIds.add(v));
    } else if (explicitTgId) {
        tgIds.add(String(explicitTgId).trim());
    }
    if (tgIds.size === 0) {
        const [selfRoute, selfArt, selfPage] = await db.batch([
            db.prepare(`SELECT translation_group_id FROM site_routes WHERE site_id = ? AND entity_id = ? AND translation_group_id IS NOT NULL LIMIT 1`).bind(siteId, entityId),
            db.prepare(`SELECT translation_group_id FROM articles WHERE id = ? AND site_id = ? LIMIT 1`).bind(entityId, siteId),
            db.prepare(`SELECT COALESCE(NULLIF(translation_group_id, ''), json_extract(metadata, '$.translation_group_id')) as translation_group_id FROM pages WHERE id = ? AND site_id = ? LIMIT 1`).bind(entityId, siteId)
        ]);
        for (const res of [selfRoute, selfArt, selfPage]) {
            const val = String((res?.results?.[0] as any)?.translation_group_id || '').trim();
            if (val) tgIds.add(val);
        }
    }
    const tgList = Array.from(tgIds);
    if (tgList.length === 0) return [];

    const ph = tgList.map(() => '?').join(', ');
    const { results } = await db.prepare(
        `SELECT path FROM site_routes WHERE site_id = ? AND translation_group_id IN (${ph}) AND (entity_id IS NULL OR entity_id != ?)`
    ).bind(siteId, ...tgList, entityId).all<{ path: string }>();

    const peerPaths = Array.from(new Set((results || []).map(r => r.path).filter(Boolean)));
    if (peerPaths.length > 0) {
        await markSiteRoutesDirty(db, siteId, peerPaths);
    }
    return peerPaths;
}

export function buildTouchSiteUpdatedAtStatement(
    db: D1Database,
    siteId: string,
    nowIso: string = new Date().toISOString()
): D1PreparedStatement {
    return db.prepare(`UPDATE sites SET updated_at = ? WHERE id = ?`).bind(nowIso, siteId);
}
