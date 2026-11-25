import { Hono } from 'hono';
import type { AppHonoEnv, Site } from '../types';
import { getCookie, setCookie } from 'hono/cookie';
import {
    resolveSiteWithMemoryCache,
    resolveSiteBrandInfo,
    normalizeRoutePath,
    findSiteRouteByPath,
    findSiteById,
    findNodeById,
    findSiteMemberRole,
    buildUpsertSiteRouteStatement,
    buildDeleteSiteRouteByPathStatement,
    rebuildSiteSitemapRoute,
    rebuildSiteFeedRoute,
    rebuildSiteLlmTxtRoute,
    isSystemInstalled,
    matchSpecialRouteFromEdgeCache,
    renderFallbackErrorHtml
} from '../core/dal';
import { getSessionUserId, getSessionSecret, resolveCurrentUser } from '../core/auth';
import { DEFAULT_DEV_HOST, buildAbsoluteUrl, resolveEffectiveDomain, normalizeHostKey, isLocalHost, applyPublicAssetDomainToHtml } from '../core/url';
import { loadAdminLocales, buildLocalizedRoutePath, normalizeLocaleCode } from '../core/i18n';
import { parseJson, isPreviewRequest, getCookieValue, sanitizeRedirectTarget, isSiteAdminUser } from '../core/utils';
import {
    getUnlockCookieName,
    verifyPasswordMatch,
    createUnlockToken,
    verifyUnlockToken,
    renderPasswordGateHtml
} from './password-gate';

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
    const safeProvider = sanitizeHeaderBrand(provider, 'Walnut Edge CMS', isWhitelabel);
    const safeCopyright = sanitizeHeaderBrand(copyright, 'Copyright Walnut Edge CMS', isWhitelabel);
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
    isWhitelabel = false,
    robotsTag = 'index, follow'
): Headers {
    return makeVisitorHeaders(provider, copyright, cacheTag, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': bypassCache ? 'private, no-store, no-cache, must-revalidate' : 'public, max-age=0, s-maxage=60, stale-while-revalidate=86400',
        'ETag': etag,
        'Content-Security-Policy': VISITOR_CSP_HEADER,
        'X-Route-Version': String(ver),
        'X-Robots-Tag': robotsTag
    }, isWhitelabel);
}

function extractMetaRobotsTag(html?: string | null, fallback = 'index, follow'): string {
    if (!html) return fallback;
    const m = html.match(/<meta\s+name=["']robots["']\s+content=["']([^"']+)["']/i);
    return (m && m[1]) ? m[1].trim() : fallback;
}

const EDGE_SWR_FRESH_MS = 15_000;
const EDGE_SWR_GRACE_MS = 86_400_000;

function cloneForEdgeCache(res: Response): Response {
    const h = new Headers(res.headers);
    h.set('X-Edge-Cached-At', String(Date.now()));
    return new Response(res.body, { status: res.status, headers: h });
}

export async function handleSpecialRouteFallback(
    c: any,
    site: Site | undefined,
    code: 404 | 500 | 503,
    locale: string,
    _executionCtx: any,
    db?: any,
    internalConfig?: { title?: string; message?: string }
): Promise<Response> {
    c.header('X-Robots-Tag', 'noindex, nofollow');
    if (code === 503) {
        c.header('Retry-After', '3600');
    }
    const sId = site?.id;
    if (sId) {
        try {
            const edgeRes = await matchSpecialRouteFromEdgeCache(sId, String(code) as '404' | '500' | '503');
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
    return c.html(renderFallbackErrorHtml(code, site?.name, locale, internalConfig?.title, internalConfig?.message), code);
}

visitorApp.post('/_unlock', async (c) => {
    const db = c.env.DB;
    const host = c.get('host') || DEFAULT_DEV_HOST;
    const locale = c.get('locale') || 'zh-CN';
    const body = await c.req.parseBody();
    const nodeId = String(body.node_id || '').trim();
    const rawTargetPath = String(body.path || '/').trim();
    const safeTargetPath = (rawTargetPath.startsWith('/') && !rawTargetPath.startsWith('//')) ? rawTargetPath : '/';
    const submittedPw = String(body.password || '').trim();

    if (!db || !nodeId) {
        return c.redirect(safeTargetPath, 302);
    }

    const site = await resolveSiteWithMemoryCache(db, host);
    if (!site) {
        return c.redirect(safeTargetPath, 302);
    }
    site.settings = parseJson<Record<string, any>>(site.settings, {});
    const node = await findNodeById(db, nodeId);
    const nodeMeta = parseJson<Record<string, any>>(node?.metadata, {});
    const isPasswordPage = Boolean(node && (node.visibility === 'password' || nodeMeta.access_permission === 'password_protected'));
    if (!node || node.site_id !== site.id || node.deleted_at || node.status !== 'published' || !isPasswordPage) {
        return c.redirect(safeTargetPath, 302);
    }

    const expectedPw = String(nodeMeta.access_password || '').trim();
    if (!verifyPasswordMatch(submittedPw, expectedPw)) {
        await loadAdminLocales(c.env);
        const gateHtml = await renderPasswordGateHtml({
            siteName: site.name,
            primaryColor: site.settings?.primary_color,
            nodeId,
            targetPath: safeTargetPath,
            locale,
            hasError: true,
            env: c.env
        });
        return new Response(gateHtml, {
            status: 401,
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store, private',
                'X-Robots-Tag': 'noindex, nofollow',
                'Content-Security-Policy': VISITOR_CSP_HEADER
            }
        });
    }

    const token = await createUnlockToken(getSessionSecret(c), nodeId, expectedPw);
    const reqUrl = new URL(c.req.url);
    setCookie(c, getUnlockCookieName(nodeId), token, {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        secure: reqUrl.protocol === 'https:',
        maxAge: 24 * 60 * 60
    });
    return c.redirect(safeTargetPath, 302);
});

visitorApp.get('/*', async (c) => {
    let executionCtx: any;
    try { executionCtx = c.executionCtx; } catch { executionCtx = undefined; }

    const db = c.env.DB;
    const host = c.get('host') || DEFAULT_DEV_HOST;
    let locale = c.get('locale') || 'zh-CN';
    const timing = c.get('serverTiming' as any) as any;
    const wantsPreview = isPreviewRequest(c);

    const reqUrl = new URL(c.req.url);
    const knownOrigins: Set<string> = ((globalThis as any).__WALNUT_KNOWN_ORIGINS__ ||= new Set<string>());
    if (knownOrigins.size < 20 && reqUrl.origin) {
        knownOrigins.add(reqUrl.origin);
    }
    const rawPathname = c.get('actualPath') || reqUrl.pathname || '/';
    const isSitemapReq = rawPathname === '/sitemap.xml' || rawPathname === 'sitemap.xml';
    const isFeedXmlReq = rawPathname === '/feed.xml' || rawPathname === 'feed.xml';
    const isRssXmlReq = rawPathname === '/rss.xml' || rawPathname === 'rss.xml';
    const isFeedJsonReq = rawPathname === '/feed.json' || rawPathname === 'feed.json';
    const isLlmTxtReq = rawPathname === '/llm.txt' || rawPathname === 'llm.txt' || rawPathname === '/llms.txt' || rawPathname === 'llms.txt';
    const isRobotsReq = rawPathname === '/robots.txt' || rawPathname === 'robots.txt';
    const normPath = isSitemapReq
        ? '/sitemap.xml'
        : isFeedXmlReq
            ? '/feed.xml'
            : isRssXmlReq
                ? '/rss.xml'
                : isFeedJsonReq
                    ? '/feed.json'
                    : isLlmTxtReq
                        ? (rawPathname.includes('llms.txt') ? '/llms.txt' : '/llm.txt')
                        : (isRobotsReq ? '/robots.txt' : normalizeRoutePath(rawPathname));

    const cookieHeader = c.req.header('cookie') || '';
    const sessionToken = getCookieValue(cookieHeader, 'edge_session');
    const hasValidSessionShape = Boolean(sessionToken && sessionToken.length >= 16);
    const hasCfAccess = Boolean((c.env as any)?.CF_ACCESS_TEAM_NAME && (c.req.header('cf-access-jwt-assertion') || c.req.header('Cf-Access-Jwt-Assertion')));
    let user = c.get('user') || null;
    if (!user && db && (hasValidSessionShape || hasCfAccess)) {
        user = await resolveCurrentUser(c).catch(() => null);
    }

    if (!db) {
        return handleSpecialRouteFallback(c, c.get('site' as any) as Site | undefined, 500, locale, executionCtx);
    }

    const tSiteStart = performance.now();
    let site: Site | null = (c.get('site' as any) as Site | undefined) || null;
    if (!site && cookieHeader.includes('edge_active_site=')) {
        const activeSiteCookie = getCookie(c, 'edge_active_site');
        if (activeSiteCookie) {
            try {
                const sessionUid = user?.id || (await getSessionUserId(c));
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
    if (!c.get('locale')) {
        locale = site.default_locale || 'zh-CN';
    }

    const brandInfo = resolveSiteBrandInfo(site);
    const providerName = brandInfo.providerName;
    const copyrightText = brandInfo.copyrightText;
    const isWhitelabel = Boolean(brandInfo.hasStickyWhitelabel || brandInfo.hidePoweredBy);
    const hdrProvider = sanitizeHeaderBrand(providerName, 'Walnut Edge CMS', isWhitelabel);
    const hdrCopyright = sanitizeHeaderBrand(copyrightText, 'Copyright Walnut Edge CMS', isWhitelabel);
    if (hdrProvider) c.header('X-Provider', hdrProvider);
    if (hdrCopyright) c.header('X-Copyright', hdrCopyright);

    // Gate internal mode before edgeCache.match so stale POP entries never leak private/internal HTML.
    const rawSiteMode = site.settings?.site_mode as string | undefined;
    const isInternalMode = rawSiteMode === 'internal'
        || rawSiteMode === 'maintenance'
        || site.settings?.routing?.maintenance_mode === 1;
    if (isInternalMode && !user) {
        const internalCfg = site.settings?.internal || {};
        const internalStatus = Number(internalCfg.status_code || 503);
        if (internalStatus === 301 || internalStatus === 302) {
            const safeTarget = sanitizeRedirectTarget(internalCfg.redirect_url || '', '');
            if (safeTarget) {
                c.header('X-Robots-Tag', 'noindex, nofollow');
                c.header('Cache-Control', 'no-store');
                return c.redirect(safeTarget, internalStatus as 301 | 302);
            }
        }
        const fallbackCode: 404 | 503 = internalStatus === 404 ? 404 : 503;
        return handleSpecialRouteFallback(c, site, fallbackCode, locale, executionCtx, db, internalCfg);
    }

    // Require a verified site-admin session before honoring preview parameters.
    let isPreview = false;
    if (wantsPreview && user && isSiteAdminUser(user)) {
        if (user.global_role === 'superadmin') {
            isPreview = true;
        } else {
            const memberRole = await findSiteMemberRole(db, site.id, user.id).catch(() => null);
            isPreview = memberRole === 'admin';
        }
    }
    if (isPreview) {
        c.header('X-Preview-Mode', '1');
    }

    const cacheCtrlHeader = (c.req.header('cache-control') || '').toLowerCase();
    const bypassEdgeCache = isPreview
        || Boolean(user)
        || hasValidSessionShape
        || hasCfAccess
        || isInternalMode
        || cookieHeader.includes('edge_unlock_')
        || cacheCtrlHeader.includes('no-cache');

    const edgeCache: Cache | undefined = (globalThis as any).caches?.default;
    const edgeKeyPath = normalizeRoutePath(reqUrl.pathname);
    const edgeCacheKey = new Request(`${reqUrl.origin}${edgeKeyPath}`, { method: 'GET' });

    // Serve anonymous GET requests from caches.default with 15s SWR to bypass cross-region D1 queries on hot paths.
    if (!bypassEdgeCache && !isSitemapReq && !isFeedXmlReq && !isRssXmlReq && !isFeedJsonReq && !isLlmTxtReq && !isRobotsReq && edgeCache) {
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
                                    const bgRawMode = bgSite.settings?.site_mode as string | undefined;
                                    if (bgRawMode === 'internal' || bgRawMode === 'maintenance' || bgSite.settings?.routing?.maintenance_mode === 1) {
                                        return;
                                    }
                                    const bgBrand = resolveSiteBrandInfo(bgSite);
                                    const bgIsWl = Boolean(bgBrand.hasStickyWhitelabel || bgBrand.hidePoweredBy);
                                    const bgSiteDefaultLocale = bgSite.default_locale || 'zh-CN';
                                    const bgLocale = c.get('locale') ? locale : bgSiteDefaultLocale;
                                    const bgLocalizedPath = buildLocalizedRoutePath(normPath, bgLocale, bgSiteDefaultLocale);
                                    const bgRoute = await findSiteRouteByPath(db, bgSite.id, bgLocalizedPath);
                                    if (bgRoute && normalizeLocaleCode(bgRoute.locale || bgSiteDefaultLocale) === normalizeLocaleCode(bgLocale) && bgRoute.is_dirty === 0 && bgRoute.rendered_html) {
                                        const bgVer = `v${bgRoute.version || 1}_${String(bgRoute.updated_at || bgSite.updated_at || '1').replace(/\s+/g, '_')}`;
                                        const bgEtag = `W/"${bgSite.id}-${bgLocalizedPath}-${bgVer}"`;
                                        const bgRes = new Response(bgRoute.rendered_html, {
                                            status: bgRoute.status_code || 200,
                                            headers: makeHtmlHeaders(bgBrand.providerName, bgBrand.copyrightText, 'HIT', bgEtag, bgRoute.version || 1, false, bgIsWl)
                                        });
                                        await edgeCache.put(edgeCacheKey, cloneForEdgeCache(bgRes));
                                        return;
                                    }
                                    await loadAdminLocales(c.env);
                                    const { renderDynamicVisitorPage } = await import('../render');
                                    const bgRendered = await renderDynamicVisitorPage(db, bgSite, normPath, host, bgLocale, undefined, false, undefined, {
                                        requestPath: edgeKeyPath,
                                        hasExplicitLocalePrefix: Boolean(c.get('locale')),
                                        env: c.env
                                    });
                                    if (!bgRendered.redirectUrl && bgRendered.status === 200) {
                                        const nextV = (bgRoute?.version || 0) + 1;
                                        const bgEtag = `W/"${bgSite.id}-${bgLocalizedPath}-v${nextV}_${new Date().toISOString()}"`;
                                        const bgRes = new Response(bgRendered.html, {
                                            status: bgRendered.status,
                                            headers: makeHtmlHeaders(bgBrand.providerName, bgBrand.copyrightText, 'MISS', bgEtag, nextV, false, bgIsWl)
                                        });
                                        await buildUpsertSiteRouteStatement(db, {
                                            id: bgRoute?.id, siteId: bgSite.id, path: bgLocalizedPath,
                                            entityType: bgRendered.entityType || bgRoute?.entity_type || 'page',
                                            entityId: bgRendered.entityId || bgRoute?.entity_id || null,
                                            locale: bgRoute?.locale || bgLocale, translationGroupId: bgRendered.translationGroupId || bgRoute?.translation_group_id || null,
                                            title: bgRendered.title || bgRoute?.title || bgSite.name, renderedHtml: bgRendered.html,
                                            statusCode: bgRendered.status, redirectTarget: null, isDirty: 0,
                                            dependencies: Array.isArray(bgRendered.dependencies) ? bgRendered.dependencies : []
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

    if (isRobotsReq) {
        const primaryDomain = resolveEffectiveDomain(site.primary_domain, host);
        const defaultRobotsTxt = `User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: ${buildAbsoluteUrl('/sitemap.xml', primaryDomain)}`;
        let robotsBody = (site.robots_txt && site.robots_txt.trim())
            ? site.robots_txt.trim().replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n')
            : defaultRobotsTxt;
        if (robotsBody.includes('Sitemap:')) {
            robotsBody = robotsBody.replace(/Sitemap:\s*(\S+)/g, (_m, sUrl) => {
                if (sUrl.startsWith('/') || sUrl.includes('://*') || sUrl.includes('localhost')) {
                    return `Sitemap: ${buildAbsoluteUrl('/sitemap.xml', primaryDomain)}`;
                }
                return `Sitemap: ${sUrl}`;
            });
        }
        const siteDefaultRobots = site.settings?.seo?.robots || site.settings?.robots_control || 'index, follow';
        const robotsHeaders = makeVisitorHeaders(providerName, copyrightText, 'HIT-ROBOTS', {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
            'X-Robots-Tag': siteDefaultRobots
        }, isWhitelabel);
        return new Response(robotsBody, { status: 200, headers: robotsHeaders });
    }

    // Reuse site_routes is_dirty snapshots for sitemap/feed/llm.txt routes to avoid full table scans per request.
    if (isSitemapReq || isFeedXmlReq || isRssXmlReq || isFeedJsonReq || isLlmTxtReq) {
        const aggCachePath = (isFeedXmlReq || isRssXmlReq || isFeedJsonReq)
            ? buildLocalizedRoutePath(normPath, locale, site.default_locale || 'zh-CN')
            : normPath;
        const aggRoute = await findSiteRouteByPath(db, site.id, aggCachePath);
        const isHit = aggRoute && aggRoute.is_dirty === 0 && aggRoute.rendered_html;
        const payload = isHit
            ? aggRoute.rendered_html!
            : (isSitemapReq
                ? await rebuildSiteSitemapRoute(db, site, host)
                : isLlmTxtReq
                    ? await rebuildSiteLlmTxtRoute(db, site, host, normPath as '/llm.txt' | '/llms.txt')
                    : await rebuildSiteFeedRoute(db, site, host, isFeedJsonReq ? 'json' : 'xml', aggCachePath, locale));
        const contentType = isLlmTxtReq
            ? 'text/plain; charset=utf-8'
            : isFeedJsonReq
                ? 'application/feed+json; charset=utf-8'
                : (isFeedXmlReq || isRssXmlReq)
                    ? 'application/rss+xml; charset=utf-8'
                    : 'application/xml; charset=utf-8';
        const siteDefaultRobots = site.settings?.seo?.robots || site.settings?.robots_control || 'index, follow';
        const aggHeaders = makeVisitorHeaders(providerName, copyrightText, isHit ? 'HIT' : 'MISS', {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=3600',
            'X-Robots-Tag': siteDefaultRobots
        }, isWhitelabel);
        return new Response(payload, { status: 200, headers: aggHeaders });
    }

    const siteDefaultLocale = site.default_locale || 'zh-CN';
    const hasExplicitLocalePrefix = Boolean(c.get('locale'));
    const localizedReqPath = buildLocalizedRoutePath(normPath, locale, siteDefaultLocale);
    const tDbStart = performance.now();
    const routeRow = await findSiteRouteByPath(db, site.id, localizedReqPath);
    if (timing?.add) timing.add('db', performance.now() - tDbStart);

    if (routeRow) {
        if (routeRow.entity_type === 'redirect' || routeRow.status_code === 301 || routeRow.status_code === 302) {
            const safeTarget = sanitizeRedirectTarget(routeRow.redirect_target || '/', '/');
            if (normalizeRoutePath(safeTarget) !== localizedReqPath) {
                return c.redirect(safeTarget, (routeRow.status_code || 301) as any);
            }
        }

        // Bypass cached HTML if it contains legacy fallback markers, unhydrated JSON, or empty layout shells.
        const renderedHtml = routeRow.rendered_html || '';
        const shouldBypassCachedHtml = !renderedHtml
            || (normPath === '/' && (!routeRow.entity_id || routeRow.entity_id === 'home' || routeRow.entity_type === 'home'))
            || renderedHtml.includes('edge-component-fallback')
            || renderedHtml.trim().startsWith('[');
        const isLocaleMatch = normalizeLocaleCode(routeRow.locale || siteDefaultLocale) === normalizeLocaleCode(locale);

        if (isLocaleMatch && !user && routeRow.is_dirty === 0 && routeRow.rendered_html && !shouldBypassCachedHtml) {
            const routeVersionToken = `v${routeRow.version || 1}_${String(routeRow.updated_at || site.updated_at || '1').replace(/\s+/g, '_')}`;
            const routeEtag = `W/"${site.id}-${localizedReqPath}-${routeVersionToken}"`;

            const ifNoneMatch = c.req.header('if-none-match');
            const routeVersionPrefix = `W/"${site.id}-${localizedReqPath}-v${routeRow.version || 1}`;
            if (ifNoneMatch && (ifNoneMatch === routeEtag || ifNoneMatch.startsWith(routeVersionPrefix))) {
                return new Response(null, {
                    status: 304,
                    headers: makeHtmlHeaders(providerName, copyrightText, bypassEdgeCache ? 'BYPASS' : 'HIT-304-VERSION', routeEtag, routeRow.version || 1, bypassEdgeCache, isWhitelabel)
                });
            }

            const routeStatus = normPath === '/404' ? 404 : (normPath === '/500' ? 500 : (normPath === '/503' || normPath === '/maintenance' ? 503 : (routeRow.status_code || 200)));
            const siteDefaultRobots = site.settings?.seo?.robots || site.settings?.robots_control || 'index, follow';
            const hitRobotsTag = routeStatus !== 200 ? 'noindex, nofollow' : extractMetaRobotsTag(routeRow.rendered_html, siteDefaultRobots);
            const hitHeaders = makeHtmlHeaders(providerName, copyrightText, bypassEdgeCache ? 'BYPASS' : 'HIT', routeEtag, routeRow.version || 1, bypassEdgeCache, isWhitelabel, hitRobotsTag);
            const hitHtml = applyPublicAssetDomainToHtml(routeRow.rendered_html, c.env?.PUBLIC_ASSETS_DOMAIN);
            const hitRes = new Response(hitHtml, { status: routeStatus, headers: hitHeaders });
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
        const verifyPasswordUnlock = async (nodeId: string, accessPassword: string) => {
            const unlockCookie = getCookie(c, getUnlockCookieName(nodeId));
            return verifyUnlockToken(getSessionSecret(c), unlockCookie, nodeId, accessPassword);
        };
        result = await renderDynamicVisitorPage(db, site, normPath, host, locale, user || undefined, isPreview, verifyPasswordUnlock, {
            requestPath: edgeKeyPath,
            hasExplicitLocalePrefix,
            env: c.env
        });
    } catch (renderErr) {
        console.error(`[VisitorRouter] Render error on ${normPath}:`, renderErr);
        return handleSpecialRouteFallback(c, site, 500, locale, executionCtx, db);
    }
    if (timing?.add) timing.add('render', performance.now() - tRenderStart);
    if (result.redirectUrl) {
        if (!result.noCache && !user && executionCtx?.waitUntil) {
            executionCtx.waitUntil(
                buildUpsertSiteRouteStatement(db, {
                    id: routeRow?.id, siteId: site.id, path: localizedReqPath, entityType: 'redirect',
                    entityId: routeRow?.entity_id || null, locale, title: routeRow?.title || site.name,
                    renderedHtml: null, statusCode: result.status || 301, redirectTarget: result.redirectUrl || '/', isDirty: 0
                }).run().catch(() => {})
            );
        }
        return c.redirect(result.redirectUrl, (result.status || 301) as any);
    }

    if (result.passwordRequired && result.entityId) {
        const gateHtml = await renderPasswordGateHtml({
            siteName: site.name,
            primaryColor: site.settings?.primary_color,
            nodeId: result.entityId,
            targetPath: reqUrl.pathname || normPath,
            locale,
            env: c.env
        });
        return new Response(gateHtml, {
            status: 200,
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store, private',
                'X-Robots-Tag': 'noindex, nofollow',
                'Content-Security-Policy': VISITOR_CSP_HEADER
            }
        });
    }

    const nextVersion = (routeRow?.version || 0) + 1;
    const freshVersionToken = `v${nextVersion}_${new Date().toISOString()}`;
    const freshEtag = `W/"${site.id}-${localizedReqPath}-${freshVersionToken}"`;
    const siteDefaultRobots = site.settings?.seo?.robots || site.settings?.robots_control || 'index, follow';
    const missRobotsTag = (result.status !== 200 || isPreview || result.noCache) ? 'noindex, nofollow' : (result.robots || siteDefaultRobots);
    const resHeaders = makeHtmlHeaders(providerName, copyrightText, (bypassEdgeCache || result.noCache) ? 'BYPASS' : 'MISS', freshEtag, nextVersion, Boolean(bypassEdgeCache || result.noCache), isWhitelabel, missRobotsTag);
    if (isPreview) {
        resHeaders.set('X-Preview-Mode', '1');
    }
    const outputHtml = applyPublicAssetDomainToHtml(result.html, c.env?.PUBLIC_ASSETS_DOMAIN);
    const finalResponse = new Response(outputHtml, { status: result.status, headers: resHeaders });

    const isSpecial500 = normPath === '/500';
    const isSpecial503 = normPath === '/503' || normPath === '/maintenance';
    const isSpecialRoute = normPath === '/404' || isSpecial500 || isSpecial503;

    // Persist compiled HTML and prune stale 404 routes asynchronously via waitUntil so TTFB is unaffected.
    if (result.status === 404 && !isSpecialRoute && routeRow && executionCtx?.waitUntil) {
        executionCtx.waitUntil(buildDeleteSiteRouteByPathStatement(db, site.id, localizedReqPath).run().catch(() => {}));
    } else if ((result.status === 200 || isSpecialRoute) && !user && !result.noCache && executionCtx?.waitUntil) {
        const edgeClone = (!bypassEdgeCache && result.status === 200 && edgeCache) ? cloneForEdgeCache(finalResponse.clone()) : null;
        executionCtx.waitUntil(
            (async () => {
                try {
                    await buildUpsertSiteRouteStatement(db, {
                        id: routeRow?.id, siteId: site.id, path: localizedReqPath,
                        entityType: result.entityType || (routeRow?.entity_type && routeRow.entity_type !== 'home' ? routeRow.entity_type : 'page'),
                        entityId: result.entityId || (routeRow?.entity_id && routeRow.entity_id !== 'home' ? routeRow.entity_id : null),
                        locale: routeRow?.locale || locale, translationGroupId: result.translationGroupId || routeRow?.translation_group_id || null,
                        title: result.title || routeRow?.title || site.name, renderedHtml: result.html, statusCode: result.status,
                        redirectTarget: null, isDirty: 0, changefreq: routeRow?.changefreq || (normPath === '/' ? 'daily' : 'weekly'),
                        priority: routeRow?.priority ?? (normPath === '/' ? 1.0 : (isSpecialRoute ? 0.2 : 0.8)),
                        dependencies: Array.isArray(result.dependencies) ? result.dependencies : []
                    }).run();
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
