import type { Context } from 'hono';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import type { AuthenticatedUser, SiteRole } from '../../types';
import type { AppHonoEnv } from '../../types';
import { findSessionUserWithRole, type SessionUserRow } from '../dal';
import { isSecureContext } from '../url';
import { parseJson } from '../utils';

const SESSION_COOKIE_NAME = 'walnut_session';

export function getSessionSecret(c: Context<AppHonoEnv>): string {
    const env = c.env as any;
    return (
        env?.SESSION_SECRET ||
        env?.AUTHER_KEY_PUBLIC ||
        env?.CF_ACCOUNT_ID ||
        'walnut-hmac-sha256-session-default-secret-salt-2026'
    );
}

export async function getSessionUserId(c: Context<AppHonoEnv>): Promise<string | null> {
    try {
        const secret = getSessionSecret(c);
        const signedVal = await getSignedCookie(c, secret, SESSION_COOKIE_NAME);
        if (typeof signedVal === 'string' && signedVal.trim()) {
            return signedVal.trim();
        }
        return null;
    } catch {
        return null;
    }
}

export async function setSessionCookie(c: Context<AppHonoEnv>, userId: string, maxAgeDays = 7): Promise<void> {
    const secret = getSessionSecret(c);
    const isHttps = isSecureContext(c);
    await setSignedCookie(c, SESSION_COOKIE_NAME, userId, secret, {
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

    const cfAccessEmail = c.get('cfAccessEmail');
    if (cfAccessEmail) {
        try {
            userRecord = await findSessionUserWithRole(db, { email: cfAccessEmail }, siteId);
            if (userRecord) authProvider = 'cf_access';
        } catch {}
    }

    if (!userRecord) {
        const sessionUserId = await getSessionUserId(c);
        if (sessionUserId) {
            try {
                userRecord = await findSessionUserWithRole(db, { id: sessionUserId }, siteId);
                if (userRecord) authProvider = 'session';
            } catch {}
        }
    }

    // Local-only dev probe auth bypass; disabled when ENVIRONMENT is production or host is non-local.
    if (!userRecord) {
        const host = c.get('host') || c.req.header('host') || '';
        const isLocalHost = host.startsWith('localhost') || host.startsWith('127.0.0.1');
        const isDevEnv = !c.env?.ENVIRONMENT || c.env.ENVIRONMENT === 'development';
        const devAuthToken = c.req.header('X-Walnut-Dev-Auth') || c.req.query('__walnut_dev_auth');
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
