import type { ExecutionContext } from '@cloudflare/workers-types';
import { DAL } from './dal';
import { DEFAULT_DEV_HOST } from './core/url';
import { extractClientIp } from './core/utils';
import type {
    ActionType,
    BeforeHookHandler,
    ServiceHandler,
    AfterHookHandler,
    HookContext,
    CreateHookContextOptions,
    IPluginEngine,
    WalnutPlugin,
    WalnutEnvBindings,
    QuickActionItem
} from './types';

import { ENGINE_CORE_VERSION } from './version';
export { WALNUT_VERSION, WALNUT_SCHEMA_VERSION, ENGINE_CORE_VERSION } from './version';
export const nanoId = (prefix = '', len = 12) => `${prefix ? prefix + '_' : ''}${crypto.randomUUID().replace(/-/g, '').slice(0, len)}`;


/**
 * Three-stage transaction pipeline: synchronous `before` guards, atomic `execute` service,
 * and non-blocking `after` side effects scheduled via `executionCtx.waitUntil`.
 */
export class PluginEngine implements IPluginEngine {
    private readonly beforeHooks: Map<ActionType, BeforeHookHandler[]> = new Map();
    private readonly services: Map<ActionType, ServiceHandler> = new Map();
    private readonly afterHooks: Map<ActionType, AfterHookHandler[]> = new Map();
    private readonly registeredPlugins: Map<string, WalnutPlugin> = new Map();
    private readonly quickActions: Map<string, QuickActionItem> = new Map();
    private firewallHandler?: (ip: string, isWrite: boolean, reqUrl: URL, env: any, reqHeaders?: Headers, opts?: { isAdminSession?: boolean }) => Promise<{ allowed: boolean; status?: number; reason?: string }> | { allowed: boolean; status?: number; reason?: string };

    public tapBefore<TData = any>(
        action: ActionType,
        handler: BeforeHookHandler<TData>
    ): this {
        const list = this.beforeHooks.get(action) ?? [];
        list.push(handler as BeforeHookHandler);
        this.beforeHooks.set(action, list);
        return this;
    }

    public registerService<TData = any, TResult = any>(
        action: ActionType,
        handler: ServiceHandler<TData, TResult>
    ): this {
        if (action === '*') {
            throw new Error('[PluginEngine] Core service cannot be registered on wildcard action "*".');
        }
        this.services.set(action, handler as ServiceHandler);
        return this;
    }

    public tapAfter<TData = any, TResult = any>(
        action: ActionType,
        handler: AfterHookHandler<TData, TResult>
    ): this {
        const list = this.afterHooks.get(action) ?? [];
        list.push(handler as AfterHookHandler);
        this.afterHooks.set(action, list);
        return this;
    }

    public registerPlugin(plugin: WalnutPlugin): this {
        if (this.registeredPlugins.has(plugin.name)) {
            return this;
        }
        this.registeredPlugins.set(plugin.name, plugin);
        plugin.setup(this);
        return this;
    }

    public registerPlugins(plugins: WalnutPlugin[]): this {
        for (const plugin of plugins) {
            this.registerPlugin(plugin);
        }
        return this;
    }

    public hasPlugin(name: string): boolean {
        return this.registeredPlugins.has(name);
    }

    public hasCommercialPlugins(): boolean {
        for (const plugin of this.registeredPlugins.values()) {
            if (plugin.tier && plugin.tier !== 'community') {
                return true;
            }
        }
        return false;
    }

    public registerQuickAction(action: QuickActionItem): this {
        this.quickActions.set(action.cmd, action);
        return this;
    }

    public getQuickActions(licenseTier?: string): QuickActionItem[] {
        const list = Array.from(this.quickActions.values());
        if (!licenseTier || licenseTier === 'agency') return list;
        if (licenseTier === 'personal') return list.filter((a) => a.tier !== 'agency');
        return list.filter((a) => !a.tier || a.tier === 'community');
    }

    public hasService(action: string): boolean {
        return this.services.has(action);
    }

    public setFirewallHandler(handler: (ip: string, isWrite: boolean, reqUrl: URL, env: any, reqHeaders?: Headers, opts?: { isAdminSession?: boolean }) => Promise<{ allowed: boolean; status?: number; reason?: string }> | { allowed: boolean; status?: number; reason?: string }): void {
        this.firewallHandler = handler;
    }

    public async checkFirewall(ip: string, isWrite: boolean, reqUrl: URL, env: any, reqHeaders?: Headers, opts?: { isAdminSession?: boolean }): Promise<{ allowed: boolean; status?: number; reason?: string }> {
        if (this.firewallHandler) {
            return await this.firewallHandler(ip, isWrite, reqUrl, env, reqHeaders, opts);
        }
        return { allowed: true };
    }

    public async runPipeline<TData = any, TResult = any>(
        ctx: HookContext<TData, TResult>
    ): Promise<TResult> {
        const { action } = ctx;

        const globalBefore = this.beforeHooks.get('*') ?? [];
        const actionBefore = action !== '*' ? (this.beforeHooks.get(action) ?? []) : [];
        const beforeQueue = [...globalBefore, ...actionBefore];

        for (const beforeHook of beforeQueue) {
            await beforeHook(ctx);
        }

        const serviceHandler = this.services.get(action);
        if (!serviceHandler) {
            throw new Error(`ACTION_NOT_REGISTERED: [PluginEngine] Action handler for [${action}] is not registered.`);
        }

        const result = await serviceHandler(ctx);
        ctx.result = result as TResult;

        const globalAfter = this.afterHooks.get('*') ?? [];
        const actionAfter = action !== '*' ? (this.afterHooks.get(action) ?? []) : [];
        const afterQueue = [...globalAfter, ...actionAfter];

        if (afterQueue.length > 0) {
            const sideEffectsTask = Promise.allSettled(
                afterQueue.map((afterHook) =>
                    Promise.resolve().then(() => afterHook(ctx))
                )
            ).then((results) => {
                for (const res of results) {
                    if (res.status === 'rejected') {
                        console.error('[PluginEngine AfterHook Rejected]:', res.reason);
                    }
                }
            });

            if (ctx.executionCtx && typeof ctx.executionCtx.waitUntil === 'function') {
                ctx.executionCtx.waitUntil(sideEffectsTask);
            } else {
                await sideEffectsTask;
            }
        }

        return ctx.result as TResult;
    }
}

export function createHookContext<TData = any, TResult = any>(
    options: CreateHookContextOptions<TData>
): HookContext<TData, TResult> {
    const { action, data, c } = options;

    const env: WalnutEnvBindings = options.env ?? (c?.env as WalnutEnvBindings);
    if (!env || !env.DB) {
        throw new Error(`[createHookContext] Missing valid Cloudflare environment or D1 database binding for action "${action}".`);
    }

    // Accessing c.executionCtx throws outside a Worker request context (e.g. unit tests).
    let executionCtx: ExecutionContext | undefined = options.executionCtx;
    if (!executionCtx && c) {
        try {
            executionCtx = c.executionCtx;
        } catch {
            executionCtx = undefined;
        }
    }

    const dal = options.dal ?? (typeof (c?.get as any) === 'function' ? (c?.get as any)('dal') : undefined) ?? new DAL({
        DB: env.DB,
        BUCKET: env.BUCKET,
        BUCKET_BACKUP: env.BUCKET_BACKUP,
        KV: env.KV
    });

    const getProp = (prop: string) => (typeof (c as any)?.get === 'function' ? (c as any).get(prop) : (c as any)?.[prop]);

    const user = options.user !== undefined ? options.user : (getProp('user') ?? null);
    const siteId = options.siteId ?? getProp('siteId');
    const host = options.host ?? getProp('host') ?? (c?.req as any)?.header?.('host') ?? DEFAULT_DEV_HOST;
    const locale = options.locale ?? getProp('locale') ?? 'zh-CN';
    const clientIp =
        options.clientIp ??
        (typeof (c?.req as any)?.header === 'function'
            ? extractClientIp(c as any)
            : '127.0.0.1');

    return {
        action,
        data,
        env,
        executionCtx,
        dal,
        user,
        siteId,
        clientIp,
        host,
        locale,
        meta: options.meta ? { ...options.meta } : {},
        c
    };
}

let sharedPluginEngine: PluginEngine | null = null;

export function createPluginEngine(): PluginEngine {
    return new PluginEngine();
}

export function getSharedPluginEngine(): PluginEngine {
    if (!sharedPluginEngine) {
        sharedPluginEngine = new PluginEngine();
    }
    return sharedPluginEngine;
}

export function resetSharedPluginEngine(): PluginEngine {
    sharedPluginEngine = new PluginEngine();
    return sharedPluginEngine;
}

export interface FeatureFlags {
    topology: boolean;
    bulkLanding: boolean;
    trafficAnalytics: boolean;
}

// Default-off rollout flags, overridable via FEATURE_<NAME>=true env vars.
export const FEATURE_FLAGS: FeatureFlags = {
    topology: false,
    bulkLanding: false,
    trafficAnalytics: false,
};

const FEATURE_ENV_KEY_MAP: Record<keyof FeatureFlags, string> = {
    topology: 'FEATURE_TOPOLOGY',
    bulkLanding: 'FEATURE_BULK_LANDING',
    trafficAnalytics: 'FEATURE_TRAFFIC_ANALYTICS',
};

export function isFeatureEnabled(flag: keyof FeatureFlags, env?: any): boolean {
    const targetEnv = env ?? (globalThis as any).__CF_ENV__;
    const envVal = targetEnv?.[FEATURE_ENV_KEY_MAP[flag]];
    if (envVal === 'true' || envVal === '1') return true;
    if (envVal === 'false' || envVal === '0') return false;
    return FEATURE_FLAGS[flag];
}

export async function forwardWorkerBridgeProxy(
    c: any,
    pluginEngine: PluginEngine,
    scope: 'admin' | 'public',
    prefixBase: '/admin/ext' | '/ext',
    siteId: string
): Promise<Response> {
    const slug = (c.req.param('slug') || '').trim().toLowerCase();
    const reqUrl = new URL(c.req.url);
    const prefix = `${prefixBase}/${slug}`;
    const restPath = reqUrl.pathname.startsWith(prefix) ? (reqUrl.pathname.slice(prefix.length) || '/') : '/';
    const forwardPath = `${restPath}${reqUrl.search || ''}`;
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v: string, k: string) => { headers[k] = v; });
    const bodyText = (c.req.method !== 'GET' && c.req.method !== 'HEAD') ? await c.req.text() : '';
    try {
        const res = await pluginEngine.runPipeline(createHookContext({
            action: 'WORKER_BRIDGE_PROXY',
            data: { scope, slug, forwardPath, method: c.req.method, headers, bodyText, siteId },
            c,
            siteId,
            user: scope === 'admin' ? c.get('user') : undefined
        }));
        return new Response(res.bodyText, { status: res.status || 200, headers: res.headers });
    } catch (err: any) {
        const msg = String(err?.message || 'Worker proxy error');
        return c.text(msg, (msg.startsWith('LICENSE_') ? 403 : 502) as any);
    }
}
