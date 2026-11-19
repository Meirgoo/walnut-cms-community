import { Hono, type Context } from 'hono';
import type { AppHonoEnv, SiteRole } from '../../engine';
import {
    getAdminLocale,
    t
} from '../../engine';
import { profileRouter } from './profile';
import { runAdminPipeline, parseNodeIds, renderStatusMessage } from './common';

const usersRouter = new Hono<AppHonoEnv>();

const htmlError = (c: Context<AppHonoEnv>, msg: string, status: 400 | 401 | 403 = 400) =>
    renderStatusMessage(c, msg, 'error', status);

const htmlSuccess = (c: Context<AppHonoEnv>, msg: string, refresh = true) => {
    if (refresh) c.header('HX-Refresh', 'true');
    return renderStatusMessage(c, msg, 'success');
};

usersRouter.get('/', (c) => {
    const user = c.get('user');
    const isSuperAdmin = c.get('isSuperAdmin');
    if (user && user.site_role === 'visitor' && !isSuperAdmin && user.global_role !== 'superadmin') {
        return c.redirect('/admin');
    }
    return c.redirect('/admin/audit?tab=users', 302);
});

usersRouter.post('/api/create', async (c) => {
    const formData = await c.req.parseBody();
    const siteId = c.get('siteId') || '';
    const user = c.get('user');
    const isSuperAdmin = c.get('isSuperAdmin');
    const locale = getAdminLocale(c);

    if (user && user.site_role === 'visitor' && !isSuperAdmin) {
        return htmlError(c, t(locale, 'users.no_permission_create'), 403);
    }

    const username = (formData.username as string || '').trim();
    const email = (formData.email as string || '').trim();
    const password = (formData.password as string || '').trim();
    const role: SiteRole = (formData.role as string || 'admin') === 'visitor' ? 'visitor' : 'admin';

    if (!username || !email || !password) {
        return htmlError(c, t(locale, 'users.validation_incomplete'), 400);
    }

    try {
        await runAdminPipeline(
            c,
            'USER_CREATE',
            { siteId, username, email, passwordPlain: password, role },
            siteId
        );
        return htmlSuccess(c, t(locale, 'users.create_success'));
    } catch (err: any) {
        return htmlError(c, t(locale, 'users.create_failed', { reason: err.message }), 400);
    }
});

usersRouter.post('/api/edit', async (c) => {
    const formData = await c.req.parseBody();
    const siteId = c.get('siteId') || '';
    const currentUser = c.get('user');
    const isSuperAdmin = c.get('isSuperAdmin');
    const locale = getAdminLocale(c);

    if (!isSuperAdmin && currentUser?.global_role !== 'superadmin') {
        return htmlError(c, t(locale, 'users.superadmin_only_edit'), 403);
    }

    const userId = (formData.user_id as string || '').trim();
    const username = (formData.username as string || '').trim();
    const email = (formData.email as string || '').trim();
    const role = (formData.role as string || 'admin') === 'visitor' ? 'visitor' : 'admin';
    const globalRole = (formData.global_role as string || 'user');
    const newPassword = (formData.password as string || '').trim();

    if (currentUser && currentUser.id === userId) {
        return htmlError(c, t(locale, 'users.cannot_edit_self_here'), 400);
    }

    if (!userId || !username || !email) {
        return htmlError(c, t(locale, 'users.fill_required'), 400);
    }

    try {
        await runAdminPipeline(
            c,
            'USER_UPDATE',
            { userId, username, email, globalRole, siteId, role, newPassword },
            siteId
        );
        return htmlSuccess(c, t(locale, 'users.update_success'));
    } catch (err: any) {
        return htmlError(c, t(locale, 'users.update_failed', { reason: err.message }), 400);
    }
});

usersRouter.delete('/api/delete/:id', async (c) => {
    const id = c.req.param('id');
    const currentUser = c.get('user');
    const siteId = c.get('siteId') || '';
    const locale = getAdminLocale(c);

    if (currentUser && currentUser.id === id) {
        return htmlError(c, t(locale, 'users.cannot_delete_self'), 400);
    }

    if (currentUser && currentUser.site_role === 'visitor' && currentUser.global_role !== 'superadmin') {
        return htmlError(c, t(locale, 'users.no_permission_delete'), 403);
    }

    try {
        await runAdminPipeline(c, 'USER_DELETE', { id }, siteId);
        return c.body(null, 200);
    } catch {
        return c.body(null, 500);
    }
});

usersRouter.get('/profile', (c) => c.redirect('/admin/profile'));
usersRouter.route('/profile', profileRouter);

usersRouter.post('/api/batch-delete', async (c) => {
    try {
        let userIds: string[];
        const contentType = c.req.header('content-type') || '';
        if (contentType.includes('application/json')) {
            const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
            userIds = parseNodeIds(body.user_ids || body.ids);
        } else {
            const formData = (await c.req.parseBody().catch(() => ({}))) as Record<string, any>;
            userIds = parseNodeIds(formData.user_ids || formData.ids);
        }
        const currentUser = c.get('user');
        const validIds = userIds.filter(id => id && (!currentUser || id !== currentUser.id));
        if (!validIds.length) return c.json({ success: false, error: 'No users selected' }, 400);
        if (validIds.length > 15) return c.json({ success: false, code: 'BATCH_LIMIT_EXCEEDED', error: 'Maximum 15 items per batch' }, 422);

        await runAdminPipeline(c, 'USER_BATCH_DELETE', { userIds: validIds });
        return c.json({ success: true, count: validIds.length });
    } catch (err: any) {
        return c.json({ success: false, error: err?.message || 'Batch delete failed' }, err?.message?.includes('FORBIDDEN') ? 403 : 400);
    }
});

export { usersRouter };
