import type { Context } from 'hono';
import { getCookie, getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import type { AuthenticatedUser, SiteRole } from '../../types';
import type { AppHonoEnv } from '../../types';
import { findSessionUserWithRole, findUserMetadataById, type SessionUserRow } from '../dal';
import { isCFAccessBuildEnabled } from './cf-access';
import { isSecureContext } from '../url';
import { parseJson } from '../utils';

const SESSION_COOKIE_NAME = 'edge_session';

export const NOCFA_SETUP_CONTEXT = 'walnut:nocfa:setup';

export function resolveSetupMasterSecret(c: Context<AppHonoEnv>): string | null {
    const env = c.env as any;
    const sessionSecret = typeof env?.SESSION_SECRET === 'string' ? env.SESSION_SECRET.trim() : '';
    if (sessionSecret) return sessionSecret;
    const jwtSecret = typeof env?.JWT_SECRET === 'string' ? env.JWT_SECRET.trim() : '';
    return jwtSecret || null;
}

// Domain-separated HMAC derivation ensures the initial setup password never exposes raw SESSION_SECRET bytes.
export async function deriveNoCfaSetupPassword(secret: string): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(NOCFA_SETUP_CONTEXT));
    const hex = Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    return hex.slice(0, 16);
}

async function timingSafeSha256Equal(a: string, b: string): Promise<boolean> {
    const enc = new TextEncoder();
    const [ha, hb] = await Promise.all([
        crypto.subtle.digest('SHA-256', enc.encode(a)),
        crypto.subtle.digest('SHA-256', enc.encode(b))
    ]);
    const subtleAny = crypto.subtle as unknown as { timingSafeEqual?: (x: BufferSource, y: BufferSource) => boolean };
    if (typeof subtleAny.timingSafeEqual === 'function') {
        return subtleAny.timingSafeEqual(ha, hb);
    }
    const va = new Uint8Array(ha);
    const vb = new Uint8Array(hb);
    let diff = va.length ^ vb.length;
    for (let i = 0; i < va.length; i++) {
        diff |= va[i] ^ vb[i];
    }
    return diff === 0;
}

export async function verifyNoCfaSetupPassword(c: Context<AppHonoEnv>, submitted: string): Promise<boolean> {
    const masterSecret = resolveSetupMasterSecret(c);
    if (!masterSecret) return false;
    const trimmed = submitted.trim();
    if (!trimmed) return false;
    const expected = await deriveNoCfaSetupPassword(masterSecret);
    return timingSafeSha256Equal(trimmed, expected);
}

export function getSessionSecret(c: Context<AppHonoEnv>): string {
    const env = c.env as any;
    const configured = resolveSetupMasterSecret(c);
    if (configured) return configured;

    // Never fall back to public keys or static salts outside local development.
    const isDevEnv = !env?.ENVIRONMENT || env.ENVIRONMENT === 'development';
    if (isDevEnv) {
        const host = (c.get?.('host') || c.req?.header?.('host') || '').toLowerCase();
        if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
            return 'walnut-dev-local-session-secret-only';
        }
    }
    throw new Error('SESSION_SECRET_NOT_CONFIGURED');
}

function parseSessionCookiePayload(raw: string): { userId: string; tokenVersion: number } | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^(.+):tv(\d+)$/);
    if (!match) return null;
    const userId = match[1].trim();
    const tokenVersion = Number(match[2]);
    if (!userId || !Number.isFinite(tokenVersion) || tokenVersion < 1) return null;
    return { userId, tokenVersion };
}

async function getSessionCookiePayload(c: Context<AppHonoEnv>): Promise<{ userId: string; tokenVersion: number } | null> {
    try {
        const secret = getSessionSecret(c);
        const signedVal = await getSignedCookie(c, secret, SESSION_COOKIE_NAME);
        if (typeof signedVal === 'string') {
            return parseSessionCookiePayload(signedVal);
        }
        return null;
    } catch {
        return null;
    }
}

export async function getSessionUserId(c: Context<AppHonoEnv>): Promise<string | null> {
    const parsed = await getSessionCookiePayload(c);
    return parsed?.userId || null;
}

export async function setSessionCookie(c: Context<AppHonoEnv>, userId: string, maxAgeDays = 7, tokenVersion?: number): Promise<void> {
    const secret = getSessionSecret(c);
    let tv = tokenVersion;
    if (tv === undefined && c.env?.DB) {
        try {
            const meta = await findUserMetadataById(c.env.DB, userId);
            tv = Number(meta?.token_version) || 1;
        } catch {
            tv = 1;
        }
    }
    const isHttps = isSecureContext(c);
    await setSignedCookie(c, SESSION_COOKIE_NAME, `${userId}:tv${tv || 1}`, secret, {
        path: '/',
        secure: isHttps,
        httpOnly: true,
        sameSite: 'Strict',
        maxAge: 60 * 60 * 24 * maxAgeDays,
    });
}

export function clearSessionCookie(c: Context<AppHonoEnv>): void {
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
}

export async function resolveCurrentUser(c: Context<AppHonoEnv>): Promise<AuthenticatedUser | null> {
    const db = c.env.DB;
    if (!db) return null;

    const siteId = c.get('siteId');
    let userRecord: SessionUserRow | null = null;
    let authProvider: AuthenticatedUser['auth_provider'] = 'session';

    // Prioritize signed session cookie so password login and explicit logout always work even behind CF Access.
    const sessionPayload = await getSessionCookiePayload(c);
    if (sessionPayload) {
        try {
            const candidate = await findSessionUserWithRole(db, { id: sessionPayload.userId }, siteId);
            if (candidate) {
                const pref = parseJson<Record<string, any>>(candidate.user_pref_json, {});
                const currentTv = Number(pref.token_version) || 1;
                if (sessionPayload.tokenVersion === currentTv) {
                    userRecord = candidate;
                    authProvider = 'session';
                }
            }
        } catch {}
    }

    if (!userRecord && isCFAccessBuildEnabled() && getCookie(c, 'edge_no_auto_cfa') !== '1') {
        const cfAccessEmail = c.get('cfAccessEmail');
        if (cfAccessEmail) {
            try {
                userRecord = await findSessionUserWithRole(db, { email: cfAccessEmail }, siteId);
                if (userRecord) authProvider = 'cf_access';
            } catch {}
        }
    }

    // Local-only dev probe auth bypass; disabled when ENVIRONMENT is production or host is non-local.
    if (!userRecord) {
        const host = c.get('host') || c.req.header('host') || '';
        const isLocalHost = host.startsWith('localhost') || host.startsWith('127.0.0.1');
        const isDevEnv = !c.env?.ENVIRONMENT || c.env.ENVIRONMENT === 'development';
        const devAuthToken = c.req.header('X-Edge-Dev-Auth') || c.req.query('__edge_dev_auth');
        if (isLocalHost && isDevEnv && devAuthToken === 'admin') {
            try {
                userRecord = await findSessionUserWithRole(db, { identifier: 'admin' }, siteId);
                if (userRecord) authProvider = 'session';
            } catch {}
        }
    }

    if (!userRecord) return null;

    const siteRole: SiteRole | undefined =
        userRecord.global_role === 'superadmin'
            ? 'admin'
            : (userRecord.site_role || undefined);

    return {
        id: userRecord.id,
        email: userRecord.email,
        username: userRecord.username,
        global_role: userRecord.global_role,
        site_role: siteRole,
        metadata: parseJson<Record<string, any>>(userRecord.user_pref_json, {}),
        auth_provider: authProvider,
    };
}
