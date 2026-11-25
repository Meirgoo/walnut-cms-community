import { Hono, type Context } from 'hono';
import type { AppHonoEnv } from '../types';
import {
    checkQueryRateLimit,
    getCachedQueryResult,
    setCachedQueryResult,
    normalizePagination,
    queryNodesWithFilters,
    queryDatasetsWithJson1Filter,
    queryPublicMediaAssets,
    findSiteById,
    findSchemasBySite,
    resolveSiteWithMemoryCache
} from '../core/dal';
import { createHookContext } from '../kernel';
import { buildLocalizedRoutePath } from '../core/i18n';
import { DEFAULT_DEV_HOST, buildAbsoluteUrl, resolveEffectiveDomain } from '../core/url';
import { extractClientIp, isSiteAdminUser, parseJson, escapeXml } from '../core/utils';
import { queryAggregatedFeed } from '../render/api-protocol';

export const publicQueriesRouter = new Hono<AppHonoEnv>();

function getApiQueryEnv(c: Context<AppHonoEnv>) {
    const db = c.env.DB;
    if (!db) return { err: c.json({ error: 'Database unavailable' }, 500) };

    const clientIp = extractClientIp(c);
    if (!checkQueryRateLimit(clientIp, 60)) {
        return { err: c.json({ error: 'Too Many Requests', message: 'Rate limit exceeded, please try again later.' }, 429) };
    }

    const siteId = c.get('siteId') || c.req.query('site_id') || 'site_default';
    const isAuthorizedUser = isSiteAdminUser(c.get('user'));

    return { db, siteId, isAuthorizedUser };
}

export async function resolveApiReadAccess(
    c: Context<AppHonoEnv>,
    db: any,
    siteId: string,
    isAuthorizedUser: boolean,
    requiredScope: string
): Promise<{ allowApiOnly: boolean; site?: any } | { err: Response }> {
    const authHeader = c.req.header('authorization') || '';
    const rawApiToken = (authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '') || (c.req.header('x-api-key') || '').trim();
    const pluginEngine = c.get('pluginEngine');
    let hasValidApiToken = false;

    if (rawApiToken && !isAuthorizedUser) {
        if (!pluginEngine?.hasService('API_TOKEN_VERIFY')) {
            return { err: c.json({ error: 'Forbidden: Commercial API token guard is required', code: 'COMMERCIAL_FEATURE_REQUIRED' }, 403) };
        }
        try {
            const verifyRes = await pluginEngine.runPipeline(createHookContext({
                action: 'API_TOKEN_VERIFY',
                data: { token: rawApiToken, siteId, requiredScope },
                c,
                siteId
            })) as { valid: boolean; error?: string };
            if (!verifyRes?.valid) {
                return { err: c.json({ error: `Unauthorized: ${verifyRes?.error || 'Invalid API token'}`, code: verifyRes?.error || 'UNAUTHORIZED_TOKEN' }, 401) };
            }
            hasValidApiToken = true;
        } catch (err: any) {
            const msg = String(err?.message || 'FORBIDDEN');
            const status = msg.startsWith('LICENSE_') ? 403 : 401;
            return { err: c.json({ error: msg, code: msg }, status as any) };
        }
    }

    const allowApiOnly = isAuthorizedUser || hasValidApiToken;
    if (!allowApiOnly) {
        const host = c.get('host') || DEFAULT_DEV_HOST;
        const resolvedSite = await resolveSiteWithMemoryCache(db, host);
        const site = (resolvedSite && resolvedSite.id === siteId) ? resolvedSite : await findSiteById(db, siteId);
        if (site) {
            const settings = parseJson<Record<string, any>>(site.settings, {});
            const rawMode = settings.site_mode as string | undefined;
            const isInternal = rawMode === 'internal' || rawMode === 'maintenance' || settings.routing?.maintenance_mode === 1;
            if (isInternal) {
                if (pluginEngine?.hasService('API_TOKEN_VERIFY')) {
                    return { err: c.json({ error: 'Unauthorized: Valid commercial API token required for internal mode', code: 'API_TOKEN_REQUIRED' }, 401) };
                }
                return { err: c.json({ error: 'Forbidden: Internal mode closes public API access', code: 'INTERNAL_MODE_API_FORBIDDEN' }, 403) };
            }
        }
        return { allowApiOnly: false, site };
    }

    return { allowApiOnly: true };
}

async function respondCachedQuery<T>(c: Context<AppHonoEnv>, cacheKey: string, fetcher: () => Promise<T>, ttl = 30, isPrivate = false) {
    const cached = getCachedQueryResult(cacheKey);
    c.header('Cache-Control', isPrivate ? 'private, no-store' : 'public, max-age=60');
    if (cached) {
        c.header('X-Edge-Cache', 'HIT');
        return c.json(cached);
    }
    const result = await fetcher();
    setCachedQueryResult(cacheKey, result, ttl);
    c.header('X-Edge-Cache', 'MISS');
    return c.json(result);
}

publicQueriesRouter.get('/health', (c) => c.json({
    status: 'ok',
    timestamp: new Date().toISOString()
}));

function buildHeadlessSiteMeta(site: any) {
    if (!site) return null;
    const settings = parseJson<Record<string, any>>(site.settings, {});
    const rawMode = settings.site_mode as string | undefined;
    const siteMode = (rawMode === 'internal' || rawMode === 'maintenance' || settings.routing?.maintenance_mode === 1) ? 'internal' : 'standard';
    return {
        id: site.id,
        name: site.name,
        primary_domain: site.primary_domain,
        default_locale: site.default_locale || 'zh-CN',
        site_mode: siteMode,
        internal_status: siteMode === 'internal' ? Number(settings.internal?.status_code || 503) : 200
    };
}

function buildHeadlessPagination(page: number, limit: number, total: number) {
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return {
        page,
        limit,
        total,
        total_pages: totalPages,
        has_next: page < totalPages,
        has_prev: page > 1
    };
}

async function respondHeadlessFormatCached(
    c: Context<AppHonoEnv>,
    cacheKey: string,
    format: string,
    host: string,
    allowApiOnly: boolean,
    buildPayload: () => Promise<{ payload: any; site: any }>
) {
    const cached = getCachedQueryResult<any>(cacheKey);
    c.header('Cache-Control', allowApiOnly ? 'private, no-store' : 'public, max-age=60');
    if (cached) {
        c.header('X-Edge-Cache', 'HIT');
        return formatHeadlessOutput(c, cached, format, cached.meta?.site, host);
    }
    const { payload, site } = await buildPayload();
    setCachedQueryResult(cacheKey, payload, 30);
    c.header('X-Edge-Cache', 'MISS');
    return formatHeadlessOutput(c, payload, format, site, host);
}

publicQueriesRouter.get('/status', async (c) => {
    const db = c.env.DB;
    if (!db) return c.json({ status: 'error', error: 'Database unavailable' }, 500);
    const siteId = c.get('siteId') || c.req.query('site_id') || 'site_default';
    const site = await findSiteById(db, siteId);
    if (!site) return c.json({ status: 'not_found', site_id: siteId }, 404);
    const siteMeta = buildHeadlessSiteMeta(site)!;
    return c.json({
        status: 'ok',
        headless: true,
        site_id: siteMeta.id,
        name: siteMeta.name,
        primary_domain: siteMeta.primary_domain,
        default_locale: siteMeta.default_locale,
        site_mode: siteMeta.site_mode,
        internal_status: siteMeta.internal_status,
        timestamp: new Date().toISOString()
    });
});

function enrichHeadlessItem(item: any, site: any, host: string): any {
    const settings = parseJson<Record<string, any>>(site?.settings, {});
    const siteSeo = settings.seo || {};
    const defaultLocale = site?.default_locale || 'zh-CN';
    const domain = resolveEffectiveDomain(site?.primary_domain, host);
    const meta = parseJson<Record<string, any>>(item.metadata, {});
    delete meta.access_password;
    delete meta.password;

    const visibility = item.visibility || 'public';
    const itemLocale = item.locale || defaultLocale;
    const cleanSlug = String(item.slug || '').replace(/^\/+/, '');
    const isApiOnly = visibility === 'api_only' || item.type === 'micro';
    const url = isApiOnly
        ? null
        : buildAbsoluteUrl(buildLocalizedRoutePath(cleanSlug ? `/${cleanSlug}` : '/', itemLocale, defaultLocale), domain);

    const rawText = String(item.content_raw || item.summary || '');
    const wordCount = rawText.trim() ? rawText.trim().split(/\s+/).length : 0;

    return {
        ...item,
        visibility,
        metadata: meta,
        url,
        author: {
            name: meta.author || site?.name || 'Admin'
        },
        seo: {
            title: meta.seo_title || item.title || '',
            description: meta.seo_description || item.summary || '',
            og_image: meta.og_image || item.cover_image_url || siteSeo.og_image || null,
            keywords: meta.keywords || meta.tags || [],
            robots: visibility === 'api_only' ? 'noindex, nofollow' : (meta.robots || siteSeo.robots || 'index, follow'),
            canonical_url: url
        },
        stats: {
            word_count: wordCount,
            reading_time_minutes: Math.max(1, Math.ceil(wordCount / 220))
        }
    };
}

function formatHeadlessOutput(c: Context<AppHonoEnv>, data: any, format: string, site: any, host: string) {
    const normFormat = (format || 'json').toLowerCase();
    c.header('X-Headless-Mode', '1');
    c.header('X-Robots-Tag', 'noindex, nofollow');

    if (normFormat === 'ndjson') {
        const lines = (data.items || []).map((item: any) => JSON.stringify(item)).join('\n');
        return c.text(lines, 200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    }

    if (normFormat === 'rss' || normFormat === 'xml') {
        const domain = resolveEffectiveDomain(site?.primary_domain, host);
        const baseUrl = buildAbsoluteUrl('/', domain);
        const itemsXml = (data.items || []).map((item: any) => {
            const link = item.url || `${baseUrl}api/${item.type === 'micro' ? 'micro' : 'articles'}?id=${encodeURIComponent(item.id || '')}`;
            const pubDate = new Date(item.published_at || item.created_at || Date.now()).toUTCString();
            const desc = String(item.summary || item.seo?.description || '');
            const body = String(item.content_raw || desc);
            return `  <item>\n    <title>${escapeXml(item.title || '')}</title>\n    <link>${escapeXml(link)}</link>\n    <guid isPermaLink="false">${escapeXml(item.id || link)}</guid>\n    <pubDate>${escapeXml(pubDate)}</pubDate>\n    <description><![CDATA[${desc.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]></description>\n    <content:encoded><![CDATA[${body.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]></content:encoded>\n  </item>`;
        }).join('\n');
        const rssXml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">\n<channel>\n  <title>${escapeXml(site?.name || 'CMS')}</title>\n  <link>${escapeXml(baseUrl)}</link>\n  <description>${escapeXml(site?.settings?.description || '')}</description>\n  <lastBuildDate>${escapeXml(new Date().toUTCString())}</lastBuildDate>\n${itemsXml}\n</channel>\n</rss>`;
        return c.text(rssXml, 200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
    }

    return c.json(data);
}

async function handleQueryContentList(c: Context<AppHonoEnv>, forcedType?: string) {
    const envRes = getApiQueryEnv(c);
    if ('err' in envRes) return envRes.err;
    const { db, siteId, isAuthorizedUser } = envRes;

    const accessRes = await resolveApiReadAccess(c, db, siteId, isAuthorizedUser, 'nodes:read');
    if ('err' in accessRes) return accessRes.err;
    const { allowApiOnly } = accessRes;

    const id = c.req.query('id');
    const slug = c.req.query('slug');
    const maturity = c.req.query('progress') || c.req.query('maturity');
    const folder = c.req.query('folder');
    const locale = c.req.query('locale');
    const type = forcedType || c.req.query('type');
    const rawStatus = c.req.query('status') as any;
    const status = isAuthorizedUser ? (rawStatus || 'published') : 'published';
    const tag = c.req.query('tag');
    const target = c.req.query('target');
    const fields = c.req.query('fields');
    const format = c.req.query('format') || 'json';
    const host = c.get('host') || DEFAULT_DEV_HOST;
    const normPage = normalizePagination({
        page: c.req.query('page'),
        limit: c.req.query('limit')
    });

    const cacheKey = `content:${siteId}:${isAuthorizedUser}:${allowApiOnly}:${id || ''}:${slug || ''}:${maturity || ''}:${folder || ''}:${locale || ''}:${type}:${status}:${tag}:${target}:${fields}:${normPage.page}:${normPage.limit}`;
    return respondHeadlessFormatCached(c, cacheKey, format, host, allowApiOnly, async () => {
        const site = accessRes.site || await findSiteById(db, siteId);
        const rawRes = await queryNodesWithFilters(db, {
            siteId,
            id,
            slug,
            progress: maturity,
            maturity,
            folder,
            locale,
            type,
            status,
            tag,
            target,
            fields,
            excludeApiOnly: !allowApiOnly,
            page: normPage.page,
            limit: normPage.limit
        }, isAuthorizedUser);

        const enrichedItems = (rawRes.items || []).map((it: any) => enrichHeadlessItem(it, site, host));
        const total = rawRes.total || 0;
        return {
            site,
            payload: {
                meta: {
                    headless: true,
                    format: 'json',
                    site: buildHeadlessSiteMeta(site),
                    pagination: buildHeadlessPagination(normPage.page, normPage.limit, total),
                    generated_at: new Date().toISOString()
                },
                items: enrichedItems,
                nodes: enrichedItems,
                total
            }
        };
    });
}

publicQueriesRouter.get('/articles', (c) => handleQueryContentList(c, 'article'));
publicQueriesRouter.get('/micro', (c) => handleQueryContentList(c, 'micro'));
publicQueriesRouter.get('/micros', (c) => handleQueryContentList(c, 'micro'));

async function handleQueryDatasetList(c: Context<AppHonoEnv>) {
    const envRes = getApiQueryEnv(c);
    if ('err' in envRes) return envRes.err;
    const { db, siteId, isAuthorizedUser } = envRes;

    const accessRes = await resolveApiReadAccess(c, db, siteId, isAuthorizedUser, 'datasets:read');
    if ('err' in accessRes) return accessRes.err;
    const { allowApiOnly } = accessRes;

    const schemaSlug = c.req.query('collection') || c.req.query('collection_slug') || c.req.query('schema') || c.req.query('schema_slug');
    const format = c.req.query('format') || 'json';
    const host = c.get('host') || DEFAULT_DEV_HOST;
    const limit = Math.max(1, Math.min(100, Number(c.req.query('limit')) || 50));
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const offset = c.req.query('offset') !== undefined
        ? Math.max(0, Number(c.req.query('offset')) || 0)
        : (page - 1) * limit;

    const filters: Record<string, string> = {};
    const queryParams = new URL(c.req.url).searchParams;
    let hasInvalidKey = false;
    queryParams.forEach((value, key) => {
        if (!['collection', 'collection_slug', 'schema', 'schema_slug', 'limit', 'offset', 'page', 'site_id', 'format'].includes(key)) {
            if (!/^[a-zA-Z0-9_]{1,64}$/.test(key)) {
                hasInvalidKey = true;
                return;
            }
            filters[key] = value;
        }
    });

    if (hasInvalidKey) {
        return c.json({
            error: 'Bad Request: Invalid filter field name',
            code: 'SECURITY_INVALID_FILTER_KEY'
        }, 400);
    }

    const filterKeyPart = Object.entries(filters)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
    const cacheKey = `datasets:${siteId}:${isAuthorizedUser}:${allowApiOnly}:${schemaSlug || ''}:${limit}:${offset}:${filterKeyPart}`;

    return respondHeadlessFormatCached(c, cacheKey, format, host, allowApiOnly, async () => {
        const [site, siteSchemas, rawRes] = await Promise.all([
            accessRes.site ? Promise.resolve(accessRes.site) : findSiteById(db, siteId),
            findSchemasBySite(db, siteId).catch(() => []),
            queryDatasetsWithJson1Filter(
                db,
                siteId,
                schemaSlug,
                Object.keys(filters).length > 0 ? filters : undefined,
                limit,
                offset,
                !isAuthorizedUser,
                !allowApiOnly
            )
        ]);

        const apiOnlySchemaSet = new Set((siteSchemas || []).filter((s: any) => s.api_only).map((s: any) => s.slug));
        const settings = parseJson<Record<string, any>>(site?.settings, {});
        const visibleRawItems = !allowApiOnly
            ? (rawRes.items || []).filter((it: any) => !apiOnlySchemaSet.has(it.schema_slug))
            : (rawRes.items || []);

        const enrichedItems = visibleRawItems.map((it: any) => {
            const meta = parseJson<Record<string, any>>(it.metadata, {});
            const fieldsObj = (meta.fields && typeof meta.fields === 'object') ? meta.fields : {};
            const isApiOnly = apiOnlySchemaSet.has(it.schema_slug) || it.status === 'api_only';
            return {
                ...it,
                type: 'dataset',
                visibility: isApiOnly ? 'api_only' : 'public',
                fields: fieldsObj,
                metadata: meta,
                author: { name: meta.author || site?.name || 'Admin' },
                seo: {
                    title: meta.seo_title || it.title || '',
                    description: meta.seo_description || it.summary || '',
                    og_image: fieldsObj.image || fieldsObj.cover || settings.seo?.og_image || null,
                    robots: isApiOnly ? 'noindex, nofollow' : (settings.seo?.robots || 'index, follow')
                }
            };
        });

        const total = rawRes.total || 0;
        return {
            site,
            payload: {
                meta: {
                    headless: true,
                    format: 'json',
                    site: buildHeadlessSiteMeta(site),
                    pagination: buildHeadlessPagination(page, limit, total),
                    generated_at: new Date().toISOString()
                },
                items: enrichedItems,
                nodes: enrichedItems,
                total
            }
        };
    });
}

publicQueriesRouter.get('/dataset', handleQueryDatasetList);
publicQueriesRouter.get('/datasets', handleQueryDatasetList);

async function handleQueryMediaList(c: Context<AppHonoEnv>) {
    const envRes = getApiQueryEnv(c);
    if ('err' in envRes) return envRes.err;
    const { db, siteId, isAuthorizedUser } = envRes;

    const accessRes = await resolveApiReadAccess(c, db, siteId, isAuthorizedUser, 'media:read');
    if ('err' in accessRes) return accessRes.err;

    const id = c.req.query('id');
    const mime = c.req.query('mime') || c.req.query('type');
    const folder = c.req.query('folder');
    const normPage = normalizePagination({
        page: c.req.query('page'),
        limit: c.req.query('limit')
    });
    const cacheKey = `media:${siteId}:${id || ''}:${mime || ''}:${folder || ''}:${normPage.page}:${normPage.limit}:${c.env?.PUBLIC_ASSETS_DOMAIN || ''}`;
    return respondCachedQuery(c, cacheKey, async () => {
        const items = await queryPublicMediaAssets(db, siteId, {
            id,
            mime,
            folder,
            limit: normPage.limit,
            offset: normPage.offset,
            publicAssetsDomain: c.env?.PUBLIC_ASSETS_DOMAIN
        });
        return { items, nodes: items, total: items.length };
    }, 30, accessRes.allowApiOnly);
}

publicQueriesRouter.get('/media', handleQueryMediaList);
publicQueriesRouter.get('/medias', handleQueryMediaList);

async function handleQueryFeed(c: Context<AppHonoEnv>) {
    const envRes = getApiQueryEnv(c);
    if ('err' in envRes) return envRes.err;
    const { db, siteId, isAuthorizedUser } = envRes;

    const accessRes = await resolveApiReadAccess(c, db, siteId, isAuthorizedUser, 'nodes:read');
    if ('err' in accessRes) return accessRes.err;
    const { allowApiOnly } = accessRes;

    const params = new URL(c.req.url).searchParams;
    const format = params.get('format') || 'json';
    const host = c.get('host') || DEFAULT_DEV_HOST;
    const cacheParts = Array.from(params.entries())
        .filter(([k]) => k !== 'site_id' && k !== 'format')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
    const cacheKey = `feed:${siteId}:${allowApiOnly}:${cacheParts}`;

    return respondHeadlessFormatCached(c, cacheKey, format, host, allowApiOnly, async () => {
        const site = accessRes.site || await findSiteById(db, siteId);
        const items = await queryAggregatedFeed(db, siteId, params, c.get('locale'), !allowApiOnly);
        return {
            site,
            payload: {
                meta: {
                    headless: true,
                    format: 'json',
                    site: buildHeadlessSiteMeta(site),
                    generated_at: new Date().toISOString()
                },
                items,
                nodes: items,
                total: items.length
            }
        };
    });
}

publicQueriesRouter.get('/feed', handleQueryFeed);
publicQueriesRouter.get('/feeds', handleQueryFeed);
