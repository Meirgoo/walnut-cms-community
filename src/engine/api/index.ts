import { Hono, type Context } from 'hono';
import type { AppHonoEnv, MediaAsset } from '../types';
import { findSiteById, resolveSiteWithMemoryCache } from '../core/dal';
import { resolveCurrentUser } from '../core/auth';
import { createHookContext } from '../kernel';
import { t, getAdminLocale } from '../core/i18n';
import { DEFAULT_DEV_HOST } from '../core/url';
import { isSiteAdminUser, verifySameOriginRequest, parseJson } from '../core/utils';
import { quickActionsRouter } from './quick-actions';
import { publicQueriesRouter, resolveApiReadAccess } from './public-queries';
import { ecosystemRouter } from './ecosystem';

export const apiApp = new Hono<AppHonoEnv>();

apiApp.route('/', publicQueriesRouter);
apiApp.route('/', ecosystemRouter);

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
        const maxFormBytes = 512 * 1024;
        const contentLen = Number(c.req.header('content-length') || 0);
        if (contentLen > maxFormBytes) {
            return c.json({ success: false, code: 'PAYLOAD_TOO_LARGE', error: 'Payload exceeds 512KB limit' }, 413);
        }
        // Measure actual buffered bytes so Transfer-Encoding: chunked cannot bypass Content-Length.
        const rawBuf = await c.req.arrayBuffer();
        if (rawBuf.byteLength > maxFormBytes) {
            return c.json({ success: false, code: 'PAYLOAD_TOO_LARGE', error: 'Payload exceeds 512KB limit' }, 413);
        }
        const contentType = (c.req.header('content-type') || '').toLowerCase();
        let rawPayload: Record<string, any> = {};
        if (contentType.includes('application/json')) {
            const rawText = new TextDecoder().decode(rawBuf);
            rawPayload = rawText.trim() ? JSON.parse(rawText) : {};
        } else if (contentType.includes('multipart/form-data')) {
            const fd = await new Request(c.req.url, {
                method: c.req.method,
                headers: c.req.raw.headers,
                body: rawBuf
            }).formData();
            fd.forEach((v, k) => {
                rawPayload[k] = typeof v === 'string' ? v : (v as File)?.name || '';
            });
        } else {
            const rawText = new TextDecoder().decode(rawBuf);
            rawPayload = Object.fromEntries(new URLSearchParams(rawText).entries());
        }

        const siteId = (rawPayload.siteId || rawPayload.site_id || c.get('siteId') || 'site_default') as string;
        const db = c.env.DB;
        if (db) {
            const host = c.get('host') || c.req.header('host') || DEFAULT_DEV_HOST;
            const resolved = await resolveSiteWithMemoryCache(db, host);
            const site = (resolved && resolved.id === siteId) ? resolved : await findSiteById(db, siteId);
            if (site) {
                const settings = parseJson<Record<string, any>>(site.settings, {});
                const rawMode = settings.site_mode as string | undefined;
                const isInternal = rawMode === 'internal' || rawMode === 'maintenance' || settings.routing?.maintenance_mode === 1;
                if (isInternal) {
                    const user = c.get('user') || await resolveCurrentUser(c).catch(() => null);
                    const hasAdmin = isSiteAdminUser(user);
                    const accessRes = hasAdmin ? { allowApiOnly: true } : await resolveApiReadAccess(c, db, siteId, false, 'forms:submit');
                    const authHeader = c.req.header('authorization') || '';
                    const hasBearer = authHeader.startsWith('Bearer ') || Boolean(c.req.header('x-api-key'));
                    if ('err' in accessRes) return accessRes.err;
                    if (!hasAdmin && !hasBearer) {
                        return c.json({ success: false, code: 'INTERNAL_MODE_FORBIDDEN', error: 'Forbidden: Internal mode blocks unauthenticated form submissions' }, 403);
                    }
                }
            }
        }
        const paramFormId = c.req.param('form_id');
        const formId = (paramFormId || rawPayload.form_id || rawPayload.formId || rawPayload.form_name || rawPayload.formName || 'default') as string;
        const formName = (rawPayload.form_name || rawPayload.formName || formId) as string;

        // Strip caller-supplied webhookUrl so the Worker cannot be abused as an SSRF or flood relay.
        const rawFieldsObj: Record<string, unknown> =
            rawPayload.fields && typeof rawPayload.fields === 'object'
                ? (rawPayload.fields as Record<string, unknown>)
                : Object.fromEntries(
                      Object.entries(rawPayload).filter(
                          ([k]) => !['siteId', 'site_id', 'formName', 'form_name', 'formId', 'form_id', 'webhookUrl', 'webhook_url'].includes(k)
                      )
                  );

        // Enforce field count and value length limits across both community and commercial editions.
        const fields: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rawFieldsObj).slice(0, 50)) {
            const safeKey = String(k).trim().slice(0, 64);
            if (!safeKey) continue;
            fields[safeKey] = typeof v === 'string'
                ? v.slice(0, 4000)
                : (typeof v === 'number' || typeof v === 'boolean' || v == null)
                    ? v
                    : JSON.stringify(v).slice(0, 4000);
        }

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
