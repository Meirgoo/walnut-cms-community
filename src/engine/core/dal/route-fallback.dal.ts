import { t } from '../i18n';
import { escapeXml } from '../utils';

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

export function buildSpecialRouteCacheRequest(siteId: string, routeKey: '404' | '500' | '503'): Request {
    return new Request(`https://walnut-special-cache.internal/${siteId}/${routeKey}`, { method: 'GET' });
}

export async function putSpecialRouteToEdgeCache(
    siteId: string,
    routeKey: '404' | '500' | '503',
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
        'X-Edge-Special-Cache': 'HIT',
        'X-Edge-Status': String(statusCode)
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
    routeKey: '404' | '500' | '503'
): Promise<{ html: string; status: number } | null> {
    const edgeCache: Cache | undefined = (globalThis as any).caches?.default;
    if (!edgeCache || !siteId) return null;
    try {
        const hit = await edgeCache.match(buildSpecialRouteCacheRequest(siteId, routeKey));
        if (hit) {
            const html = await hit.text();
            if (html && html.length > 20) {
                return { html, status: hit.status || Number(routeKey) };
            }
        }
    } catch {}
    return null;
}

export function renderFallbackErrorHtml(
    statusCode: 404 | 500 | 503,
    siteName = 'Content Management System',
    locale = 'zh-CN',
    customTitle?: string,
    customMessage?: string
): string {
    const c = statusCode === 404
        ? { t: '404 - Not Found', s: 'The requested page could not be found or has been unpublished.', col: 'text-amber-500' }
        : statusCode === 503
            ? { t: '503 - Service Unavailable', s: 'The site is currently undergoing scheduled maintenance. Please check back shortly.', col: 'text-indigo-500' }
            : { t: '500 - Internal Server Error', s: 'The server encountered an error while processing your request. Please try again later.', col: 'text-rose-500' };
    const safeTitle = escapeXml(customTitle?.trim() || c.t);
    const safeMessage = escapeXml(customMessage?.trim() || c.s);
    const safeSiteName = escapeXml(siteName);
    return `<!DOCTYPE html><html lang="${escapeXml(locale)}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${safeTitle} - ${safeSiteName}</title><link rel="stylesheet" href="/shared/app.css" /></head><body class="bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 min-h-screen flex items-center justify-center p-6 text-center font-sans antialiased"><div class="max-w-md w-full space-y-4 bg-white dark:bg-slate-900 p-8 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm"><h1 class="text-5xl font-black ${c.col} tracking-tight">${statusCode}</h1><h2 class="text-lg font-bold text-slate-900 dark:text-white">${safeTitle}</h2><p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed whitespace-pre-line">${safeMessage}</p><div class="pt-3"><a href="/" class="inline-block bg-slate-900 hover:bg-slate-800 dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white px-5 py-2.5 rounded-xl text-xs font-bold shadow-sm transition">&larr; Return Home</a></div></div></body></html>`;
}
