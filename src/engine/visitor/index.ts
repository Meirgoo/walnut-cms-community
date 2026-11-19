import { Hono } from 'hono';
import type { AppHonoEnv, Site } from '../types';
import { getCookie } from 'hono/cookie';
import {
    resolveSiteWithMemoryCache,
    resolveSiteBrandInfo,
    normalizeRoutePath,
    findSiteRouteByPath,
    findSiteById,
    buildUpsertSiteRouteStatement,
    buildDeleteSiteRouteByPathStatement,
    rebuildSiteSitemapRoute,
    rebuildSiteFeedRoute,
    isSystemInstalled,
    matchSpecialRouteFromEdgeCache,
    renderFallbackErrorHtml
} from '../core/dal';
import { getSessionUserId } from '../core/auth';
import { DEFAULT_DEV_HOST, buildAbsoluteUrl, resolveEffectiveDomain, normalizeHostKey, isLocalHost } from '../core/url';
import { loadAdminLocales } from '../core/i18n';
import { parseJson, isPreviewRequest, getCookieValue } from '../core/utils';

const visitorApp = new Hono<AppHonoEnv>();

const VISITOR_CSP_HEADER =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: https: blob:; connect-src 'self'; frame-ancestors 'self';";

function sanitizeHeaderBrand(raw: string | undefined, fallback: string, isWhitelabel: boolean): string {
    const ascii = String(raw || '')
        .replace(/©/g, 'Copyright')
        .replace(/[^\x20-\x7E]/g, '')
        .trim();
    if (ascii) return ascii;
    return isWhitelabel ? '' : fallback;
}

function makeVisitorHeaders(
    provider: string,
    copyright: string,
    cacheTag: string,
    extra: Record<string, string> = {},
    isWhitelabel = false
): Headers {
    const safeProvider = sanitizeHeaderBrand(provider, 'Walnut CMS', isWhitelabel);
    const safeCopyright = sanitizeHeaderBrand(copyright, 'Copyright Walnut CMS', isWhitelabel);
    const base: Record<string, string> = {
        'X-Edge-Cache': cacheTag,
        ...extra
    };
    if (safeProvider) base['X-Provider'] = safeProvider;
    if (safeCopyright) base['X-Copyright'] = safeCopyright;
    return new Headers(base);
}

function makeHtmlHeaders(
    provider: string,
    copyright: string,
    cacheTag: string,
    etag: string,
    ver: string | number,
    bypassCache = false,
    isWhitelabel = false
): Headers {
    return makeVisitorHeaders(provider, copyright, cacheTag, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': bypassCache ? 'private, no-store, no-cache, must-revalidate' : 'public, max-age=0, s-maxage=60, stale-while-revalidate=86400',
        'ETag': etag,
        'Content-Security-Policy': VISITOR_CSP_HEADER,
        'X-Route-Version': String(ver)
    }, isWhitelabel);
}

const EDGE_SWR_FRESH_MS = 15_000;
const EDGE_SWR_GRACE_MS = 86_400_000;

function cloneForEdgeCache(res: Response): Response {
    const h = new Headers(res.headers);
    h.set('X-Edge-Cached-At', String(Date.now()));
    return new Response(res.body, { status: res.status, headers: h });
}

export async function handleSpecialRouteFallback(c: any, site: Site | undefined, code: 500 | 503, locale: string, _executionCtx: any, db?: any): Promise<Response> {
    const sId = site?.id;
    if (sId) {
        try {
            const edgeRes = await matchSpecialRouteFromEdgeCache(sId, String(code) as '500' | '503');
            if (edgeRes) return c.html(edgeRes.html, edgeRes.status as any);
        } catch {}
    }
    if (sId && db) {
        try {
            const route = await findSiteRouteByPath(db, sId, `/${code}`) || (code === 503 ? await findSiteRouteByPath(db, sId, '/maintenance') : null);
            if (route?.rendered_html) {
                return c.html(route.rendered_html, code);
            }
        } catch {}
    }
    return c.html(renderFallbackErrorHtml(code, site?.name, locale), code);
}

visitorApp.get('/*', async (c) => {
    let executionCtx: any;
    try { executionCtx = c.executionCtx; } catch { executionCtx = undefined; }

    const db = c.env.DB;
    const host = c.get('host') || DEFAULT_DEV_HOST;
    const locale = c.get('locale') || 'zh-CN';
    const timing = c.get('serverTiming' as any) as any;
    const isPreview = isPreviewRequest(c);
    const user = isPreview ? undefined : c.get('user');
    if (isPreview) {
        c.header('X-Preview-Mode', '1');
    }

    const reqUrl = new URL(c.req.url);
    const knownOrigins: Set<string> = ((globalThis as any).__WALNUT_KNOWN_ORIGINS__ ||= new Set<string>());
    if (knownOrigins.size < 20 && reqUrl.origin) {
        knownOrigins.add(reqUrl.origin);
    }
    const rawPathname = c.get('actualPath') || reqUrl.pathname || '/';
    const isSitemapReq = rawPathname === '/sitemap.xml' || rawPathname === 'sitemap.xml';
    const isFeedXmlReq = rawPathname === '/feed.xml' || rawPathname === 'feed.xml';
    const isFeedJsonReq = rawPathname === '/feed.json' || rawPathname === 'feed.json';
    const isRobotsReq = rawPathname === '/robots.txt' || rawPathname === 'robots.txt';
    const normPath = isSitemapReq
        ? '/sitemap.xml'
        : isFeedXmlReq
            ? '/feed.xml'
            : isFeedJsonReq
                ? '/feed.json'
                : (isRobotsReq ? '/robots.txt' : normalizeRoutePath(rawPathname));

    const cookieHeader = c.req.header('cookie') || '';
    const sessionToken = getCookieValue(cookieHeader, 'walnut_session');
    const hasValidSessionShape = Boolean(sessionToken && sessionToken.length >= 16);
    const hasCfAccess = Boolean((c.env as any)?.CF_ACCESS_TEAM_NAME && (c.req.header('cf-access-jwt-assertion') || c.req.header('Cf-Access-Jwt-Assertion')));
    const cacheCtrlHeader = (c.req.header('cache-control') || '').toLowerCase();
    const bypassEdgeCache = isPreview
        || Boolean(user)
        || hasValidSessionShape
        || hasCfAccess
        || cacheCtrlHeader.includes('no-cache');

    const edgeCache: Cache | undefined = (globalThis as any).caches?.default;
    const edgeKeyPath = normalizeRoutePath(reqUrl.pathname);
    const edgeCacheKey = new Request(`${reqUrl.origin}${edgeKeyPath}`, { method: 'GET' });
    const isDefaultLocalePath = edgeKeyPath === normPath;

    // Serve anonymous GET requests from caches.default with 15s SWR to bypass cross-region D1 queries on hot paths.
    if (!bypassEdgeCache && !isSitemapReq && !isFeedXmlReq && !isFeedJsonReq && !isRobotsReq && edgeCache) {
        const tEdgeStart = performance.now();
        try {
            const edgeHit = await edgeCache.match(edgeCacheKey);
            if (edgeHit) {
                const cachedAt = Number(edgeHit.headers.get('X-Edge-Cached-At') || '0');
                const ageMs = cachedAt > 0 ? Math.max(0, Date.now() - cachedAt) : 0;
                if (ageMs <= EDGE_SWR_GRACE_MS) {
                    const isStale = ageMs > EDGE_SWR_FRESH_MS;
                    const edgeHeaders = new Headers(edgeHit.headers);
                    edgeHeaders.delete('X-Edge-Cached-At');
                    edgeHeaders.set('X-Edge-Cache', isStale ? 'EDGE-STALE' : 'EDGE-HIT');
                    if (timing?.add) timing.add('edge', performance.now() - tEdgeStart);

                    const ifNoneMatchEdge = c.req.header('if-none-match');
                    const edgeEtag = edgeHeaders.get('ETag');
                    if (ifNoneMatchEdge && edgeEtag) {
                        const verIdx = edgeEtag.lastIndexOf('_');
                        const edgeVerPrefix = verIdx > 0 ? edgeEtag.slice(0, verIdx) : edgeEtag;
                        if (ifNoneMatchEdge === edgeEtag || ifNoneMatchEdge.startsWith(edgeVerPrefix)) {
                            edgeHeaders.set('X-Edge-Cache', 'HIT-304-VERSION');
                            return new Response(null, { status: 304, headers: edgeHeaders });
                        }
                    }

                    if (isStale && db && executionCtx?.waitUntil) {
                        executionCtx.waitUntil(
                            (async () => {
                                try {
                                    const bgSite = await resolveSiteWithMemoryCache(db, host);
                                    if (!bgSite) return;
                                    bgSite.settings = parseJson<Record<string, any>>(bgSite.settings, {});
                                    const bgBrand = resolveSiteBrandInfo(bgSite);
                                    const bgIsWl = Boolean(bgBrand.hasStickyWhitelabel || bgBrand.hidePoweredBy);
                                    const bgRoute = await findSiteRouteByPath(db, bgSite.id, normPath);
                                    if (bgRoute && bgRoute.is_dirty === 0 && bgRoute.rendered_html) {
                                        const bgVer = `v${bgRoute.version || 1}_${String(bgRoute.updated_at || bgSite.updated_at || '1').replace(/\s+/g, '_')}`;
                                        const bgEtag = `W/"${bgSite.id}-${normPath}-${bgVer}"`;
                                        const bgRes = new Response(bgRoute.rendered_html, {
                                            status: bgRoute.status_code || 200,
                                            headers: makeHtmlHeaders(bgBrand.providerName, bgBrand.copyrightText, 'HIT', bgEtag, bgRoute.version || 1, false, bgIsWl)
                                        });
                                        await edgeCache.put(edgeCacheKey, cloneForEdgeCache(bgRes));
                                        return;
                                    }
                                    await loadAdminLocales(c.env);
                                    const { renderDynamicVisitorPage } = await import('../render');
                                    const bgRendered = await renderDynamicVisitorPage(db, bgSite, normPath, host, locale, undefined, false);
                                    if (!bgRendered.redirectUrl && bgRendered.status === 200) {
                                        const nextV = (bgRoute?.version || 0) + 1;
                                        const bgEtag = `W/"${bgSite.id}-${normPath}-v${nextV}_${new Date().toISOString()}"`;
                                        const bgRes = new Response(bgRendered.html, {
                                            status: bgRendered.status,
                                            headers: makeHtmlHeaders(bgBrand.providerName, bgBrand.copyrightText, 'MISS', bgEtag, nextV, false, bgIsWl)
                                        });
                                        await buildUpsertSiteRouteStatement(db, {
                                            id: bgRoute?.id, siteId: bgSite.id, path: normPath,
                                            entityType: bgRendered.entityType || bgRoute?.entity_type || 'page',
                                            entityId: bgRendered.entityId || bgRoute?.entity_id || null,
                                            locale: bgRoute?.locale || locale, translationGroupId: bgRoute?.translation_group_id || null,
                                            title: bgRendered.title || bgRoute?.title || bgSite.name, renderedHtml: bgRendered.html,
                                            statusCode: bgRendered.status, redirectTarget: null, isDirty: 0,
                                            dependencies: bgRendered.dependencies?.length ? bgRendered.dependencies : undefined
                                        }).run();
                                        await edgeCache.put(edgeCacheKey, cloneForEdgeCache(bgRes));
                                    }
                                } catch {}
                            })()
                        );
                    }

                    return new Response(edgeHit.body, { status: edgeHit.status, headers: edgeHeaders });
                }
            }
        } catch {}
    }

    if (!db) {
        return handleSpecialRouteFallback(c, c.get('site' as any) as Site | undefined, 500, locale, executionCtx);
    }

    const tSiteStart = performance.now();
    let site: Site | null = (c.get('site' as any) as Site | undefined) || null;
    if (!site && cookieHeader.includes('walnut_active_site=')) {
        const activeSiteCookie = getCookie(c, 'walnut_active_site');
        if (activeSiteCookie) {
            try {
                const sessionUid = await getSessionUserId(c);
                if (sessionUid) {
                    const switchedSite = await findSiteById(db, activeSiteCookie);
                    if (switchedSite && switchedSite.status === 'active') {
                        const sd = normalizeHostKey(switchedSite.primary_domain);
                        const ch = normalizeHostKey(host);
                        if (!sd || switchedSite.primary_domain === '*' || sd === ch || isLocalHost(host)) {
                            site = switchedSite;
                        }
                    }
                }
            } catch {}
        }
    }
    if (!site) {
        site = await resolveSiteWithMemoryCache(db, host);
    }
    if (timing?.add) timing.add('site', performance.now() - tSiteStart);
    if (!site) {
        return c.redirect('/admin/setup');
    }

    site.settings = parseJson<Record<string, any>>(site.settings, {});

    const brandInfo = resolveSiteBrandInfo(site);
    const providerName = brandInfo.providerName;
    const copyrightText = brandInfo.copyrightText;
    const isWhitelabel = Boolean(brandInfo.hasStickyWhitelabel || brandInfo.hidePoweredBy);
    const hdrProvider = sanitizeHeaderBrand(providerName, 'Walnut CMS', isWhitelabel);
    const hdrCopyright = sanitizeHeaderBrand(copyrightText, 'Copyright Walnut CMS', isWhitelabel);
    if (hdrProvider) c.header('X-Provider', hdrProvider);
    if (hdrCopyright) c.header('X-Copyright', hdrCopyright);

    // Maintenance mode must return 503 via edge/D1/fallback rather than 200 OK so crawlers do not index downtime pages.
    const isMaintenance = site.settings?.site_mode === 'maintenance' || site.settings?.routing?.maintenance_mode === 1;
    if (isMaintenance && !user) {
        return handleSpecialRouteFallback(c, site, 503, locale, executionCtx, db);
    }

    if (isRobotsReq) {
        const primaryDomain = resolveEffectiveDomain(site.primary_domain, host);
        const defaultRobotsTxt = `User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: ${buildAbsoluteUrl('/sitemap.xml', primaryDomain)}`;
        let robotsBody = (site.robots_txt && site.robots_txt.trim()) ? site.robots_txt.trim() : defaultRobotsTxt;
        if (robotsBody.includes('Sitemap:')) {
            robotsBody = robotsBody.replace(/Sitemap:\s*(\S+)/g, (_m, sUrl) => {
                if (sUrl.startsWith('/') || sUrl.includes('://*') || sUrl.includes('localhost')) {
                    return `Sitemap: ${buildAbsoluteUrl('/sitemap.xml', primaryDomain)}`;
                }
                return `Sitemap: ${sUrl}`;
            });
        }
        const robotsHeaders = makeVisitorHeaders(providerName, copyrightText, 'HIT-ROBOTS', {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=86400'
        }, isWhitelabel);
        return new Response(robotsBody, { status: 200, headers: robotsHeaders });
    }

    // Reuse site_routes is_dirty snapshots for sitemap/feed routes to avoid full table scans per request.
    if (isSitemapReq || isFeedXmlReq || isFeedJsonReq) {
        const aggRoute = await findSiteRouteByPath(db, site.id, normPath);
        const isHit = aggRoute && aggRoute.is_dirty === 0 && aggRoute.rendered_html;
        const payload = isHit
            ? aggRoute.rendered_html!
            : (isSitemapReq
                ? await rebuildSiteSitemapRoute(db, site, host)
                : await rebuildSiteFeedRoute(db, site, host, isFeedXmlReq ? 'xml' : 'json'));
        const contentType = isFeedJsonReq ? 'application/feed+json; charset=utf-8' : 'application/xml; charset=utf-8';
        const aggHeaders = makeVisitorHeaders(providerName, copyrightText, isHit ? 'HIT' : 'MISS', {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=3600'
        }, isWhitelabel);
        return new Response(payload, { status: 200, headers: aggHeaders });
    }

    const tDbStart = performance.now();
    const routeRow = await findSiteRouteByPath(db, site.id, normPath);
    if (timing?.add) timing.add('db', performance.now() - tDbStart);

    if (routeRow) {
        if (routeRow.entity_type === 'redirect' || routeRow.status_code === 301 || routeRow.status_code === 302) {
            return c.redirect(routeRow.redirect_target || '/', (routeRow.status_code || 301) as any);
        }

        // Bypass cached HTML if it contains legacy fallback markers, unhydrated JSON, or empty layout shells.
        const renderedHtml = routeRow.rendered_html || '';
        const shouldBypassCachedHtml = !renderedHtml
            || (normPath === '/' && (!routeRow.entity_id || routeRow.entity_id === 'home' || routeRow.entity_type === 'home'))
            || renderedHtml.includes('walnut-component-fallback')
            || renderedHtml.trim().startsWith('[');

        if (isDefaultLocalePath && !user && routeRow.is_dirty === 0 && routeRow.rendered_html && !shouldBypassCachedHtml) {
            const routeVersionToken = `v${routeRow.version || 1}_${String(routeRow.updated_at || site.updated_at || '1').replace(/\s+/g, '_')}`;
            const routeEtag = `W/"${site.id}-${normPath}-${routeVersionToken}"`;

            const ifNoneMatch = c.req.header('if-none-match');
            const routeVersionPrefix = `W/"${site.id}-${normPath}-v${routeRow.version || 1}`;
            if (ifNoneMatch && (ifNoneMatch === routeEtag || ifNoneMatch.startsWith(routeVersionPrefix))) {
                return new Response(null, {
                    status: 304,
                    headers: makeHtmlHeaders(providerName, copyrightText, bypassEdgeCache ? 'BYPASS' : 'HIT-304-VERSION', routeEtag, routeRow.version || 1, bypassEdgeCache, isWhitelabel)
                });
            }

            const routeStatus = normPath === '/404' ? 404 : (normPath === '/500' ? 500 : (normPath === '/503' || normPath === '/maintenance' ? 503 : (routeRow.status_code || 200)));
            const hitHeaders = makeHtmlHeaders(providerName, copyrightText, bypassEdgeCache ? 'BYPASS' : 'HIT', routeEtag, routeRow.version || 1, bypassEdgeCache, isWhitelabel);
            const hitRes = new Response(routeRow.rendered_html, { status: routeStatus, headers: hitHeaders });
            if (!bypassEdgeCache && routeStatus === 200 && edgeCache && executionCtx?.waitUntil) {
                executionCtx.waitUntil(edgeCache.put(edgeCacheKey, cloneForEdgeCache(hitRes.clone())).catch(() => {}));
            }
            return hitRes;
        }
    }

    // Lazy-load the dynamic renderer only on cache miss or dirty routes to keep the fast-path bundle and CPU budget minimal.
    const tRenderStart = performance.now();
    let result: any;
    try {
        await loadAdminLocales(c.env);
        const { renderDynamicVisitorPage } = await import('../render');
        result = await renderDynamicVisitorPage(db, site, normPath, host, locale, user, isPreview);
    } catch (renderErr) {
        console.error(`[VisitorRouter] Render error on ${normPath}:`, renderErr);
        return handleSpecialRouteFallback(c, site, 500, locale, executionCtx, db);
    }
    if (timing?.add) timing.add('render', performance.now() - tRenderStart);
    if (result.redirectUrl) {
        if (!user && executionCtx?.waitUntil) {
            executionCtx.waitUntil(
                buildUpsertSiteRouteStatement(db, {
                    id: routeRow?.id, siteId: site.id, path: normPath, entityType: 'redirect',
                    entityId: routeRow?.entity_id || null, locale, title: routeRow?.title || site.name,
                    renderedHtml: null, statusCode: result.status || 301, redirectTarget: result.redirectUrl || '/', isDirty: 0
                }).run().catch(() => {})
            );
        }
        return c.redirect(result.redirectUrl, (result.status || 301) as any);
    }

    const nextVersion = (routeRow?.version || 0) + 1;
    const freshVersionToken = `v${nextVersion}_${new Date().toISOString()}`;
    const freshEtag = `W/"${site.id}-${normPath}-${freshVersionToken}"`;
    const resHeaders = makeHtmlHeaders(providerName, copyrightText, bypassEdgeCache ? 'BYPASS' : 'MISS', freshEtag, nextVersion, bypassEdgeCache, isWhitelabel);
    const finalResponse = new Response(result.html, { status: result.status, headers: resHeaders });

    const isSpecial500 = normPath === '/500';
    const isSpecial503 = normPath === '/503' || normPath === '/maintenance';
    const isSpecialRoute = normPath === '/404' || isSpecial500 || isSpecial503;

    // Persist compiled HTML and prune stale 404 routes asynchronously via waitUntil so TTFB is unaffected.
    if (isDefaultLocalePath && result.status === 404 && !isSpecialRoute && routeRow && executionCtx?.waitUntil) {
        executionCtx.waitUntil(buildDeleteSiteRouteByPathStatement(db, site.id, normPath).run().catch(() => {}));
    } else if ((result.status === 200 || isSpecialRoute) && !user && executionCtx?.waitUntil) {
        const edgeClone = (!bypassEdgeCache && result.status === 200 && edgeCache) ? cloneForEdgeCache(finalResponse.clone()) : null;
        executionCtx.waitUntil(
            (async () => {
                try {
                    if (isDefaultLocalePath) {
                        await buildUpsertSiteRouteStatement(db, {
                            id: routeRow?.id, siteId: site.id, path: normPath,
                            entityType: result.entityType || (routeRow?.entity_type && routeRow.entity_type !== 'home' ? routeRow.entity_type : 'page'),
                            entityId: result.entityId || (routeRow?.entity_id && routeRow.entity_id !== 'home' ? routeRow.entity_id : null),
                            locale: routeRow?.locale || locale, translationGroupId: routeRow?.translation_group_id || null,
                            title: result.title || routeRow?.title || site.name, renderedHtml: result.html, statusCode: result.status,
                            redirectTarget: null, isDirty: 0, changefreq: routeRow?.changefreq || (normPath === '/' ? 'daily' : 'weekly'),
                            priority: routeRow?.priority ?? (normPath === '/' ? 1.0 : (isSpecialRoute ? 0.2 : 0.8)),
                            dependencies: result.dependencies?.length ? result.dependencies : undefined
                        }).run();
                    }
                    if (edgeClone && edgeCache) {
                        await edgeCache.put(edgeCacheKey, edgeClone).catch(() => {});
                    }
                } catch (err) {
                    console.warn('[VisitorRouter] Async site_routes prerender persist error:', err);
                }
            })()
        );
    }

    return finalResponse;
});

export { visitorApp };
