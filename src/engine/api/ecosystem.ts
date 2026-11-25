import { Hono, type Context } from 'hono';
import type { AppHonoEnv } from '../types';
import {
    checkQueryRateLimit,
    computeTokenSha256,
    findApiTokenByHash,
    touchApiTokenLastUsed
} from '../core/dal';
import { ALLOWED_ECOSYSTEM_APPS, ECOSYSTEM_APP_HEADERS } from '../services/ecosystem-bridge.plugin';
import { resolveCurrentUser } from '../core/auth';
import { createHookContext } from '../kernel';
import { DEFAULT_DEV_HOST } from '../core/url';
import { isSiteAdminUser, verifySameOriginRequest } from '../core/utils';

export const ecosystemRouter = new Hono<AppHonoEnv>();

const MAX_ECOSYSTEM_BODY_BYTES = 256 * 1024;

ecosystemRouter.post('/ecosystem/pair', async (c) => {
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

ecosystemRouter.post('/ecosystem/exchange', async (c) => {
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

ecosystemRouter.post('/ecosystem/sync', async (c) => {
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

ecosystemRouter.all('/v1/nodes', (c) => handleCommercialV1Gateway(c, 'nodes'));
ecosystemRouter.all('/v1/datasets', (c) => handleCommercialV1Gateway(c, 'datasets'));
ecosystemRouter.all('/v1/datasets/:schema', (c) => handleCommercialV1Gateway(c, 'datasets', c.req.param('schema')));
