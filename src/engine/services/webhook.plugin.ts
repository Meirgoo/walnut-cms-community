import type { HookContext, IPluginEngine, WalnutPlugin } from '../types';
import { nanoId } from '../kernel';
import {
    findSiteSettings,
    buildUpdateSiteSettingsOnlyStatement,
    findWebhooksBySite,
    buildUpsertWebhookStatement,
    buildDeleteWebhookStatement
} from '../core/dal';
import { assertAdminUser } from './common.helper';

const CONTENT_CHANGE_ACTIONS = new Set([
    'ARTICLE_SAVE',
    'PAGE_SAVE',
    'MICRO_SAVE',
    'ARTICLE_DELETE',
    'PAGE_DELETE',
    'MICRO_DELETE',
    'CONTENT_DELETE',
    'NODE_DELETE',
    'NODE_BATCH_SOFT_DELETE',
    'CONTENT_RESTORE',
    'NODE_RESTORE',
    'CONTENT_PURGE',
    'DATASET_SAVE',
    'DATASET_DELETE'
]);

// Block loopback, private-network, and cloud metadata hosts to prevent SSRF.
export function isSafeCoreWebhookUrl(rawUrl: string): boolean {
    try {
        const p = new URL(rawUrl);
        if (p.protocol !== 'https:' && p.protocol !== 'http:') return false;
        const h = p.hostname.toLowerCase();
        if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return false;
        return !(
            h === '169.254.169.254' ||
            h === 'metadata.google.internal' ||
            h === 'localhost' ||
            h === '[::1]' ||
            h === '::1' ||
            h.startsWith('127.') ||
            h.startsWith('10.') ||
            h.startsWith('192.168.') ||
            h.startsWith('0.0.0.0')
        );
    } catch {
        return false;
    }
}

// Fire-and-forget community dispatcher; yields to WebhookProPlugin when webhookHandledByPro is set to avoid duplicate sends.
export const webhookCorePlugin: WalnutPlugin = {
    name: 'webhook:core',
    version: '1.0.0',
    tier: 'community',

    setup(engine: IPluginEngine): void {
        engine.registerService<any, any>('WEBHOOK_CONFIG_SAVE', async (ctx) => {
            assertAdminUser(ctx);
            const data = ctx.data || {};
            const siteId = data.siteId || ctx.siteId || 'site_default';
            const name = String(data.name || '').trim();
            const formId = String(data.form_id || 'default').trim() || 'default';
            const rawUrl = String(data.form_webhook_url || data.url || '').trim();
            const isActive = data.is_active === 0 ? 0 : 1;

            if (!name || !rawUrl) throw new Error('VALIDATION_FAILED');
            if (!isSafeCoreWebhookUrl(rawUrl)) throw new Error('FORM_INVALID_WEBHOOK_URL: Target URL blocked by SSRF policy');

            const id = String(data.id || nanoId('whk')).trim();
            const secret = data.form_webhook_secret || data.secret ? String(data.form_webhook_secret || data.secret).trim() : null;
            const eventsJson = JSON.stringify(Array.isArray(data.events) ? data.events : [formId]);

            const settings = await findSiteSettings(ctx.dal.db, siteId);
            const list: any[] = Array.isArray(settings.webhooks) ? [...settings.webhooks] : [];
            const idx = list.findIndex((item) => item.id === id);
            const nextItem = {
                id,
                form_id: formId,
                name,
                form_webhook_url: rawUrl,
                form_webhook_secret: secret,
                is_active: isActive,
                updated_at: new Date().toISOString()
            };
            if (idx >= 0) list[idx] = { ...list[idx], ...nextItem };
            else list.push({ ...nextItem, created_at: new Date().toISOString() });
            settings.webhooks = list;

            await ctx.dal.batch([
                buildUpdateSiteSettingsOnlyStatement(ctx.dal.db, siteId, JSON.stringify(settings)),
                buildUpsertWebhookStatement(ctx.dal.db, {
                    id,
                    siteId,
                    name,
                    url: rawUrl,
                    eventsJson,
                    secret,
                    isActive
                })
            ]);

            return { success: true, config: nextItem };
        });

        engine.registerService<{ id: string }, { success: boolean }>('WEBHOOK_CONFIG_DELETE', async (ctx) => {
            assertAdminUser(ctx);
            const siteId = (ctx.data as any)?.siteId || ctx.siteId || 'site_default';
            const id = String(ctx.data?.id || '').trim();
            if (!id) throw new Error('VALIDATION_FAILED');

            const settings = await findSiteSettings(ctx.dal.db, siteId);
            if (Array.isArray(settings.webhooks)) {
                settings.webhooks = settings.webhooks.filter((w: any) => w.id !== id);
            }
            await ctx.dal.batch([
                buildUpdateSiteSettingsOnlyStatement(ctx.dal.db, siteId, JSON.stringify(settings)),
                buildDeleteWebhookStatement(ctx.dal.db, siteId, id)
            ]);
            return { success: true };
        });

        engine.registerService<{ id: string }, { success: boolean; platform?: string }>('WEBHOOK_TEST_DISPATCH', async (ctx) => {
            assertAdminUser(ctx);
            const siteId = (ctx.data as any)?.siteId || ctx.siteId || 'site_default';
            const id = String(ctx.data?.id || '').trim();
            const settings = await findSiteSettings(ctx.dal.db, siteId);
            const rules: any[] = Array.isArray(settings.webhooks) ? settings.webhooks : [];
            let target = rules.find((r) => r.id === id);
            if (!target) {
                const tableRows = await findWebhooksBySite(ctx.dal.db, siteId);
                const row = tableRows.find((r) => r.id === id);
                if (row) target = { id: row.id, name: row.name, form_webhook_url: row.url, form_id: 'default' };
            }
            if (!target || !isSafeCoreWebhookUrl(target.form_webhook_url)) {
                throw new Error('WEBHOOK_TARGET_NOT_FOUND');
            }

            const res = await fetch(target.form_webhook_url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    event: 'WEBHOOK_TEST',
                    site_id: siteId,
                    webhook_id: target.id,
                    timestamp: new Date().toISOString()
                })
            });
            if (!res.ok) {
                throw new Error(`HTTP_${res.status}`);
            }
            return { success: true, platform: 'raw' };
        });

        engine.registerService<any, any>('WEBHOOK_SUBMIT', async (ctx) => {
            const siteId = ctx.siteId || ctx.data?.siteId || 'site_default';
            const formId = String(ctx.data?.formId || 'default').trim();
            const fields = ctx.data?.fields || {};
            if (fields && typeof fields === 'object' && ('_honeypot' in fields || '_gotcha' in fields) && (fields._honeypot || fields._gotcha)) {
                return { submissionId: nanoId('sub'), forwarded: false, spamBlocked: true, success: true };
            }

            const settings = await findSiteSettings(ctx.dal.db, siteId);
            const rules: any[] = Array.isArray(settings.webhooks) ? settings.webhooks : [];
            const activeRules = rules.filter((r) => r.is_active !== 0 && (!r.form_id || r.form_id === formId || r.form_id === '*'));
            if (activeRules.length === 0 && settings.form_webhook_url) {
                activeRules.push({ id: 'whk_default', form_webhook_url: settings.form_webhook_url });
            }

            const payload = JSON.stringify({
                event: 'WEBHOOK_SUBMIT',
                site_id: siteId,
                form_id: formId,
                fields,
                timestamp: new Date().toISOString()
            });

            let forwarded = false;
            for (const rule of activeRules) {
                if (!rule.form_webhook_url || !isSafeCoreWebhookUrl(rule.form_webhook_url)) continue;
                forwarded = true;
                try {
                    await fetch(rule.form_webhook_url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: payload
                    });
                } catch {}
            }
            return { submissionId: nanoId('sub'), forwarded, success: true };
        });

        engine.tapAfter('*', async (ctx) => {
            if (ctx.meta?.webhookHandledByPro === true) return;
            if (!CONTENT_CHANGE_ACTIONS.has(ctx.action)) return;
            if ((ctx.result as any)?.unchanged === true || (ctx.result as any)?.success === false) return;

            const siteId = (ctx.data as any)?.siteId || ctx.siteId || 'site_default';
            const tableRows = await findWebhooksBySite(ctx.dal.db, siteId);
            const settings = await findSiteSettings(ctx.dal.db, siteId);
            const settingRules: any[] = Array.isArray(settings.webhooks) ? settings.webhooks : [];

            const targets = new Set<string>();
            for (const r of tableRows) {
                if (r.is_active !== 0 && isSafeCoreWebhookUrl(r.url)) targets.add(r.url);
            }
            for (const r of settingRules) {
                if (r.is_active !== 0 && isSafeCoreWebhookUrl(r.form_webhook_url)) targets.add(r.form_webhook_url);
            }
            if (targets.size === 0) return;

            const body = JSON.stringify({
                event: ctx.action,
                site_id: siteId,
                data: ctx.result || ctx.data || {},
                timestamp: new Date().toISOString()
            });

            await Promise.allSettled(
                Array.from(targets).map((url) =>
                    fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body
                    })
                )
            );
        });
    }
};
