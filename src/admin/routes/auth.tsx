import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import type { AppHonoEnv, LoginContextResult } from '../../engine';
import {
    setSessionCookie,
    clearSessionCookie,
    getAdminLocale,
    getAdminI18nSlice,
    resolveSiteBrandInfo,
    getSystemMetaValue,
    extractCFAccessIdentity,
    isCFAccessBuildEnabled,
    findSessionUserWithRole
} from '../../engine';
import { LoginPage } from '../pages/Login';
import { runAdminPipeline, renderStatusMessage } from './common';

const authRouter = new Hono<AppHonoEnv>();

authRouter.get('/login', async (c) => {
    const cfaEnabled = isCFAccessBuildEnabled();
    const cfEmail = cfaEnabled ? c.get('cfAccessEmail') : undefined;
    const cfConfigured = cfaEnabled && Boolean(cfEmail || c.env?.CF_ACCESS_TEAM_NAME);
    const locale = getAdminLocale(c);
    const site = c.get('site');
    let oemSealRaw: string | null = null;
    try {
        if (c.env?.DB) oemSealRaw = await getSystemMetaValue(c.env.DB, 'oem_seal');
    } catch {}
    const brandInfo = resolveSiteBrandInfo(site, oemSealRaw);
    return c.html(await LoginPage({
        cfEmail,
        cfEnabled: cfConfigured,
        locale,
        systemTitle: brandInfo.systemTitle,
        providerName: brandInfo.providerName
    }));
});

authRouter.get('/auth/cf-access', async (c) => {
    if (!isCFAccessBuildEnabled()) {
        return c.redirect('/admin/login');
    }
    deleteCookie(c, 'edge_no_auto_cfa', { path: '/' });
    const cfIdentity = await extractCFAccessIdentity(c);
    if (!cfIdentity?.email || !c.env?.DB) {
        return c.redirect('/admin/login');
    }
    const userRecord = await findSessionUserWithRole(c.env.DB, { email: cfIdentity.email }, c.get('siteId'));
    if (!userRecord) {
        return c.redirect('/admin/login');
    }
    await setSessionCookie(c, userRecord.id);
    return c.redirect('/admin');
});

authRouter.get('/logout', async (c) => {
    const user = c.get('user');
    if (user) {
        await runAdminPipeline<{ userId: string }, { success: boolean }>(c, 'AUTH_LOGOUT', { userId: user.id });
    }
    clearSessionCookie(c);
    if (isCFAccessBuildEnabled()) {
        setCookie(c, 'edge_no_auto_cfa', '1', { path: '/', httpOnly: true, sameSite: 'Lax' });
    }
    return c.redirect('/admin/login');
});

authRouter.post('/api/login', async (c) => {
    const body = await c.req.parseBody();
    const usernameOrEmail = (body.username as string || '').trim();
    const password = (body.password as string || '').trim();
    const locale = getAdminLocale(c);
    const i18n = getAdminI18nSlice(locale, 'login');

    const result = await runAdminPipeline<
        { usernameOrEmail: string; passwordPlain: string },
        LoginContextResult
    >(c, 'AUTH_LOGIN', { usernameOrEmail, passwordPlain: password });

    if (result.success && result.user) {
        deleteCookie(c, 'edge_no_auto_cfa', { path: '/' });
        await setSessionCookie(c, result.user.id);
        c.header('HX-Redirect', '/admin');
        if (!c.req.header('HX-Request')) {
            return c.redirect('/admin');
        }
        return c.body(null, 200);
    } else {
        return renderStatusMessage(c, i18n.login.auth_failed, 'error', 401);
    }
});

export { authRouter };

