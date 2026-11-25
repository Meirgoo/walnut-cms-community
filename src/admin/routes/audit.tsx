import { Hono } from 'hono';
import type { AppHonoEnv, ScheduledTask } from '../../engine';
import {
    querySiteUsers,
    queryAuditLogsWithUsers,
    findTasksBySite,
    getAdminLocale,
    t,
    isFeatureEnabled
} from '../../engine';
import { getAdminRouteContext, runAdminPipeline, renderStatusMessage } from './common';
import { fetchWebhookLogs, extractWebhookConfigsFromSettings } from './webhooks';
import {
    AuditListPage,
    type D1SnapshotListItem,
    type UserRow,
    type AuditLogRow,
    type WebhookConfigItem,
    type WebhookLogItem
} from '../pages/AuditList';

const auditRouter = new Hono<AppHonoEnv>();

auditRouter.get('/', async (c) => {
    const ctx = await getAdminRouteContext(c);

    if (ctx.user && ctx.user.site_role === 'visitor' && !ctx.isSuperAdmin && ctx.user.global_role !== 'superadmin') {
        return c.redirect('/admin');
    }

    const activeSite = ctx.sites.find(s => s.id === ctx.activeSiteId) || ctx.sites[0];
    const activeSiteId = activeSite?.id || ctx.siteId || '';

    let users: UserRow[] = [];
    try {
        users = (await querySiteUsers(ctx.db, activeSiteId)) as UserRow[];
    } catch {
        users = [];
    }

    // Skip commercial queries in community edition to avoid unnecessary D1/pipeline overhead.
    const isCommercial = ctx.canUseFeature ? ctx.canUseFeature('cms:*') : false;
    let logs: AuditLogRow[] = [];
    let tasks: ScheduledTask[] = [];
    let webhookConfigs: WebhookConfigItem[] = [];
    let webhookLogs: WebhookLogItem[] = [];
    let backups: D1SnapshotListItem[] = [];
    let blocklist: any[] = [];
    let traffic: any = null;
    const isCfAccess = ctx.user?.auth_provider === 'cf_access';

    const trafficEnabled = isFeatureEnabled('trafficAnalytics', c.env);

    if (isCommercial) {
        webhookConfigs = extractWebhookConfigsFromSettings(activeSite?.settings);
        const [logsRes, tasksRes, whLogsRes, listRes, blRes, trRes] = await Promise.all([
            queryAuditLogsWithUsers(ctx.db, activeSiteId, 100, ctx.isSuperAdmin).catch(() => []),
            findTasksBySite(ctx.db, activeSiteId, ctx.isSuperAdmin).catch(() => []),
            fetchWebhookLogs(ctx.db, activeSiteId, 100).catch(() => []),
            runAdminPipeline<{ siteId?: string }, { snapshots: D1SnapshotListItem[] }>(
                c,
                'D1_SNAPSHOT_LIST',
                { siteId: activeSiteId }
            ).catch(() => null),
            runAdminPipeline<{ siteId?: string }, { blocklist: any[] }>(
                c,
                'BLOCKLIST_QUERY',
                { siteId: activeSiteId }
            ).catch(() => null),
            trafficEnabled
                ? runAdminPipeline<{ siteId?: string; limit?: number }, any>(
                    c,
                    'TRAFFIC_QUERY',
                    { siteId: activeSiteId, limit: 14 }
                ).catch(() => null)
                : Promise.resolve(null),
        ]);
        logs = logsRes;
        tasks = tasksRes;
        webhookLogs = whLogsRes;
        backups = listRes?.snapshots || [];
        blocklist = blRes?.blocklist || [];
        traffic = trRes || null;
    }

    const tabParam = c.req.query('tab');
    let activeTab: 'tab-logs' | 'tab-tasks' | 'tab-webhooks' | 'tab-backups' | 'tab-blocklist' | 'tab-traffic' | 'tab-users' | undefined = undefined;
    if (tabParam === 'logs' || tabParam === 'tab-logs') activeTab = 'tab-logs';
    else if (tabParam === 'tasks' || tabParam === 'tab-tasks') activeTab = 'tab-tasks';
    else if (tabParam === 'webhooks' || tabParam === 'tab-webhooks') activeTab = 'tab-webhooks';
    else if (tabParam === 'backups' || tabParam === 'tab-backups') activeTab = 'tab-backups';
    else if (tabParam === 'blocklist' || tabParam === 'tab-blocklist') activeTab = 'tab-blocklist';
    else if (trafficEnabled && (tabParam === 'traffic' || tabParam === 'tab-traffic')) activeTab = 'tab-traffic';
    else if (tabParam === 'users' || tabParam === 'tab-users') activeTab = 'tab-users';

    return c.html(
        <AuditListPage
            activeTab={activeTab}
            users={users}
            logs={logs}
            tasks={tasks}
            webhookConfigs={webhookConfigs}
            webhookLogs={webhookLogs}
            backups={backups}
            blocklist={blocklist}
            traffic={traffic}
            isCfAccess={isCfAccess}
            {...ctx}
        />
    );
});

auditRouter.post('/api/blocklist/add', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const body = await c.req.parseBody();
    const ip = String(body.ip || '').trim();
    const reason = String(body.reason || 'Manual Block').trim();
    const activeSiteId = ctx.activeSite?.id || ctx.siteId || '';
    if (!ip) {
        return renderStatusMessage(c, 'IP is required', 'error', 400);
    }
    await runAdminPipeline(c, 'BLOCKLIST_ADD', { ip, reason, siteId: activeSiteId });
    c.header('HX-Refresh', 'true');
    return renderStatusMessage(c, 'IP added to blocklist', 'success');
});

auditRouter.post('/api/blocklist/remove/:id', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const id = c.req.param('id');
    const activeSiteId = ctx.activeSite?.id || ctx.siteId || '';
    await runAdminPipeline(c, 'BLOCKLIST_REMOVE', { id, siteId: activeSiteId });
    c.header('HX-Refresh', 'true');
    return renderStatusMessage(c, 'IP removed from blocklist', 'success');
});

auditRouter.post('/api/traffic/sync', async (c) => {
    if (!isFeatureEnabled('trafficAnalytics', c.env)) return c.notFound();
    const ctx = await getAdminRouteContext(c);
    const activeSiteId = ctx.activeSite?.id || ctx.siteId || '';
    await runAdminPipeline(c, 'TRAFFIC_SYNC', { siteId: activeSiteId });
    c.header('HX-Refresh', 'true');
    return renderStatusMessage(c, 'Traffic metrics synchronized', 'success');
});

auditRouter.post('/api/backups/create', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const locale = getAdminLocale(c);

    // Backup snapshots strictly require Cloudflare Access; password-authenticated superadmins are denied.
    if (ctx.user?.auth_provider !== 'cf_access') {
        return renderStatusMessage(c, t(locale, 'audit.cf_access_required'), 'error', 403);
    }

    const activeSiteId = ctx.activeSite?.id || ctx.siteId || '';
    try {
        await runAdminPipeline(c, 'D1_SNAPSHOT_EXPORT', { siteId: activeSiteId });
        c.header('HX-Refresh', 'true');
        return renderStatusMessage(c, t(locale, 'audit.backup_created_success'), 'success');
    } catch {
        return renderStatusMessage(c, t(locale, 'common.error'), 'error', 500);
    }
});

auditRouter.get('/api/backups/download', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const locale = getAdminLocale(c);

    // Backup downloads strictly require Cloudflare Access; password-authenticated superadmins are denied.
    if (ctx.user?.auth_provider !== 'cf_access') {
        return renderStatusMessage(c, t(locale, 'audit.cf_access_required'), 'error', 403);
    }

    const key = c.req.query('key');
    if (!key || (!key.startsWith('database-snapshots/') && !key.startsWith('backups/d1/'))) {
        return renderStatusMessage(c, t(locale, 'common.not_found'), 'error', 400);
    }

    const dal = c.get('dal');
    if (!dal) {
        return renderStatusMessage(c, t(locale, 'common.not_found'), 'error', 404);
    }

    const object = await dal.getBackupObject(key);
    if (!object) {
        return renderStatusMessage(c, t(locale, 'common.not_found'), 'error', 404);
    }

    const ownerSiteId = object.customMetadata?.siteId;
    if (!ctx.isSuperAdmin && ownerSiteId !== ctx.activeSiteId) {
        return renderStatusMessage(c, t(locale, 'common.forbidden'), 'error', 403);
    }

    const filename = key.split('/').pop() || 'd1-backup.json';
    return new Response(object.body, {
        headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${filename}"`
        }
    });
});

auditRouter.get('/api/workers', async (c) => {
    const siteId = c.get('siteId') || 'site_default';
    try {
        const res = await runAdminPipeline(c, 'WORKER_BRIDGE_LIST', { siteId }, siteId);
        return c.json(res);
    } catch (e: any) {
        return c.json({ success: false, error: e?.message || 'Error' }, e?.message?.startsWith('LICENSE_') ? 403 : 400);
    }
});

auditRouter.post('/api/workers/save', async (c) => {
    const siteId = c.get('siteId') || 'site_default';
    try {
        const body = await c.req.json();
        const res = await runAdminPipeline(c, 'WORKER_BRIDGE_SAVE', { ...body, siteId }, siteId);
        return c.json(res);
    } catch (e: any) {
        return c.json({ success: false, error: e?.message || 'Error' }, e?.message?.startsWith('LICENSE_') ? 403 : 400);
    }
});

auditRouter.delete('/api/workers/:id', async (c) => {
    const siteId = c.get('siteId') || 'site_default';
    const id = c.req.param('id');
    try {
        const res = await runAdminPipeline(c, 'WORKER_BRIDGE_DELETE', { id, siteId }, siteId);
        return c.json(res);
    } catch (e: any) {
        return c.json({ success: false, error: e?.message || 'Error' }, e?.message?.startsWith('LICENSE_') ? 403 : 400);
    }
});

export { auditRouter };
