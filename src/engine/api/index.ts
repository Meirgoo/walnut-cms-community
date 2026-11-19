import { Hono, type Context } from 'hono';
import type { AppHonoEnv, MediaAsset } from '../types';
import {
    checkQueryRateLimit,
    getCachedQueryResult,
    setCachedQueryResult,
    normalizePagination,
    queryNodesWithFilters,
    queryDatasetsWithJson1Filter,
    queryPublicMediaAssets,
    computeTokenSha256,
    findApiTokenByHash,
    touchApiTokenLastUsed
} from '../core/dal';
import { ALLOWED_ECOSYSTEM_APPS, ECOSYSTEM_APP_HEADERS } from '../services/ecosystem-bridge.plugin';
import { resolveCurrentUser } from '../core/auth';
import { createHookContext } from '../kernel';
import { t, getAdminLocale } from '../core/i18n';
import { DEFAULT_DEV_HOST } from '../core/url';
import { extractClientIp, isSiteAdminUser, verifySameOriginRequest } from '../core/utils';
import { queryAggregatedFeed } from '../render/api-protocol';
import { quickActionsRouter } from './quick-actions';

export const apiApp = new Hono<AppHonoEnv>();

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

async function respondCachedQuery<T>(c: Context<AppHonoEnv>, cacheKey: string, fetcher: () => Promise<T>, ttl = 30) {
    const cached = getCachedQueryResult(cacheKey);
    c.header('Cache-Control', 'public, max-age=60');
    if (cached) {
        c.header('X-Edge-Cache', 'HIT');
        return c.json(cached);
    }
    const result = await fetcher();
    setCachedQueryResult(cacheKey, result, ttl);
    c.header('X-Edge-Cache', 'MISS');
    return c.json(result);
}

apiApp.get('/health', (c) => c.json({
    status: 'ok',
    timestamp: new Date().toISOString()
}));

async function handleQueryContentList(c: Context<AppHonoEnv>, forcedType?: string) {
    const envRes = getApiQueryEnv(c);
    if ('err' in envRes) return envRes.err;
    const { db, siteId, isAuthorizedUser } = envRes;

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
    const normPage = normalizePagination({
        page: c.req.query('page'),
        limit: c.req.query('limit')
    });

    const cacheKey = `content:${siteId}:${isAuthorizedUser}:${id || ''}:${slug || ''}:${maturity || ''}:${folder || ''}:${locale || ''}:${type}:${status}:${tag}:${target}:${fields}:${normPage.page}:${normPage.limit}`;
    return respondCachedQuery(c, cacheKey, () => queryNodesWithFilters(db, {
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
        page: normPage.page,
        limit: normPage.limit
    }, isAuthorizedUser));
}

apiApp.get('/articles', (c) => handleQueryContentList(c, 'article'));

apiApp.get('/micro', (c) => handleQueryContentList(c, 'micro'));
apiApp.get('/micros', (c) => handleQueryContentList(c, 'micro'));

async function handleQueryDatasetList(c: Context<AppHonoEnv>) {
    const envRes = getApiQueryEnv(c);
    if ('err' in envRes) return envRes.err;
    const { db, siteId, isAuthorizedUser } = envRes;

    const schemaSlug = c.req.query('schema') || c.req.query('schema_slug');
    const limit = Math.max(1, Math.min(100, Number(c.req.query('limit')) || 50));
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const offset = c.req.query('offset') !== undefined
        ? Math.max(0, Number(c.req.query('offset')) || 0)
        : (page - 1) * limit;

    const filters: Record<string, string> = {};
    const queryParams = new URL(c.req.url).searchParams;
    let hasInvalidKey = false;
    queryParams.forEach((value, key) => {
        if (!['schema', 'schema_slug', 'limit', 'offset', 'page', 'site_id'].includes(key)) {
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
    const cacheKey = `datasets:${siteId}:${isAuthorizedUser}:${schemaSlug || ''}:${limit}:${offset}:${filterKeyPart}`;

    return respondCachedQuery(c, cacheKey, () => queryDatasetsWithJson1Filter(
        db,
        siteId,
        schemaSlug,
        Object.keys(filters).length > 0 ? filters : undefined,
        limit,
        offset,
        !isAuthorizedUser
    ));
}

apiApp.get('/dataset', handleQueryDatasetList);
apiApp.get('/datasets', handleQueryDatasetList);

async function handleQueryMediaList(c: Context<AppHonoEnv>) {
    const envRes = getApiQueryEnv(c);
    if ('err' in envRes) return envRes.err;
    const { db, siteId } = envRes;

    const id = c.req.query('id');
    const mime = c.req.query('mime') || c.req.query('type');
    const folder = c.req.query('folder');
    const normPage = normalizePagination({
        page: c.req.query('page'),
        limit: c.req.query('limit')
    });
    const cacheKey = `media:${siteId}:${id || ''}:${mime || ''}:${folder || ''}:${normPage.page}:${normPage.limit}`;
    return respondCachedQuery(c, cacheKey, async () => {
        const items = await queryPublicMediaAssets(db, siteId, {
            id,
            mime,
            folder,
            limit: normPage.limit,
            offset: normPage.offset
        });
        return { items, nodes: items, total: items.length };
    });
}

apiApp.get('/media', handleQueryMediaList);
apiApp.get('/medias', handleQueryMediaList);

async function handleQueryFeed(c: Context<AppHonoEnv>) {
    const envRes = getApiQueryEnv(c);
    if ('err' in envRes) return envRes.err;
    const { db, siteId } = envRes;

    const params = new URL(c.req.url).searchParams;
    const cacheParts = Array.from(params.entries())
        .filter(([k]) => k !== 'site_id')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
    const cacheKey = `feed:${siteId}:${cacheParts}`;

    return respondCachedQuery(c, cacheKey, async () => {
        const items = await queryAggregatedFeed(db, siteId, params, c.get('locale'));
        return { items, nodes: items, total: items.length };
    });
}

apiApp.get('/feed', handleQueryFeed);
apiApp.get('/feeds', handleQueryFeed);

const FORBIDDEN_UPLOAD_EXTENSIONS = new Set([
    'html', 'htm', 'xhtml', 'shtml', 'js', 'mjs', 'cjs', 'ts', 'tsx',
    'php', 'phtml', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1',
    'exe', 'dll', 'so', 'dylib', 'jsp', 'asp', 'aspx', 'py', 'rb', 'pl', 'cgi'
]);

const MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024;

export async function handleMediaUpload(c: Context<AppHonoEnv>) {
    const user = c.get('user') || await resolveCurrentUser(c);
    const locale = getAdminLocale(c);

    if (!user) {
        return c.json({ error: 'Unauthorized: Authentication required for media upload', code: 'UNAUTHENTICATED' }, 401);
    }
    const isSuperAdmin = user.global_role === 'superadmin';
    const isSiteAdmin = user.site_role === 'admin';
    if (!isSuperAdmin && !isSiteAdmin) {
        return c.json({ error: 'Forbidden: Admin privileges required for media upload', code: 'FORBIDDEN' }, 403);
    }

    try {
        const body = await c.req.parseBody();
        const file = (body['file'] || body['image']) as File;
        if (!file || typeof file.arrayBuffer !== 'function') {
            return c.json({ error: `${t(locale, 'common.error')}: File missing` }, 400);
        }

        if (file.size > MAX_UPLOAD_SIZE_BYTES) {
            return c.json({ error: 'Payload Too Large: File exceeds 25MB limit', code: 'FILE_TOO_LARGE' }, 413);
        }

        const originalName = (file.name || '').trim();
        const ext = (originalName.includes('.') ? originalName.split('.').pop() : '')?.toLowerCase() || '';
        const mime = (file.type || '').toLowerCase();

        if (
            FORBIDDEN_UPLOAD_EXTENSIONS.has(ext) ||
            mime.includes('text/html') ||
            mime.includes('application/javascript') ||
            mime.includes('text/javascript') ||
            mime.includes('application/x-httpd-php')
        ) {
            return c.json({
                error: 'Forbidden File Type: Executable or active HTML/script uploads are prohibited',
                code: 'SECURITY_FORBIDDEN_FILE_TYPE'
            }, 400);
        }

        // Reject SVGs containing active scripts, inline event handlers, or foreignObject to prevent stored XSS.
        if (ext === 'svg' || mime.includes('svg')) {
            const textContent = await file.text();
            if (
                /<\s*script\b/i.test(textContent) ||
                /\bon[a-z]+\s*=/i.test(textContent) ||
                /javascript\s*:/i.test(textContent) ||
                /<\s*foreignObject\b/i.test(textContent)
            ) {
                return c.json({
                    error: 'Security Violation: SVG contains active scripts or event handlers',
                    code: 'SECURITY_SVG_XSS_BLOCKED'
                }, 400);
            }
        }

        const siteId = c.get('siteId') || 'site_default';
        const pluginEngine = c.get('pluginEngine');

        const txContext = createHookContext<
            { file: File; siteId: string; uploaderId?: string },
            MediaAsset
        >({
            action: 'MEDIA_UPLOAD',
            data: {
                file,
                siteId,
                uploaderId: user.id
            },
            c,
            user,
            siteId
        });

        const asset = await pluginEngine.runPipeline(txContext);

        return c.json({
            id: asset.id,
            file_name: asset.file_name,
            url: asset.public_url,
            r2_key: asset.r2_key
        });
    } catch (e: any) {
        console.error('R2 media upload action error:', e);
        return c.json({ error: `${t(locale, 'common.error')}: ${e.message || 'R2 error'}` }, 500);
    }
}

apiApp.post('/upload', async (c) => {
    const originCheck = verifySameOriginRequest(c, DEFAULT_DEV_HOST);
    if (!originCheck.valid) {
        return c.json({ success: false, error: originCheck.error || 'Forbidden' }, 403);
    }
    return handleMediaUpload(c);
});

async function handleWebhookSubmit(c: Context<AppHonoEnv>) {
    try {
        const contentLen = Number(c.req.header('content-length') || 0);
        if (contentLen > 512 * 1024) {
            return c.json({ success: false, code: 'PAYLOAD_TOO_LARGE', error: 'Payload exceeds 512KB limit' }, 413);
        }
        const contentType = (c.req.header('content-type') || '').toLowerCase();
        let rawPayload: Record<string, any>;
        if (contentType.includes('application/json')) {
            rawPayload = await c.req.json();
        } else {
            rawPayload = await c.req.parseBody();
        }

        const siteId = (rawPayload.siteId || rawPayload.site_id || c.get('siteId') || 'site_default') as string;
        const paramFormId = c.req.param('form_id');
        const formId = (paramFormId || rawPayload.form_id || rawPayload.formId || rawPayload.form_name || rawPayload.formName || 'default') as string;
        const formName = (rawPayload.form_name || rawPayload.formName || formId) as string;

        // Strip caller-supplied webhookUrl so the Worker cannot be abused as an SSRF or flood relay.
        const fields: Record<string, unknown> =
            rawPayload.fields && typeof rawPayload.fields === 'object'
                ? (rawPayload.fields as Record<string, unknown>)
                : Object.fromEntries(
                      Object.entries(rawPayload).filter(
                          ([k]) => !['siteId', 'site_id', 'formName', 'form_name', 'formId', 'form_id', 'webhookUrl', 'webhook_url'].includes(k)
                      )
                  );

        const pluginEngine = c.get('pluginEngine');
        const txContext = createHookContext({
            action: 'WEBHOOK_SUBMIT',
            data: {
                siteId,
                formId,
                formName,
                fields
            },
            c,
            siteId
        });

        const result = await pluginEngine.runPipeline(txContext);
        return c.json({ success: true, data: result });
    } catch (e: any) {
        const msg = String(e?.message || 'Webhook submission failed');
        if (msg.includes('TOO_MANY_REQUESTS') || msg.includes('BLOCKED_BY_API_SHIELD')) {
            return c.json({ success: false, error: msg }, 429);
        }
        if (msg.includes('LICENSE_')) {
            return c.json({ success: false, error: msg }, 403);
        }
        return c.json({ success: false, error: msg }, 400);
    }
}

apiApp.post('/forms/submit/:form_id', handleWebhookSubmit);
apiApp.post('/forms/submit', handleWebhookSubmit);
apiApp.post('/webhooks/submit/:form_id', handleWebhookSubmit);
apiApp.post('/webhooks/submit', handleWebhookSubmit);

apiApp.route('/quick-actions', quickActionsRouter);

const MAX_ECOSYSTEM_BODY_BYTES = 256 * 1024;

apiApp.post('/ecosystem/pair', async (c) => {
    const originCheck = verifySameOriginRequest(c, DEFAULT_DEV_HOST);
    if (!originCheck.valid) return c.json({ error: originCheck.error || 'Forbidden' }, 403);
    const db = c.env.DB;
    if (!db) return c.json({ error: 'Database unavailable' }, 500);
    const user = c.get('user') || (await resolveCurrentUser(c));
    if (!isSiteAdminUser(user)) {
        return c.json({ error: 'Unauthorized: Admin access required' }, 403);
    }
    const body = await c.req.json().catch(() => ({})) as { app?: string; siteId?: string };
    const appName = (body.app || 'grain').trim();
    if (!ALLOWED_ECOSYSTEM_APPS.has(appName)) {
        return c.json({ error: 'Unsupported ecosystem app', code: 'UNSUPPORTED_ECOSYSTEM_APP' }, 403);
    }
    const siteId = body.siteId || c.get('siteId') || 'site_default';
    const pluginEngine = c.get('pluginEngine');
    const txContext = createHookContext({
        action: 'ECOSYSTEM_ISSUE_CODE',
        data: { siteId, app: appName },
        c,
        siteId,
        user
    });
    try {
        const result = await pluginEngine.runPipeline(txContext);
        return c.json(result);
    } catch (e: any) {
        return c.json({ error: e?.message || 'Pairing failed' }, 400);
    }
});

function readEcosystemAppHeader(c: Context<AppHonoEnv>): string {
    for (const h of ECOSYSTEM_APP_HEADERS) {
        const v = (c.req.header(h) || '').trim();
        if (v) return v;
    }
    return '';
}

apiApp.post('/ecosystem/exchange', async (c) => {
    const db = c.env.DB;
    if (!db) return c.json({ error: 'Database unavailable' }, 500);
    const appHeader = readEcosystemAppHeader(c);
    if (appHeader && !ALLOWED_ECOSYSTEM_APPS.has(appHeader)) {
        return c.json({ error: 'Forbidden ecosystem app header', code: 'FORBIDDEN_ECOSYSTEM_APP' }, 403);
    }
    const body = await c.req.json().catch(() => ({})) as { code?: string };
    const code = (body.code || '').trim();
    if (!code) {
        return c.json({ error: 'Missing one-time code', code: 'CODE_REQUIRED' }, 400);
    }
    const pluginEngine = c.get('pluginEngine');
    try {
        const txContext = createHookContext({
            action: 'ECOSYSTEM_EXCHANGE_TOKEN',
            data: { code, app: appHeader || undefined },
            c,
            siteId: c.get('siteId') || 'site_default'
        });
        const result = await pluginEngine.runPipeline(txContext);
        return c.json(result);
    } catch (err: any) {
        return c.json({ error: err?.message || 'Invalid or expired code', code: 'INVALID_OR_EXPIRED_CODE' }, 403);
    }
});

apiApp.post('/ecosystem/sync', async (c) => {
    const db = c.env.DB;
    if (!db) return c.json({ error: 'Database unavailable' }, 500);

    const appHeader = readEcosystemAppHeader(c);
    if (!appHeader || !ALLOWED_ECOSYSTEM_APPS.has(appHeader)) {
        return c.json({ error: 'Forbidden: Missing or invalid ecosystem app header', code: 'FORBIDDEN_ECOSYSTEM_APP' }, 403);
    }

    const contentLength = Number(c.req.header('Content-Length') || 0);
    if (contentLength > MAX_ECOSYSTEM_BODY_BYTES) {
        return c.json({ error: 'Payload Too Large: Max 256KB allowed', code: 'PAYLOAD_TOO_LARGE' }, 413);
    }
    const rawText = await c.req.text();
    if (new TextEncoder().encode(rawText).byteLength > MAX_ECOSYSTEM_BODY_BYTES) {
        return c.json({ error: 'Payload Too Large: Max 256KB allowed', code: 'PAYLOAD_TOO_LARGE' }, 413);
    }

    const authHeader = c.req.header('Authorization') || '';
    const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!rawToken) {
        return c.json({ error: 'Missing Bearer token', code: 'TOKEN_REQUIRED' }, 401);
    }
    const tokenHash = await computeTokenSha256(rawToken);
    const siteId = c.get('siteId') || 'site_default';
    const tokenRow = await findApiTokenByHash(db, tokenHash, siteId);
    if (!tokenRow) {
        return c.json({ error: 'Invalid ecosystem token', code: 'UNAUTHORIZED_TOKEN' }, 401);
    }
    if (tokenRow.token_type !== 'ecosystem' && tokenRow.token_type !== 'ecosystem_epub') {
        return c.json({ error: 'Token type mismatch: ecosystem token required', code: 'TOKEN_TYPE_MISMATCH' }, 403);
    }
    if (tokenRow.expires_at && Date.now() > new Date(tokenRow.expires_at).getTime()) {
        return c.json({ error: 'Token expired', code: 'TOKEN_EXPIRED' }, 401);
    }

    const targetSiteId = tokenRow.site_id || siteId;
    if (!checkQueryRateLimit(`eco_sync:${targetSiteId}`, 10)) {
        return c.json({ error: 'Too Many Requests: Ecosystem sync rate limit exceeded (10/min)', code: 'RATE_LIMITED' }, 429);
    }

    let parsedPayload: any = null;
    try {
        parsedPayload = JSON.parse(rawText);
    } catch {
        return c.json({ error: 'Invalid JSON payload', code: 'INVALID_JSON' }, 400);
    }
    if (!parsedPayload || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload)) {
        return c.json({ error: 'Payload must be a JSON object', code: 'INVALID_JSON_OBJECT' }, 400);
    }

    const pluginEngine = c.get('pluginEngine');
    const txContext = createHookContext({
        action: 'ECOSYSTEM_LOOSE_SYNC',
        data: { siteId: targetSiteId, app: appHeader, payload: parsedPayload },
        c,
        siteId: targetSiteId,
        user: {
            id: tokenRow.created_by || 'ecosystem:bridge',
            username: `eco-${appHeader}`,
            email: `${appHeader}@ecosystem.local`,
            global_role: 'superadmin',
            site_role: 'admin',
            auth_provider: 'session'
        }
    });
    try {
        const result = await pluginEngine.runPipeline(txContext);
        try {
            c.executionCtx?.waitUntil?.(touchApiTokenLastUsed(db, tokenRow.id));
        } catch {
            touchApiTokenLastUsed(db, tokenRow.id).catch(() => {});
        }
        return c.json(result);
    } catch (e: any) {
        return c.json({ error: e?.message || 'Ecosystem sync failed' }, 400);
    }
});

async function handleCommercialV1Gateway(c: Context<AppHonoEnv>, resource: 'nodes' | 'datasets', schema?: string) {
    const authHeader = c.req.header('Authorization') || '';
    const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const pluginEngine = c.get('pluginEngine');
    if (!pluginEngine) {
        return c.json({ error: 'Commercial license required for Open REST API (/api/v1/*)', code: 'COMMERCIAL_REQUIRED' }, 403);
    }
    const siteId = c.get('siteId') || 'site_default';
    const method = c.req.method.toUpperCase();
    const body = (method === 'POST' || method === 'PUT' || method === 'PATCH')
        ? await c.req.json().catch(() => ({}))
        : undefined;

    try {
        const txContext = createHookContext({
            action: 'API_V1_GATEWAY',
            data: {
                rawToken,
                method,
                resource,
                schema,
                query: c.req.query(),
                body,
                siteId
            },
            c,
            siteId
        });
        const result = await pluginEngine.runPipeline(txContext);
        return c.json(result);
    } catch (err: any) {
        const msg = String(err?.message || 'Forbidden');
        if (msg.includes('TOKEN_EMPTY') || msg.includes('TOKEN_NOT_FOUND') || msg.includes('TOKEN_EXPIRED')) {
            return c.json({ error: msg, code: 'UNAUTHORIZED_TOKEN' }, 401);
        }
        return c.json({ error: msg, code: msg.includes('SCOPE') ? 'FORBIDDEN_SCOPE' : 'COMMERCIAL_REQUIRED' }, 403);
    }
}

apiApp.all('/v1/nodes', (c) => handleCommercialV1Gateway(c, 'nodes'));
apiApp.all('/v1/datasets', (c) => handleCommercialV1Gateway(c, 'datasets'));
apiApp.all('/v1/datasets/:schema', (c) => handleCommercialV1Gateway(c, 'datasets', c.req.param('schema')));
