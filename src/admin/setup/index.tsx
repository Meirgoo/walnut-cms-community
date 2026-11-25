import { Hono } from 'hono';
import type { AppHonoEnv } from '../../engine';
import {
    isSystemInstalled,
    setSessionCookie,
    fetchAsset,
    renderTemplate,
    getAdminI18nSlice,
    getAdminLocale,
    loadAdminLocales,
    DEFAULT_DEV_HOST,
    getInlineI18nScript,
    SUPPORTED_LOCALES,
    renderLocaleOptions,
    extractCFAccessIdentity,
    isCFAccessBuildEnabled,
    resolveSetupMasterSecret,
    verifyNoCfaSetupPassword,
    invalidateSiteMemoryCache
} from '../../engine';
import { installSystem, ensureSchema } from './installer';
import { renderStatusMessage } from '../routes/common';

export const setupRouter = new Hono<AppHonoEnv>();

async function resolveSetupCFAccessEmail(c: any): Promise<{ cfaEnabled: boolean; cfEmail: string }> {
    const cfaEnabled = isCFAccessBuildEnabled();
    let cfEmail = cfaEnabled ? (c.get('cfAccessEmail') || '') : '';
    if (cfaEnabled && !cfEmail) {
        const cfIdentity = await extractCFAccessIdentity(c);
        if (cfIdentity?.email) {
            cfEmail = cfIdentity.email;
            c.set('cfAccessEmail', cfEmail);
        }
    }
    return { cfaEnabled, cfEmail };
}

setupRouter.get('/', async (c) => {
    await loadAdminLocales(c.env);
    const db = c.env.DB;
    if (db) {
        try {
            await ensureSchema(db);
        } catch (e) {
            console.error('Failed to auto-ensure schema on setup page:', e);
        }
    }
    const installed = await isSystemInstalled(db);
    const locale = getAdminLocale(c);
    const i18n = getAdminI18nSlice(locale, 'setup');
    if (installed) {
        if (!c.req.header('HX-Request')) {
            return c.redirect('/admin');
        }
        const alreadyTpl = await fetchAsset('/auth/pages/setup-already-installed.html', c.env);
        return c.html(renderTemplate(alreadyTpl, {
            title: i18n.setup?.already_installed_title || i18n.already_installed_title || 'System Already Initialized',
            desc: i18n.setup?.already_installed_desc || i18n.already_installed_desc || 'Setup has already been completed.',
            btn_text: i18n.common?.return_admin || i18n.return_admin || 'Enter Admin'
        }, i18n));
    }

    const { cfaEnabled, cfEmail } = await resolveSetupCFAccessEmail(c);

    // Initial setup trusts verified Cloudflare Access identity when CFA build is enabled.
    if (cfaEnabled && !cfEmail) {
        return c.text('Forbidden: Cloudflare Access authentication required for initial setup', 403);
    }
    if (!cfaEnabled && !resolveSetupMasterSecret(c)) {
        return c.text(i18n.secret_missing_error || i18n.setup?.secret_missing_error || 'Forbidden: SESSION_SECRET or JWT_SECRET must be configured before initial setup', 403);
    }

    const host = c.get('host') || DEFAULT_DEV_HOST;

    const cfNoticeHtml = cfaEnabled && cfEmail
        ? renderTemplate(await fetchAsset('/auth/snippets/setup-cf-notice-pass.html', c.env), { cf_email: cfEmail }, i18n)
        : '';
    const setupPasswordBoxHtml = !cfaEnabled
        ? renderTemplate(await fetchAsset('/auth/snippets/setup-password-field.html', c.env), {}, i18n)
        : '';

    const setupTpl = await fetchAsset('/auth/pages/setup.html', c.env);
    const inlineI18nScript = getInlineI18nScript(locale, { setup: i18n.setup || {}, common: i18n.common || {} });

    let htmlOutput = renderTemplate(setupTpl, {
        locale,
        setup_locale_options_html: renderLocaleOptions(locale),
        locale_zh_selected: locale === 'zh-CN' ? 'selected' : '',
        locale_en_selected: locale === 'en-US' ? 'selected' : '',
        locale_zh_label: SUPPORTED_LOCALES['zh-CN'] || '',
        locale_en_label: SUPPORTED_LOCALES['en-US'] || 'English',
        cf_notice_html: cfNoticeHtml,
        setup_password_box_html: setupPasswordBoxHtml,
        email: cfEmail,
        username: cfEmail ? cfEmail.split('@')[0] : 'admin',
        password_required_mark: cfEmail ? '' : '*',
        password_required: cfEmail ? '' : 'required',
        primary_domain: host,
        inline_i18n_script: 'WALNUT_INLINE_I18N_PLACEHOLDER'
    }, i18n);

    htmlOutput = htmlOutput.replace('WALNUT_INLINE_I18N_PLACEHOLDER', () => inlineI18nScript);

    return c.html(htmlOutput);
});

setupRouter.post('/api/init', async (c) => {
    const db = c.env.DB;
    const installed = await isSystemInstalled(db);
    const locale = getAdminLocale(c);
    const i18n = getAdminI18nSlice(locale, 'setup');

    if (installed) {
        return renderStatusMessage(c, i18n.already_initialized_warn, 'warning', 403);
    }

    const { cfaEnabled, cfEmail } = await resolveSetupCFAccessEmail(c);
    if (cfaEnabled && !cfEmail) {
        return renderStatusMessage(c, 'Forbidden: Cloudflare Access authentication required for initial setup', 'error', 403);
    }
    if (!cfaEnabled && !resolveSetupMasterSecret(c)) {
        return renderStatusMessage(c, i18n.secret_missing_error || i18n.setup?.secret_missing_error || 'Forbidden: SESSION_SECRET not configured', 'error', 403);
    }

    try {
        const body = await c.req.parseBody();
        if (!cfaEnabled) {
            const setupPassword = typeof body.setup_password === 'string' ? body.setup_password : '';
            const validSetupPassword = await verifyNoCfaSetupPassword(c, setupPassword);
            if (!validSetupPassword) {
                return renderStatusMessage(c, i18n.setup_password_invalid || i18n.setup?.setup_password_invalid || 'Invalid one-time setup password', 'error', 403);
            }
        }
        const email = (body.email as string || '').trim();
        const username = (body.username as string || '').trim();
        const password = (body.password as string || '').trim();
        const siteName = (body.site_name as string || '').trim() || 'Default Site';
        const host = c.get('host') || c.req.header('host') || DEFAULT_DEV_HOST;
        let primaryDomain = (body.primary_domain as string || '').trim();
        if (!primaryDomain || primaryDomain === '*') {
            primaryDomain = host;
        }

        if (!email || !username || (!cfEmail && !password)) {
            return renderStatusMessage(c, i18n.validation_fill_admin, 'error', 400);
        }

        const result = await installSystem(db, {
            superadminEmail: email,
            superadminUsername: username,
            superadminPassword: password || undefined,
            cfAccessSub: cfEmail ? `cf_${email}` : undefined,
            initialSiteName: siteName,
            primaryDomain: primaryDomain
        });

        invalidateSiteMemoryCache();

        await setSessionCookie(c, result.superadminId);

        c.header('HX-Redirect', '/admin');
        return renderStatusMessage(c, i18n.install_success_redirect, 'success');
    } catch (e: any) {
        console.error('Setup initialization error:', e);
        return renderStatusMessage(c, i18n.format(i18n.install_failed, { reason: e.message || 'Database error' }), 'error', 500);
    }
});
