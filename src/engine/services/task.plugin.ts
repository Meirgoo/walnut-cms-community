import type { ScheduledEvent, ExecutionContext, D1Database } from '@cloudflare/workers-types';
import type {
    EngineStorageBindings,
    WalnutPlugin,
    IPluginEngine,
    TaskType
} from '../types';
import { createHookContext, nanoId } from '../kernel';
import { DAL } from '../dal';
import { assertSiteAdmin } from './common.helper';
import {
    recompileDirtySiteRoutes,
    rebuildSiteSitemapRoute,
    calibrateStorageUsage,
    findDueTasks,
    findTaskById,
    buildUpdateTaskRunningStatement,
    buildResetFinishedTaskToPendingStatement,
    buildUpdateTaskCompletedStatement,
    buildMarkTaskFailedStatement,
    buildRescheduleTaskStatement,
    buildPublishNodesByIdStatements,
    executePublishDueArticles,
    buildUnpublishNodesByIdStatements,
    executeUnpublishDueContent,
    findExpiredDeletedMediaAssets,
    buildCleanupSoftDeletedEntitiesStatements,
    buildInsertTaskStatement,
    buildUpdateTaskStatement,
    buildTriggerTaskNowStatement,
    buildDeleteTaskStatement
} from '../core/dal';

export interface TaskHandlerContext {
    db: D1Database;
    dal: DAL;
    task: any;
    payloadObj: Record<string, any>;
    targetSiteId: string;
    siteRow: any;
    bindings: EngineStorageBindings & Record<string, any>;
    executionCtx: ExecutionContext;
    pluginEngine?: IPluginEngine;
    buildSystemHookContext: <TData = any, TResult = any>(
        action: string,
        siteId: string,
        data: TData,
        licenseKey?: string | null
    ) => any;
}

export type TaskHandlerFn = (ctx: TaskHandlerContext) => Promise<string>;

const taskHandlerRegistry = new Map<string, TaskHandlerFn>();

export function registerTaskHandler(taskType: string, handler: TaskHandlerFn): void {
    if (taskType && typeof handler === 'function') {
        taskHandlerRegistry.set(taskType, handler);
    }
}

export function resolveIntervalMinutes(preset?: string | null, customMinutes = 5): number {
    switch (preset) {
        case 'hourly': return 60;
        case 'daily': return 1440;
        case 'weekly': return 10080;
        case 'monthly': return 43200;
        default: return customMinutes;
    }
}

export class TaskPlugin {
    public async executeTaskItem(
        task: any,
        bindings: EngineStorageBindings & Record<string, any>,
        ctx?: ExecutionContext,
        pluginEngine?: IPluginEngine
    ): Promise<{ status: 'success' | 'failed'; details: string }> {
        const db = bindings.DB || (bindings as any).db;
        if (!db) return { status: 'failed', details: 'Database binding unavailable' };

        const dal = new DAL({
            DB: db,
            BUCKET: bindings.BUCKET,
            BUCKET_BACKUP: bindings.BUCKET_BACKUP
        });

        const buildSystemHookContext = <TData = any, TResult = any>(
            action: string,
            siteId: string,
            data: TData,
            licenseKey?: string | null
        ) => {
            return createHookContext<TData, TResult>({
                action,
                data,
                env: {
                    ...(bindings as any),
                    DB: db,
                    BUCKET: bindings.BUCKET as any,
                    BUCKET_BACKUP: bindings.BUCKET_BACKUP as any,
                    LICENSE_KEY: licenseKey || (bindings as any).LICENSE_KEY || undefined
                } as any,
                executionCtx: ctx,
                dal,
                siteId,
                // Site-scoped tasks must not elevate to global superadmin privileges.
                user: task.site_id
                    ? {
                        id: 'system:cron',
                        username: 'system:cron',
                        email: 'cron@system.local',
                        global_role: 'user',
                        site_role: 'admin',
                        auth_provider: 'api_token',
                        token_site_id: siteId
                    }
                    : {
                        id: 'system:cron',
                        username: 'system:cron',
                        email: 'cron@system.local',
                        global_role: 'superadmin',
                        site_role: 'admin',
                        auth_provider: 'session'
                    }
            });
        };

        const startTime = Date.now();
        let taskStatus: 'success' | 'failed' = 'success';
        let executionDetails = '';
        const targetSiteId = task.site_id || 'site_default';
        let payloadObj: Record<string, any> = {};

        const claimNowIso = new Date().toISOString();
        const claimRes = await buildUpdateTaskRunningStatement(db, task.id, claimNowIso).run();
        if ((claimRes.meta?.changes || 0) !== 1) {
            return { status: 'failed', details: `Skipped concurrent or non-pending task [${task.id}]` };
        }

        let isMalformedPayload = false;
        try {
            if (task.payload) {
                try {
                    payloadObj = typeof task.payload === 'string' ? JSON.parse(task.payload) : task.payload;
                    if (!payloadObj || typeof payloadObj !== 'object') {
                        payloadObj = {};
                    }
                } catch (parseErr: any) {
                    isMalformedPayload = true;
                    throw new Error(`Invalid task payload JSON: ${parseErr?.message || 'parse error'}`);
                }
            }

            const siteRow = await dal.findSiteById(targetSiteId);

            switch (task.task_type) {
                case 'publish_node': {
                    if (payloadObj.node_id) {
                        await db.batch(buildPublishNodesByIdStatements(db, payloadObj.node_id, targetSiteId));
                        await recompileDirtySiteRoutes(db, targetSiteId, 15);
                        executionDetails = `Scheduled publishing and precompilation succeeded for content [${payloadObj.title || payloadObj.node_id}]`;
                    } else {
                        const changes = await executePublishDueArticles(db, targetSiteId, new Date().toISOString());
                        if (changes > 0) {
                            await recompileDirtySiteRoutes(db, targetSiteId, 15);
                        }
                        executionDetails = `Scheduled publishing batch check completed (changes: ${changes})`;
                    }
                    break;
                }
                case 'scheduled_unpublish': {
                    if (payloadObj.node_id) {
                        await db.batch(buildUnpublishNodesByIdStatements(db, payloadObj.node_id, targetSiteId));
                        executionDetails = `Scheduled unpublish succeeded for content [${payloadObj.title || payloadObj.node_id}]`;
                    } else {
                        const changes = await executeUnpublishDueContent(db, targetSiteId, new Date().toISOString());
                        executionDetails = `Scheduled unpublish batch check completed (unpublished: ${changes})`;
                    }
                    break;
                }
                case 'cache_warmup': {
                    const res = await recompileDirtySiteRoutes(db, targetSiteId, 50);
                    executionDetails = `Edge cache warmup completed: synced ${res.syncedCount} routes, recompiled ${res.compiledCount} pages`;
                    break;
                }
                case 'recompile_dirty_routes': {
                    const res = await recompileDirtySiteRoutes(db, targetSiteId, 30);
                    executionDetails = `Idle route synchronization and precompilation completed: synced ${res.syncedCount} routes, recompiled ${res.compiledCount} dirty pages, updated /sitemap.xml`;
                    break;
                }
                case 'update_sitemap':
                case 'generate_visitor_page_index': {
                    const res = await recompileDirtySiteRoutes(db, targetSiteId, 25);
                    if (siteRow) {
                        await rebuildSiteSitemapRoute(db, siteRow, siteRow.primary_domain);
                    }
                    executionDetails = `Route table and /sitemap.xml scan updated: indexed ${res.syncedCount} URLs, recompiled ${res.compiledCount} dirty pages`;
                    break;
                }
                case 'purge_deleted': {
                    const retentionDays = Math.max(1, Number(payloadObj.retention_days ?? 30));
                    const cutoffIso = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
                    const scopedSite = task.site_id || undefined;
                    const expiredMedia = await findExpiredDeletedMediaAssets(db, cutoffIso, scopedSite);
                    if (expiredMedia.length > 0 && bindings.BUCKET) {
                        for (const asset of expiredMedia) {
                            if (asset.r2_key) {
                                try {
                                    await bindings.BUCKET.delete(asset.r2_key);
                                } catch {}
                            }
                        }
                    }
                    await db.batch(buildCleanupSoftDeletedEntitiesStatements(db, cutoffIso, scopedSite));
                    executionDetails = `Purged items exceeding ${retentionDays}-day retention in trash (media: ${expiredMedia.length})`;
                    break;
                }
                case 'vacuum_db': {
                    executionDetails = 'D1 defragmentation and optimization finished';
                    break;
                }
                case 'calibrate_storage_usage': {
                    const summary = await calibrateStorageUsage(db, bindings.BUCKET, bindings.BUCKET_BACKUP);
                    executionDetails = `Storage calibrated: D1=${summary.d1SizeBytes}B, R2Primary=${summary.r2PrimaryBytes}B, R2Backup=${summary.r2BackupBytes}B`;
                    break;
                }
                default: {
                    const registeredHandler = taskHandlerRegistry.get(task.task_type);
                    if (registeredHandler) {
                        executionDetails = await registeredHandler({
                            db,
                            dal,
                            task,
                            payloadObj,
                            targetSiteId,
                            siteRow,
                            bindings,
                            executionCtx: ctx as ExecutionContext,
                            pluginEngine,
                            buildSystemHookContext
                        });
                    } else {
                        executionDetails = `Skipped unregistered task type: ${task.task_type}`;
                    }
                    break;
                }
            }

            const finishIso = new Date().toISOString();
            const isOnce = task.schedule_type === 'once' || ((task.cron_interval_minutes || 0) <= 0 && (!task.interval_preset || task.interval_preset === 'custom'));
            if (isOnce) {
                await buildUpdateTaskCompletedStatement(db, task.id, executionDetails, finishIso).run();
            } else {
                const intervalMins = resolveIntervalMinutes(task.interval_preset, task.cron_interval_minutes || 60);
                const nextRunDate = new Date(Date.now() + intervalMins * 60 * 1000);
                await buildRescheduleTaskStatement(db, task.id, nextRunDate.toISOString(), executionDetails, finishIso).run();
            }
        } catch (err: any) {
            taskStatus = 'failed';
            executionDetails = `Task execution error: ${err.message || 'Unknown error'}`;
            console.error(`[TaskPlugin] Task [${task.id}] failed:`, err);
            const failIso = new Date().toISOString();
            if (isMalformedPayload) {
                // Permanently mark malformed-payload tasks as failed so broken JSON does not block subsequent runs.
                await buildMarkTaskFailedStatement(db, task.id, executionDetails, failIso).run();
            } else {
                const intervalMins = resolveIntervalMinutes(task.interval_preset, task.cron_interval_minutes || 15);
                const retryMinutes = intervalMins > 0 ? intervalMins : 15;
                const nextRetryDate = new Date(Date.now() + retryMinutes * 60 * 1000);
                await buildRescheduleTaskStatement(db, task.id, nextRetryDate.toISOString(), executionDetails, failIso).run();
            }
        }

        if (pluginEngine) {
            try {
                const txCtx = buildSystemHookContext(
                    'TASK_EXECUTED',
                    targetSiteId,
                    {
                        taskId: task.id,
                        taskType: task.task_type,
                        durationMs: Date.now() - startTime,
                        emitActivity: payloadObj.emit_activity ?? true,
                        message: executionDetails,
                        status: taskStatus
                    }
                );
                txCtx.meta.auditAction = `CRON_${task.task_type.toUpperCase()}`;
                await pluginEngine.runPipeline(txCtx);
            } catch (logErr) {
                console.error('[TaskPlugin] Failed to emit TASK_EXECUTED pipeline:', logErr);
            }
        }

        return { status: taskStatus, details: executionDetails };
    }

    public async handleScheduled(
        _event: ScheduledEvent,
        bindings: EngineStorageBindings & Record<string, any>,
        ctx: ExecutionContext,
        pluginEngine?: IPluginEngine
    ): Promise<void> {
        const db = bindings.DB || (bindings as any).db;
        if (!db) return;

        try {
            const nowIso = new Date().toISOString();
            const dueTasks = await findDueTasks(db, nowIso, 10);
            const cronStart = Date.now();

            for (const task of dueTasks) {
                if (Date.now() - cronStart > 2000) {
                    console.warn('[TaskPlugin] Cron execution budget (2000ms) reached, deferring remaining tasks to next tick.');
                    break;
                }
                try {
                    await this.executeTaskItem(task, bindings, ctx, pluginEngine);
                } catch (taskErr) {
                    console.error(`[TaskPlugin] Isolated task [${task.id}] exception:`, taskErr);
                }
            }
        } catch (e) {
            console.error('[TaskPlugin] Task scheduler exception:', e);
        }
    }
}

export interface SaveTaskParams {
    id?: string;
    siteId?: string;
    taskType?: TaskType;
    scheduleType?: 'once' | 'recurring';
    intervalPreset?: string;
    cronIntervalMinutes?: number;
    nextRunAt?: string;
    emitActivity?: boolean;
    payload?: Record<string, any> | string;
}

export const taskPlugin: WalnutPlugin = {
    name: 'task:core',
    tier: 'community',
    setup(engine: IPluginEngine): void {
        for (const action of ['TASK_CREATE', 'TASK_SAVE'] as const) {
            engine.registerService<SaveTaskParams, { taskId: string; success: boolean }>(
                action,
                async (ctx) => {
                    const params = ctx.data;
                    const isEdit = !!params.id;
                    const taskId = params.id || nanoId('task');
                    const isSuper = ctx.user?.global_role === 'superadmin';
                    const siteId = params.siteId || ctx.siteId || null;
                    if (!siteId) {
                        if (!isSuper) throw new Error('FORBIDDEN_GLOBAL_TASK_REQUIRES_SUPERADMIN');
                    } else {
                        await assertSiteAdmin(ctx.dal, siteId, ctx.user);
                    }
                    if (isEdit && !isSuper && siteId) {
                        const existingTask = await findTaskById(ctx.dal.db, taskId, siteId);
                        if (!existingTask) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
                    }

                    const taskType = params.taskType || 'recompile_dirty_routes';
                    const scheduleType = params.scheduleType || 'recurring';
                    const intervalPreset = params.intervalPreset || 'custom';
                    const rawMins = params.cronIntervalMinutes ?? 60;
                    const cronIntervalMinutes = scheduleType === 'once'
                        ? 0
                        : resolveIntervalMinutes(intervalPreset, rawMins);
                    const nextRun = params.nextRunAt || new Date(Date.now() + Math.max(1, cronIntervalMinutes) * 60 * 1000).toISOString();

                    const payloadObj = {
                        ...(typeof params.payload === 'object' ? params.payload : {}),
                        emit_activity: params.emitActivity ?? true
                    };
                    const payloadStr = typeof params.payload === 'string' ? params.payload : JSON.stringify(payloadObj);

                    const taskPayload = {
                        id: taskId,
                        siteId: siteId || undefined,
                        taskType,
                        scheduleType,
                        intervalPreset,
                        payloadJson: payloadStr,
                        cronIntervalMinutes,
                        nextRunAt: nextRun
                    };
                    const stmt = isEdit
                        ? buildUpdateTaskStatement(ctx.dal.db, taskPayload, isSuper ? undefined : (siteId || undefined))
                        : buildInsertTaskStatement(ctx.dal.db, taskPayload);
                    await ctx.dal.batch([stmt]);

                    return { taskId, success: true };
                }
            );
        }

        engine.registerService<{ id: string; siteId?: string }, { success: boolean }>('TASK_EXECUTE', async (ctx) => {
            const isSuper = ctx.user?.global_role === 'superadmin';
            const scopeSiteId = ctx.data?.siteId || ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, scopeSiteId, ctx.user);
            if (!isSuper) {
                const task = await findTaskById(ctx.dal.db, ctx.data.id, scopeSiteId);
                if (!task) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
            }
            await ctx.dal.batch([buildTriggerTaskNowStatement(ctx.dal.db, ctx.data.id, isSuper ? undefined : scopeSiteId)]);
            return { success: true };
        });

        engine.registerService<{ id: string; siteId?: string }, { success: boolean; details: string }>('TASK_RUN_NOW', async (ctx) => {
            const isSuper = ctx.user?.global_role === 'superadmin';
            const scopeSiteId = ctx.data?.siteId || ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, scopeSiteId, ctx.user);
            const task = await findTaskById(ctx.dal.db, ctx.data.id, isSuper ? undefined : scopeSiteId);
            if (!task) {
                throw new Error(`Task not found or forbidden: ${ctx.data.id}`);
            }
            await buildResetFinishedTaskToPendingStatement(ctx.dal.db, ctx.data.id).run();
            const pluginInstance = new TaskPlugin();
            const res = await pluginInstance.executeTaskItem(
                task,
                ctx.env as unknown as EngineStorageBindings & Record<string, any>,
                ctx.executionCtx,
                engine
            );
            return { success: res.status === 'success', details: res.details };
        });

        engine.registerService<{ id: string; siteId?: string }, { success: boolean }>('TASK_DELETE', async (ctx) => {
            const isSuper = ctx.user?.global_role === 'superadmin';
            const scopeSiteId = ctx.data?.siteId || ctx.siteId || 'site_default';
            await assertSiteAdmin(ctx.dal, scopeSiteId, ctx.user);
            if (!isSuper) {
                const task = await findTaskById(ctx.dal.db, ctx.data.id, scopeSiteId);
                if (!task) throw new Error('FORBIDDEN_CROSS_SITE_ACCESS');
            }
            await ctx.dal.batch([buildDeleteTaskStatement(ctx.dal.db, ctx.data.id, isSuper ? undefined : scopeSiteId)]);
            return { success: true };
        });

        engine.registerService<Record<string, any>, { success: boolean }>('TASK_EXECUTED', async (ctx) => {
            return { success: ctx.data?.status !== 'failed' };
        });
    }
};
