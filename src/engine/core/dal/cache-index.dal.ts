import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { Site } from '../../types';
import { renderDynamicVisitorPage } from '../../render';
import { invalidateSiteMemoryCache, findSiteById } from './sites.dal';
import { isLocalHost } from '../url';
import { t } from '../i18n';
import { buildAbsoluteUrl, resolveBaseUrl, DEFAULT_DEV_HOST, resolveEffectiveDomain } from '../url';
import { parseJson, escapeXml } from '../utils';

export interface CacheIndexRebuildNodeRow {
    id: string;
    slug: string;
    parent_id?: string | null;
    type: string;
    locale: string;
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

export interface SpecialRouteCheckResult {
    normPath: string;
    level: 'none' | 'warning' | 'forbidden';
    code?: 'HOME_INDEX' | 'CUSTOM_404' | 'CUSTOM_500' | 'CUSTOM_503' | 'RESERVED_SYSTEM';
    message?: string;
}

export function normalizeRoutePath(rawSlugOrPath?: string | null, parentSlugOrPath?: string | null): string {
    const rawWithoutQuery = (rawSlugOrPath || '').trim().split('?')[0].split('#')[0];
    const cleaned = rawWithoutQuery.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');

    if (parentSlugOrPath) {
        const cleanParent = parentSlugOrPath.trim().split('?')[0].split('#')[0].replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
        if (cleanParent && cleanParent !== 'index') {
            if (!cleaned || cleaned === 'index') {
                return `/${cleanParent}`;
            }
            return `/${cleanParent}/${cleaned}`;
        }
    }

    if (!cleaned || cleaned === 'index') {
        return '/';
    }
    return `/${cleaned}`;
}

const FORBIDDEN_PREFIXES = new Set(['admin', 'api', 'shared', 'assets', 'content', 'theme', 'commercial', 'cdn-cgi', '.well-known']);

export function inspectSpecialRoute(
    rawSlugOrPath?: string | null,
    parentSlugOrPath?: string | null,
    locale: string = 'zh-CN'
): SpecialRouteCheckResult {
    const rawTrimmed = (rawSlugOrPath || '').trim();
    const normPath = normalizeRoutePath(rawTrimmed, parentSlugOrPath);
    const lowerPath = normPath.toLowerCase();
    const firstSegment = lowerPath.replace(/^\/+/, '').split('/')[0] || '';

    if (['/zh-cn', '/en-us'].includes(lowerPath)) {
        return { normPath, level: 'forbidden', code: 'RESERVED_SYSTEM', message: t(locale, 'common.route_forbidden_locale', { path: lowerPath === '/zh-cn' ? '/zh-CN' : '/en-US' }) };
    }
    const exactName = { '/sitemap.xml': 'sitemap', '/robots.txt': 'robots', '/favicon.ico': 'favicon', '/app.css': 'appcss' }[lowerPath];
    if (exactName) {
        return { normPath, level: 'forbidden', code: 'RESERVED_SYSTEM', message: t(locale, `common.route_forbidden_${exactName}`) };
    }
    if (FORBIDDEN_PREFIXES.has(firstSegment)) {
        return { normPath, level: 'forbidden', code: 'RESERVED_SYSTEM', message: t(locale, `common.route_forbidden_${firstSegment.replace(/[^a-z0-9]/g, '')}`) };
    }

    if (normPath === '/') {
        const isRawIndex = rawTrimmed.replace(/^\/+|\/+$/g, '').toLowerCase() === 'index';
        return {
            normPath: '/',
            level: 'warning',
            code: 'HOME_INDEX',
            message: isRawIndex ? t(locale, 'common.route_warn_home_index') : t(locale, 'common.route_warn_home_root')
        };
    }

    if (lowerPath === '/404') return { normPath: '/404', level: 'warning', code: 'CUSTOM_404', message: t(locale, 'common.route_warn_404') };
    if (lowerPath === '/500') return { normPath: '/500', level: 'warning', code: 'CUSTOM_500', message: t(locale, 'common.route_warn_500') };
    if (lowerPath === '/503' || lowerPath === '/maintenance') return { normPath, level: 'warning', code: 'CUSTOM_503', message: t(locale, 'common.route_warn_503', { path: normPath }) };

    return { normPath, level: 'none' };
}

export function buildSpecialRouteCacheRequest(siteId: string, routeKey: '500' | '503'): Request {
    return new Request(`https://walnut-special-cache.internal/${siteId}/${routeKey}`, { method: 'GET' });
}

export async function putSpecialRouteToEdgeCache(
    siteId: string,
    routeKey: '500' | '503',
    html: string,
    statusCode: number,
    executionCtx?: any
): Promise<void> {
    const edgeCache: Cache | undefined = (globalThis as any).caches?.default;
    if (!edgeCache || !html) return;

    const cacheReq = buildSpecialRouteCacheRequest(siteId, routeKey);
    const headers = new Headers({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000, s-maxage=31536000',
        'X-Walnut-Special-Cache': 'HIT',
        'X-Walnut-Status': String(statusCode)
    });
    const putPromise = edgeCache.put(cacheReq, new Response(html, { status: statusCode, headers })).catch(() => {});
    if (executionCtx && typeof executionCtx.waitUntil === 'function') {
        executionCtx.waitUntil(putPromise);
    } else {
        await putPromise;
    }
}

export async function matchSpecialRouteFromEdgeCache(
    siteId: string,
    routeKey: '500' | '503'
): Promise<{ html: string; status: number } | null> {
    const edgeCache: Cache | undefined = (globalThis as any).caches?.default;
    if (!edgeCache || !siteId) return null;
    try {
        const hit = await edgeCache.match(buildSpecialRouteCacheRequest(siteId, routeKey));
        if (hit) {
            const html = await hit.text();
            if (html && html.length > 20) {
                return { html, status: hit.status || (routeKey === '500' ? 500 : 503) };
            }
        }
    } catch {}
    return null;
}

export function renderFallbackErrorHtml(statusCode: 404 | 500 | 503, siteName = 'Content Management System', locale = 'zh-CN'): string {
    const c = statusCode === 404
        ? { t: '404 - Not Found', s: 'The requested page could not be found or has been unpublished.', col: 'text-amber-500' }
        : statusCode === 503
            ? { t: '503 - Service Unavailable', s: 'The site is currently undergoing scheduled maintenance. Please check back shortly.', col: 'text-indigo-500' }
            : { t: '500 - Internal Server Error', s: 'The server encountered an error while processing your request. Please try again later.', col: 'text-rose-500' };
    return `<!DOCTYPE html><html lang="${locale}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${c.t} - ${siteName}</title><link rel="stylesheet" href="/shared/app.css" /></head><body class="bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 min-h-screen flex items-center justify-center p-6 text-center font-sans antialiased"><div class="max-w-md w-full space-y-4 bg-white dark:bg-slate-900 p-8 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm"><h1 class="text-5xl font-black ${c.col} tracking-tight">${statusCode}</h1><h2 class="text-lg font-bold text-slate-900 dark:text-white">${c.t}</h2><p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">${c.s}</p><div class="pt-3"><a href="/" class="inline-block bg-slate-900 hover:bg-slate-800 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white px-5 py-2.5 rounded-xl text-xs font-bold shadow-sm transition">&larr; Return Home</a></div></div></body></html>`;
}

// Single UNION query enforces cross-table route uniqueness in one D1 round-trip.
export async function assertSiteRouteUnique(
    db: D1Database,
    siteId: string,
    rawPath: string,
    currentEntityId?: string | null,
    locale: string = 'zh-CN'
): Promise<string> {
    const specialCheck = inspectSpecialRoute(rawPath, null, locale);
    if (specialCheck.level === 'forbidden') {
        throw new Error(specialCheck.message || t(locale, 'common.error'));
    }

    const normPath = specialCheck.normPath;
    const excludeId = currentEntityId || '';
    const bareSlug = normPath === '/' ? '' : normPath.slice(1);
    const slugCandidates = normPath === '/' ? ['/', 'index'] : [bareSlug, normPath];
    const placeholders = slugCandidates.map(() => '?').join(', ');

    const conflict = await db.prepare(`
        SELECT id, title, entity_type as type FROM site_routes
        WHERE site_id = ? AND path = ? AND entity_id IS NOT NULL AND entity_id != ?
        UNION ALL
        SELECT id, title, 'article' as type FROM articles
        WHERE site_id = ? AND id != ? AND slug IN (${placeholders}) AND deleted_at IS NULL
        UNION ALL
        SELECT id, title, 'page' as type FROM pages
        WHERE site_id = ? AND id != ? AND slug IN (${placeholders}) AND deleted_at IS NULL
          AND (metadata NOT LIKE '%"page_type":"template"%' OR metadata IS NULL)
        LIMIT 1
    `).bind(
        siteId, normPath, excludeId,
        siteId, excludeId, ...slugCandidates,
        siteId, excludeId, ...slugCandidates
    ).first<{ id: string; title: string; type: string }>();

    if (conflict) {
        const typeLabel = conflict.type === 'article' ? 'article' : (conflict.type === 'page' ? 'page' : 'route');
        throw new Error(
            `Same-site route conflict: path [${normPath}] is already occupied by ${typeLabel} [${conflict.title || conflict.id}], please change Slug`
        );
    }

    return normPath;
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
    paths?: string[]
): Promise<void> {
    const edgeCache: Cache | undefined = (globalThis as any).caches?.default;
    const basePaths = (paths && paths.length > 0 ? paths : ['/']).map(p => (p === '/sitemap.xml' ? '/sitemap.xml' : normalizeRoutePath(p)));
    const expandedPaths = new Set<string>(basePaths);
    for (const p of basePaths) {
        if (p === '/sitemap.xml' || p === '/feed.xml' || p === '/feed.json' || p === '/robots.txt') continue;
        for (const pref of ['/en', '/en-US', '/zh', '/zh-CN']) {
            expandedPaths.add(p === '/' ? pref : `${pref}${p}`);
        }
    }
    const targetPaths = Array.from(expandedPaths);
    const site = await findSiteById(db, siteId).catch(() => null);
    const rawDomain = (site?.primary_domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    const origins: string[] = ['http://localhost:8787'];
    if (rawDomain && rawDomain !== '*') {
        const proto = isLocalHost(rawDomain) ? 'http' : 'https';
        origins.push(`${proto}://${rawDomain}`);
    }
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
    const siteSettings = parseJson<Record<string, any>>(site?.settings, {});
    const zoneId = cfEnv?.CF_ZONE_ID || siteSettings.cf_zone_id;
    const apiToken = cfEnv?.CF_API_TOKEN || siteSettings.cf_api_token;
    if (zoneId && apiToken && rawDomain && rawDomain !== '*' && !isLocalHost(rawDomain) && purgeUrls.length > 0) {
        const zoneFiles = purgeUrls.filter(u => !u.startsWith('http://localhost')).slice(0, 30);
        if (zoneFiles.length > 0) {
            await fetch(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ files: zoneFiles })
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
    paths?: string[]
): Promise<void> {
    const nowIso = new Date().toISOString();
    let purgePaths = paths;
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
        try {
            const allRows = await db.prepare(`SELECT path FROM site_routes WHERE site_id = ? LIMIT 100`).bind(siteId).all<{ path: string }>();
            if (allRows.results && allRows.results.length > 0) {
                purgePaths = allRows.results.map(r => r.path);
            }
        } catch {}
        stmt = db.prepare(`
            UPDATE site_routes
            SET is_dirty = 1, rendered_html = NULL, version = version + 1, updated_at = ?
            WHERE site_id = ?
        `).bind(nowIso, siteId);
    }
    await mutateAndFlushRoutes(db, siteId, [stmt], false);
    await purgeEdgeAndZoneCache(db, siteId, purgePaths);
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

export async function compileAndSaveSiteRoute(
    db: D1Database,
    site: Site,
    rawPath: string,
    host?: string
): Promise<{ html: string; status: number; redirectUrl?: string }> {
    const normPath = normalizeRoutePath(rawPath);
    const targetHost = resolveEffectiveDomain(site.primary_domain, host);
    const locale = site.default_locale || 'zh-CN';

    const renderResult = await renderDynamicVisitorPage(db, site, normPath, targetHost, locale, undefined);

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
            const existing = await findSiteRouteByPath(db, site.id, normPath);
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
                dependencies: renderResult.dependencies?.length ? renderResult.dependencies : undefined
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
    const { results } = await db.prepare(`
        SELECT id, slug, NULL as parent_id, 'article' as type, locale, translation_group_id, title, summary, cover_image_url, metadata, updated_at, published_at
        FROM articles
        WHERE site_id = ? AND status = 'published' AND (visibility = 'public' OR visibility IS NULL) AND deleted_at IS NULL
        UNION ALL
        SELECT id, slug, parent_id, 'page' as type, locale, NULL as translation_group_id, title, summary, cover_image_url, metadata, updated_at, published_at
        FROM pages
        WHERE site_id = ? AND status = 'published' AND (visibility = 'public' OR visibility IS NULL) AND deleted_at IS NULL
        ORDER BY updated_at DESC
    `).bind(siteId, siteId).all<CacheIndexRebuildNodeRow>();
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
            ['/sitemap.xml', '/404', '/500', '/503', '/maintenance'].includes(row.path) ||
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
    const results = await fetchNodesForCacheIndexRebuild(db, siteId);
    const existingRowsRes = await db.prepare(`SELECT * FROM site_routes WHERE site_id = ?`).bind(siteId).all<SiteRouteRow>();
    const existingByPath = new Map<string, SiteRouteRow>();
    for (const r of existingRowsRes.results || []) {
        existingByPath.set(r.path, r);
    }

    const pageMap = new Map<string, { slug: string; parent_id?: string | null }>();
    for (const row of results) {
        if (row.type === 'page') {
            pageMap.set(row.id, { slug: row.slug, parent_id: row.parent_id });
        }
    }

    const memoFullPath = new Map<string, string>();
    function resolvePageFullPath(pageId: string, visited = new Set<string>()): string {
        if (memoFullPath.has(pageId)) return memoFullPath.get(pageId)!;
        if (visited.has(pageId)) return '';
        visited.add(pageId);

        const page = pageMap.get(pageId);
        if (!page) return '';
        const cleanSlug = (page.slug || '').replace(/^\/+|\/+$/g, '');
        if (!page.parent_id) {
            memoFullPath.set(pageId, cleanSlug);
            return cleanSlug;
        }

        const parentPath = resolvePageFullPath(page.parent_id, visited);
        const full = parentPath ? `${parentPath}/${cleanSlug}` : cleanSlug;
        memoFullPath.set(pageId, full);
        return full;
    }

    const validPaths = new Set<string>(['/sitemap.xml']);
    const batchStmts: D1PreparedStatement[] = [];
    const indexTable: SiteCacheIndex = {};
    const tgMap = new Map<string, Array<{ locale: string; path: string }>>();
    const nodeTgMap = new Map<string, string>();

    for (const row of results) {
        const meta = parseJson<Record<string, any>>(row.metadata, {});
        if (row.type === 'page' && meta.page_type === 'template') continue;

        const parentPath = row.parent_id ? resolvePageFullPath(row.parent_id) : null;
        const normPath = normalizeRoutePath(row.slug, parentPath);
        validPaths.add(normPath);

        const isRedirect = row.type === 'page' && meta.page_type === 'redirect';
        let statusCode = 200;
        if (isRedirect) {
            statusCode = parseInt(meta.redirect_code) || 301;
        } else if (normPath === '/404') {
            statusCode = 404;
        } else if (normPath === '/500') {
            statusCode = 500;
        } else if (normPath === '/503' || normPath === '/maintenance') {
            statusCode = 503;
        }

        const images: SitemapImageItem[] = [];
        if (meta.og_image) images.push({ loc: meta.og_image, title: row.title });
        if (row.cover_image_url) images.push({ loc: row.cover_image_url, title: row.title });

        const existing = existingByPath.get(normPath);
        const keepCompiled = existing && existing.is_dirty === 0 && existing.rendered_html && existing.entity_id === row.id;

        batchStmts.push(
            buildUpsertSiteRouteStatement(db, {
                id: existing?.id,
                siteId,
                path: normPath,
                entityType: isRedirect ? 'redirect' : row.type,
                entityId: row.id,
                locale: row.locale || 'zh-CN',
                translationGroupId: row.translation_group_id || null,
                title: row.title || 'Untitled',
                renderedHtml: keepCompiled ? existing.rendered_html : null,
                statusCode,
                redirectTarget: isRedirect ? (meta.redirect_url || '/') : null,
                isDirty: keepCompiled ? 0 : 1,
                changefreq: normPath === '/' ? 'daily' : 'weekly',
                priority: normPath === '/' ? 1.0 : (row.type === 'article' ? 0.8 : 0.6),
                images,
                templateId: meta.template_id || meta.template_slug || null,
                schemaSlug: meta.schema_slug || null
            })
        );

        // Assemble SiteCacheIndex in memory to avoid a second full-table D1 read.
        if (
            statusCode === 200 &&
            !isRedirect &&
            normPath !== '/404' &&
            normPath !== '/500' &&
            normPath !== '/503' &&
            normPath !== '/maintenance'
        ) {
            indexTable[normPath] = {
                path: normPath,
                version: (existing?.version || 0) + (keepCompiled ? 0 : 1),
                updated_at: row.updated_at || new Date().toISOString(),
                node_id: row.id,
                type: row.type,
                title: row.title || 'Untitled',
                locale: row.locale || 'zh-CN',
                images: images.length > 0 ? images : undefined,
                changefreq: normPath === '/' ? 'daily' : 'weekly',
                priority: normPath === '/' ? 1.0 : (row.type === 'article' ? 0.8 : 0.6)
            };

            if (row.translation_group_id) {
                nodeTgMap.set(normPath, row.translation_group_id);
                const list = tgMap.get(row.translation_group_id) || [];
                list.push({ locale: row.locale || 'zh-CN', path: normPath });
                tgMap.set(row.translation_group_id, list);
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

export async function rebuildSiteSitemapRoute(
    db: D1Database,
    site: Site,
    host?: string,
    existingIndex?: SiteCacheIndex
): Promise<string> {
    const index = existingIndex || await getOrBuildSiteCacheIndex(db, undefined, site.id);
    const targetHost = resolveEffectiveDomain(site.primary_domain, host);
    const xml = renderRichSitemapXml(index, site, targetHost);

    const upsertSitemapStmt = buildUpsertSiteRouteStatement(db, {
        id: `sr_${site.id}_sitemap`,
        siteId: site.id,
        path: '/sitemap.xml',
        entityType: 'sitemap',
        entityId: 'sitemap',
        locale: site.default_locale || 'zh-CN',
        title: 'Sitemap XML',
        renderedHtml: xml,
        statusCode: 200,
        isDirty: 0,
        changefreq: 'daily',
        priority: 1.0
    });

    await upsertSitemapStmt.run();
    return xml;
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

export function renderRichSitemapXml(
    index: SiteCacheIndex,
    site: Site,
    host: string
): string {
    const domain = resolveEffectiveDomain(site.primary_domain, host);
    const entries = Object.values(index);
    const xmlUrlNodes: string[] = [];

    for (const item of entries) {
        if (item.path === '/sitemap.xml') continue;
        const normPath = normalizeRoutePath(item.path);
        const loc = buildAbsoluteUrl(normPath, domain);
        const lastmod = item.updated_at ? item.updated_at.split('T')[0].split(' ')[0] : new Date().toISOString().split('T')[0];
        const changefreq = item.changefreq || 'weekly';
        const priority = (item.priority !== undefined ? item.priority : 0.8).toFixed(1);

        const xhtmlLinks = (item.translations && item.translations.length > 0)
            ? [`    <xhtml:link rel="alternate" hreflang="${item.locale || 'x-default'}" href="${loc}" />`, ...item.translations.map(t => `    <xhtml:link rel="alternate" hreflang="${t.locale}" href="${buildAbsoluteUrl(normalizeRoutePath(t.path), domain)}" />`)]
            : [];

        const imageNodes = (item.images || []).map(img =>
            `    <image:image>\n      <image:loc>${escapeXml(buildAbsoluteUrl(img.loc, domain))}</image:loc>${img.title ? `\n      <image:title>${escapeXml(img.title)}</image:title>` : ''}\n    </image:image>`
        );

        xmlUrlNodes.push(`  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n${xhtmlLinks.join('\n')}${imageNodes.length ? (xhtmlLinks.length ? '\n' : '') + imageNodes.join('\n') : ''}\n  </url>`);
    }

    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n        xmlns:xhtml="http://www.w3.org/1999/xhtml"\n        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${xmlUrlNodes.join('\n')}\n</urlset>`.trim();
}

export function buildDeleteOtherSiteRoutesStatement(
    db: D1Database,
    siteId: string,
    entityId: string,
    keepPath: string
): D1PreparedStatement {
    return db.prepare(`DELETE FROM site_routes WHERE site_id = ? AND entity_id = ? AND path != ?`).bind(siteId, entityId, keepPath);
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
    markRoutesDirty(db, siteId, "path IN ('/', '/sitemap.xml', '/feed.xml', '/feed.json')", nowIso);

export const buildMarkSitemapRouteDirtyStatement = (db: D1Database, siteId: string, nowIso?: string) =>
    markRoutesDirty(db, siteId, "path IN ('/sitemap.xml', '/feed.xml', '/feed.json')", nowIso);

export async function rebuildSiteFeedRoute(
    db: D1Database,
    site: Site,
    host: string,
    format: 'xml' | 'json'
): Promise<string> {
    const domain = resolveEffectiveDomain(site.primary_domain, host);
    const siteUrl = buildAbsoluteUrl('/', domain);
    const feedPath = format === 'xml' ? '/feed.xml' : '/feed.json';
    const feedUrl = buildAbsoluteUrl(feedPath, domain);

    const { results } = await db.prepare(`
        SELECT id, slug, title, summary, published_at, updated_at
        FROM articles
        WHERE site_id = ? AND status = 'published' AND deleted_at IS NULL
        ORDER BY COALESCE(published_at, updated_at) DESC
        LIMIT 30
    `).bind(site.id).all<{ id: string; slug: string; title: string; summary: string; published_at: string; updated_at: string }>();

    const items = results || [];
    let body = '';
    if (format === 'json') {
        body = JSON.stringify({
            version: 'https://jsonfeed.org/version/1.1',
            title: site.name || 'Walnut CMS',
            home_page_url: siteUrl,
            feed_url: feedUrl,
            items: items.map(it => ({
                id: it.id,
                url: buildAbsoluteUrl(`/${String(it.slug || '').replace(/^\/+/, '')}`, domain),
                title: it.title || '',
                summary: it.summary || '',
                date_published: it.published_at || it.updated_at
            }))
        }, null, 2);
    } else {
        const rssItems = items.map(it => {
            const link = buildAbsoluteUrl(`/${String(it.slug || '').replace(/^\/+/, '')}`, domain);
            return `<item><title>${escapeXml(it.title)}</title><link>${escapeXml(link)}</link><guid>${escapeXml(link)}</guid><pubDate>${new Date(it.published_at || it.updated_at || Date.now()).toUTCString()}</pubDate><description>${escapeXml(it.summary || '')}</description></item>`;
        }).join('');
        const siteDesc = (site as any)?.settings?.site_description || (site as any)?.settings?.description || '';
        body = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${escapeXml(site.name || 'Walnut CMS')}</title><link>${escapeXml(siteUrl)}</link><description>${escapeXml(siteDesc)}</description>${rssItems}</channel></rss>`;
    }

    try {
        await buildUpsertSiteRouteStatement(db, {
            siteId: site.id,
            path: feedPath,
            entityType: 'page',
            title: format === 'xml' ? 'RSS Feed' : 'JSON Feed',
            renderedHtml: body,
            statusCode: 200,
            isDirty: 0,
            changefreq: 'hourly',
            priority: 0.3
        }).run();
    } catch {}
    return body;
}

export const buildMarkAllNonRedirectSiteRoutesDirtyStatement = (db: D1Database, siteId: string, nowIso?: string) =>
    markRoutesDirty(db, siteId, "entity_type NOT IN ('redirect')", nowIso);

export function buildTouchSiteUpdatedAtStatement(
    db: D1Database,
    siteId: string,
    nowIso: string = new Date().toISOString()
): D1PreparedStatement {
    return db.prepare(`UPDATE sites SET updated_at = ? WHERE id = ?`).bind(nowIso, siteId);
}
