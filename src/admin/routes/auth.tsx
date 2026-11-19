import { Hono, type Context } from 'hono';
import type { AppHonoEnv, LoginContextResult } from '../../engine';
import { setSessionCookie, clearSessionCookie, getAdminLocale, getAdminI18nSlice, resolveSiteBrandInfo, getSystemMetaValue } from '../../engine';
import { LoginPage } from '../pages/Login';
import { runAdminPipeline, renderStatusMessage } from './common';

const authRouter = new Hono<AppHonoEnv>();

authRouter.get('/login', async (c) => {
    const cfEmail = c.get('cfAccessEmail');
    const locale = getAdminLocale(c);
    const site = c.get('site');
    let oemSealRaw: string | null = null;
    try {
        if (c.env?.DB) oemSealRaw = await getSystemMetaValue(c.env.DB, 'oem_seal');
    } catch {}
    const brandInfo = resolveSiteBrandInfo(site, oemSealRaw);
    return c.html(await LoginPage({
        cfEmail,
        locale,
        systemTitle: brandInfo.systemTitle,
        providerName: brandInfo.providerName
    }));
});

authRouter.get('/logout', async (c) => {
    const user = c.get('user');
    if (user) {
        await runAdminPipeline<{ userId: string }, { success: boolean }>(c, 'AUTH_LOGOUT', { userId: user.id });
    }
    clearSessionCookie(c);
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

