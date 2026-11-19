import { Hono, type Context } from 'hono';
import type { AppHonoEnv } from '../../engine';
import {
    getUserPasswordHash,
    findUserMetadataById,
    findRecentUserAuditLogs,
    getAdminLocale,
    getAdminI18nSlice,
    t,
    hashPassword,
    verifyPassword
} from '../../engine';
import { UserProfilePage } from '../pages/UserProfile';
import { getAdminRouteContext, runAdminPipeline, renderStatusMessage } from './common';

export const profileRouter = new Hono<AppHonoEnv>();

profileRouter.get('/', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const cfAccessEmail = c.get('cfAccessEmail');

    if (!ctx.user) {
        return c.redirect('/admin/login');
    }

    const isCommercial = ctx.canUseFeature ? ctx.canUseFeature('cms:*') : false;
    const [userMeta, recentLogs] = await Promise.all([
        findUserMetadataById(ctx.db, ctx.user.id),
        isCommercial
            ? findRecentUserAuditLogs(ctx.db, ctx.activeSiteId, ctx.user.id, 5).catch(() => [])
            : Promise.resolve([])
    ]);

    return c.html(
        <UserProfilePage
            {...ctx}
            cfAccessEmail={cfAccessEmail}
            userMeta={userMeta}
            recentLogs={recentLogs}
        />
    );
});

profileRouter.post('/api/change-password', async (c) => {
    const formData = await c.req.parseBody();
    const db = c.env.DB;
    const currentUser = c.get('user');
    const isSuperAdmin = c.get('isSuperAdmin') || currentUser?.global_role === 'superadmin';
    const cfAccessEmail = c.get('cfAccessEmail');
    const locale = getAdminLocale(c);

    if (!currentUser) {
        return renderStatusMessage(c, t(locale, 'profile.unauthenticated'), 'error', 401);
    }

    const authMode = (formData.auth_mode as string || 'password');
    const oldPassword = (formData.old_password as string || '').trim();
    const newPassword = (formData.new_password as string || '').trim();
    const confirmPassword = (formData.confirm_password as string || '').trim();

    if (!newPassword || newPassword.length < 6) {
        return renderStatusMessage(c, t(locale, 'profile.password_min_length'), 'error', 400);
    }

    if (newPassword !== confirmPassword) {
        return renderStatusMessage(c, t(locale, 'profile.passwords_mismatch'), 'error', 400);
    }

    if (authMode === 'cf_access') {
        const isCfVerified = isSuperAdmin && Boolean(cfAccessEmail) && currentUser.auth_provider === 'cf_access';
        if (!isCfVerified) {
            return renderStatusMessage(c, t(locale, 'profile.cf_access_only_superadmin'), 'error', 403);
        }
    } else {
        if (!oldPassword) {
            return renderStatusMessage(c, t(locale, 'profile.input_old_password'), 'error', 400);
        }

        const hash = await getUserPasswordHash(db, currentUser.id);
        if (!hash) {
            return renderStatusMessage(c, t(locale, 'profile.user_identity_invalid'), 'error', 400);
        }

        const isValid = await verifyPassword(oldPassword, hash);
        if (!isValid) {
            return renderStatusMessage(c, t(locale, 'profile.old_password_incorrect'), 'error', 400);
        }
    }

    try {
        const newPasswordHash = await hashPassword(newPassword);
        await runAdminPipeline<{ userId: string; newPasswordHash: string }, { success: boolean }>(
            c, 'USER_PASSWORD_CHANGE', { userId: currentUser.id, newPasswordHash }
        );

        const i18n = getAdminI18nSlice(locale, 'profile');
        return renderStatusMessage(c, i18n.profile.password_update_success, 'success');
    } catch (err: any) {
        return renderStatusMessage(c, t(locale, 'profile.password_update_failed', { reason: err.message }), 'error', 400);
    }
});

profileRouter.post('/api/preferences', async (c) => {
    const formData = await c.req.parseBody();
    const currentUser = c.get('user');
    const locale = getAdminLocale(c);

    if (!currentUser) {
        return renderStatusMessage(c, t(locale, 'profile.unauthenticated'), 'error', 401);
    }

    const timezone = String(formData.timezone || 'auto').trim() || 'auto';
    const editorSplitMode = String(formData.editor_split_mode || 'split').trim();
    const listPageSize = Math.max(10, Math.min(200, Number(formData.list_page_size || 20) || 20));

    try {
        await runAdminPipeline(c, 'USER_PREFERENCES_SAVE', {
            userId: currentUser.id,
            timezone,
            editor_split_mode: editorSplitMode,
            list_page_size: listPageSize
        });
        return renderStatusMessage(c, t(locale, 'profile.preferences_saved'), 'success');
    } catch (err: any) {
        return renderStatusMessage(c, t(locale, 'profile.preferences_save_failed', { reason: err.message }), 'error', 400);
    }
});
