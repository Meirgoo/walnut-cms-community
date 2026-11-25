import type { HookContext, IPluginEngine, WalnutPlugin } from '../types';
import { nanoId } from '../kernel';
import {
    findSiteById,
    findSiteSettings,
    buildUpdateSiteSettingsOnlyStatement,
    findWebhooksBySite,
    buildUpsertWebhookStatement,
    buildDeleteWebhookStatement
} from '../core/dal';
import { parseJson } from '../core/utils';
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

function isPrivateIpv4Octets(o1: number, o2: number): boolean {
    if (o1 === 0 || o1 === 10 || o1 === 127) return true;
    if (o1 === 169 && o2 === 254) return true;
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    if (o1 === 192 && o2 === 168) return true;
    return false;
}

function normalizeHostName(raw?: string | null): string {
    if (!raw || typeof raw !== 'string') return '';
    const trimmed = raw.trim().toLowerCase().replace(/^https?:\/\//i, '').split('/')[0];
    if (!trimmed) return '';
    if (trimmed.startsWith('[')) {
        const end = trimmed.indexOf(']');
        return end > 0 ? trimmed.slice(1, end) : trimmed;
    }
    return trimmed.split(':')[0].replace(/\.$/, '');
}

export async function resolveSiteSelfHosts(
    db: any,
    siteId: string,
    reqHost?: string
): Promise<string[]> {
    const hosts = new Set<string>();
    const addHost = (val?: string | null) => {
        const h = normalizeHostName(val);
        if (h && h !== '*') hosts.add(h);
    };
    addHost(reqHost);
    try {
        const site = await findSiteById(db, siteId);
        if (site) {
            addHost(site.primary_domain);
            const settings = parseJson<Record<string, any>>(site.settings, {});
            addHost(settings.sitemap_domain);
            addHost(settings.seo?.sitemap_domain);
        }
    } catch {}
    return Array.from(hosts);
}

// Block loopback, private-network, IPv6/IPv4-mapped internal ranges, cloud metadata, and same-site hosts to prevent SSRF.
export function isSafeCoreWebhookUrl(rawUrl: string, selfHosts: string[] = []): boolean {
    try {
        const p = new URL(rawUrl);
        if (p.protocol !== 'https:' && p.protocol !== 'http:') return false;
        const h = p.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
        if (!h) return false;

        if (selfHosts.some((sh) => sh && h === sh)) return false;

        if (
            h === 'localhost' ||
            h.endsWith('.localhost') ||
            h === 'metadata.google.internal' ||
            h === 'metadata.goog' ||
            /^\d+$/.test(h) ||
            /^0x[0-9a-f]+$/i.test(h)
        ) {
            return false;
        }

        const v4Match = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (v4Match) {
            const octs = v4Match.slice(1).map(Number);
            if (octs.some(o => Number.isNaN(o) || o > 255)) return false;
            return !isPrivateIpv4Octets(octs[0], octs[1]);
        }

        if (h.includes(':')) {
            const cleanV6 = h.split('%')[0];
            if (
                cleanV6 === '::' ||
                cleanV6 === '::1' ||
                cleanV6 === '0:0:0:0:0:0:0:0' ||
                cleanV6 === '0:0:0:0:0:0:0:1'
            ) {
                return false;
            }
            if (/^f[cd][0-9a-f]{0,2}:/i.test(cleanV6) || /^fe[89ab][0-9a-f]?:/i.test(cleanV6)) {
                return false;
            }
            const mappedDot = cleanV6.match(/^(?:::ffff|(?:0{1,4}:){5}ffff):(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
            if (mappedDot) {
                return !isPrivateIpv4Octets(Number(mappedDot[1]), Number(mappedDot[2]));
            }
            // WHATWG URL serializes [::ffff:127.0.0.1] as ::ffff:7f00:1, so decode both 16-bit hex groups.
            const mappedHex = cleanV6.match(/^(?:::ffff|(?:0{1,4}:){5}ffff|::(?:0{1,4}:){0,5}):?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
                || cleanV6.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
            if (mappedHex) {
                const hi = parseInt(mappedHex[1], 16);
                const o1 = (hi >> 8) & 0xff;
                const o2 = hi & 0xff;
                if (isPrivateIpv4Octets(o1, o2)) return false;
            }
        }

        return true;
    } catch {
        return false;
    }
}

export function sanitizeCoreWebhookFields(rawFields: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!rawFields || typeof rawFields !== 'object') return {};
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawFields).slice(0, 50)) {
        if (k === '_honeypot' || k === '_gotcha') continue;
        const safeKey = String(k).trim().slice(0, 64);
        if (!safeKey) continue;
        sanitized[safeKey] = typeof v === 'string'
            ? v.trim().slice(0, 4000)
            : (typeof v === 'number' || typeof v === 'boolean')
                ? v
                : (v != null ? JSON.stringify(v).slice(0, 4000) : '');
    }
    return sanitized;
}

export async function dispatchCoreWebhookSubmit(ctx: HookContext<any, any>): Promise<any> {
    const siteId = ctx.siteId || ctx.data?.siteId || 'site_default';
    const formId = String(ctx.data?.formId || 'default').trim();
    const rawFields = ctx.data?.fields || {};
    if (rawFields && typeof rawFields === 'object' && ('_honeypot' in rawFields || '_gotcha' in rawFields) && (rawFields._honeypot || rawFields._gotcha)) {
        return { submissionId: nanoId('sub'), forwarded: false, spamBlocked: true, success: true };
    }

    const fields = sanitizeCoreWebhookFields(rawFields);
    const settings = await findSiteSettings(ctx.dal.db, siteId);
    const selfHosts = await resolveSiteSelfHosts(ctx.dal.db, siteId, ctx.host);
    const rules: any[] = Array.isArray(settings.webhooks) ? settings.webhooks : [];
    const activeRules = rules.filter((r) => r.is_active !== 0 && (!r.form_id || r.form_id === formId || r.form_id === '*'));
    if (activeRules.length === 0 && settings.form_webhook_url) {
        activeRules.push({ id: 'whk_default', form_webhook_url: settings.form_webhook_url });
    }

    const targets = activeRules
        .map((r) => r.form_webhook_url)
        .filter((u): u is string => Boolean(u && isSafeCoreWebhookUrl(u, selfHosts)));

    if (targets.length > 0) {
        ctx.meta.coreWebhookDispatch = {
            targets,
            payload: JSON.stringify({
                event: 'WEBHOOK_SUBMIT',
                site_id: siteId,
                form_id: formId,
                fields,
                timestamp: new Date().toISOString()
            })
        };
    }

    return { submissionId: nanoId('sub'), forwarded: targets.length > 0, success: true };
}

function buildWebhookFetchInit(body: string): RequestInit {
    return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        redirect: 'manual',
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(8000) : undefined
    };
}

// Fire-and-forget community dispatcher; yields to WebhookProPlugin when webhookHandledByPro is set to avoid duplicate sends.
export const webhookCorePlugin: WalnutPlugin = {
    name: 'webhook:core',
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
            const selfHosts = await resolveSiteSelfHosts(ctx.dal.db, siteId, ctx.host);

            if (!name || !rawUrl) throw new Error('VALIDATION_FAILED');
            if (!isSafeCoreWebhookUrl(rawUrl, selfHosts)) throw new Error('FORM_INVALID_WEBHOOK_URL: Target URL blocked by SSRF policy');

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

        engine.registerService<any, any>('WEBHOOK_SUBMIT', async (ctx) => {
            return await dispatchCoreWebhookSubmit(ctx);
        });

        engine.tapAfter<any, any>('WEBHOOK_SUBMIT', async (ctx) => {
            if (ctx.meta?.webhookHandledByPro === true) return;
            const job = ctx.meta?.coreWebhookDispatch as { targets?: string[]; payload?: string } | undefined;
            if (!job?.targets?.length || !job.payload) return;
            await Promise.allSettled(
                job.targets.map((url) => fetch(url, buildWebhookFetchInit(job.payload!)))
            );
        });

        engine.tapAfter('*', async (ctx) => {
            if (ctx.meta?.webhookHandledByPro === true) return;
            if (!CONTENT_CHANGE_ACTIONS.has(ctx.action)) return;
            if ((ctx.result as any)?.unchanged === true || (ctx.result as any)?.success === false) return;

            const siteId = (ctx.data as any)?.siteId || ctx.siteId || 'site_default';
            const tableRows = await findWebhooksBySite(ctx.dal.db, siteId);
            const settings = await findSiteSettings(ctx.dal.db, siteId);
            const selfHosts = await resolveSiteSelfHosts(ctx.dal.db, siteId, ctx.host);
            const settingRules: any[] = Array.isArray(settings.webhooks) ? settings.webhooks : [];

            const targets = new Set<string>();
            for (const r of tableRows) {
                if (r.is_active !== 0 && isSafeCoreWebhookUrl(r.url, selfHosts)) targets.add(r.url);
            }
            for (const r of settingRules) {
                if (r.is_active !== 0 && isSafeCoreWebhookUrl(r.form_webhook_url, selfHosts)) targets.add(r.form_webhook_url);
            }
            if (targets.size === 0) return;

            const body = JSON.stringify({
                event: ctx.action,
                site_id: siteId,
                data: ctx.result || ctx.data || {},
                timestamp: new Date().toISOString()
            });

            await Promise.allSettled(
                Array.from(targets).map((url) => fetch(url, buildWebhookFetchInit(body)))
            );
        });
    }
};
