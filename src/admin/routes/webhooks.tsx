import { Hono } from 'hono';
import type { AppHonoEnv } from '../../engine';
import type { WebhookConfigItem, WebhookLogItem } from '../pages/AuditList';
import { findWebhookDispatchLogs, findSiteSettings, getAdminLocale, t } from '../../engine';
import { runAdminPipeline, parseJson } from './common';

const webhooksRouter = new Hono<AppHonoEnv>();

export function extractWebhookConfigsFromSettings(settingsJson?: string | null): WebhookConfigItem[] {
    if (!settingsJson) return [];
    const parsed = parseJson<Record<string, any>>(settingsJson, {});
    if (Array.isArray(parsed.webhooks)) {
        return parsed.webhooks;
    }
    if (parsed.form_webhook_url) {
        return [{
            id: 'whk_default',
            form_id: 'default',
            name: 'Default Form Forwarding',
            form_webhook_url: parsed.form_webhook_url,
            form_webhook_secret: parsed.form_webhook_secret || null,
            is_active: 1
        }];
    }
    return [];
}

export async function fetchWebhookLogs(db: any, siteId: string, limit = 100): Promise<WebhookLogItem[]> {
    try {
        const rows = await findWebhookDispatchLogs(db, siteId, limit);

        return rows.map((r: any) => {
            const d = parseJson<Record<string, any>>(r.details, {});
            return {
                id: r.id,
                site_id: r.site_id,
                form_id: d.formId || 'default',
                target_url: d.targetUrl || '',
                platform: d.platform || 'custom',
                status_code: d.statusCode || (r.status === 'success' ? 200 : 500),
                payload: d.payload || null,
                response_body: d.responseBody || null,
                error_message: d.errorMessage || null,
                client_ip: r.ip_address,
                created_at: r.created_at
            };
        });
    } catch {
        return [];
    }
}

webhooksRouter.get('/', (c) => c.redirect('/admin/audit?tab=webhooks', 302));

webhooksRouter.post('/api/save', async (c) => {
    const locale = getAdminLocale(c);
    try {
        const body = await c.req.json();
        const siteId = c.get('siteId') || body.site_id || 'site_default';
        const result = await runAdminPipeline(c, 'WEBHOOK_CONFIG_SAVE', { ...body, site_id: siteId }, siteId);
        return c.json({ success: true, data: result });
    } catch (e: any) {
        return c.json({ success: false, error: e?.message || t(locale, 'webhooks.save_failed') }, 400);
    }
});

webhooksRouter.delete('/api/:id', async (c) => {
    const locale = getAdminLocale(c);
    try {
        const id = c.req.param('id');
        const siteId = c.get('siteId') || 'site_default';
        await runAdminPipeline(c, 'WEBHOOK_CONFIG_DELETE', { id, siteId }, siteId);
        return c.json({ success: true });
    } catch (e: any) {
        return c.json({ success: false, error: e?.message || t(locale, 'webhooks.delete_failed') }, 400);
    }
});

webhooksRouter.post('/api/test/:id', async (c) => {
    const locale = getAdminLocale(c);
    try {
        const id = c.req.param('id');
        const siteId = c.get('siteId') || 'site_default';
        const db = c.env.DB;

        const parsed = await findSiteSettings(db, siteId);
        let targetFormId = 'default';
        let targetName = 'Test Form';
        if (parsed) {
            try {
                const matched = Array.isArray(parsed.webhooks) ? parsed.webhooks.find((w: any) => w.id === id) : null;
                if (matched) {
                    targetFormId = matched.form_id;
                    targetName = matched.name;
                }
            } catch {}
        }

        const result = await runAdminPipeline(c, 'WEBHOOK_SUBMIT', {
            siteId,
            formId: targetFormId,
            formName: targetName,
            fields: {
                test_event: 'ping_test',
                message: t(locale, 'webhooks.mock_test_content'),
                timestamp: new Date().toISOString()
            }
        }, siteId);

        return c.json({ success: true, data: result });
    } catch (e: any) {
        return c.json({ success: false, error: e?.message || t(locale, 'webhooks.test_dispatch_failed') }, 400);
    }
});

webhooksRouter.get('/api/logs', async (c) => {
    const locale = getAdminLocale(c);
    try {
        const siteId = c.get('siteId') || 'site_default';
        const logs = await fetchWebhookLogs(c.env.DB, siteId);
        return c.json({ success: true, data: logs });
    } catch (e: any) {
        return c.json({ success: false, error: e?.message || t(locale, 'webhooks.query_logs_failed') }, 400);
    }
});

export { webhooksRouter };
