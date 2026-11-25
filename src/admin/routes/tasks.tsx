import { Hono, type Context } from 'hono';
import type { AppHonoEnv, ScheduledTask, TaskType } from '../../engine';
import { findTasksBySite, getAdminLocale, getAdminI18nSlice } from '../../engine';
import { getAdminRouteContext, runAdminPipeline, renderStatusMessage } from './common';
import { TasksListPage } from '../pages/TasksList';

const tasksRouter = new Hono<AppHonoEnv>();

const handleTaskByIdAction = (action: string) => async (c: Context<AppHonoEnv>) => {
    const id = c.req.param('id') || '';
    try {
        await runAdminPipeline<{ id: string }, { success: boolean }>(c, action, { id });
        return c.body(null, 200);
    } catch {
        return c.body(null, 500);
    }
};

tasksRouter.get('/', async (c) => {
    const ctx = await getAdminRouteContext(c);
    const activeSiteId = ctx.activeSite?.id || ctx.siteId || '';

    let tasks: ScheduledTask[];
    try {
        tasks = await findTasksBySite(ctx.db, activeSiteId);
    } catch {
        tasks = [];
    }

    return c.html(
        <TasksListPage
            tasks={tasks}
            {...ctx}
        />
    );
});

tasksRouter.post('/api/save', async (c) => {
    const formData = await c.req.parseBody();
    const locale = getAdminLocale(c);

    const id = (formData.id as string) || undefined;
    const siteId = (formData.site_id as string) || undefined;
    const taskType = (formData.task_type as TaskType) || 'publish_node';
    const scheduleType = ((formData.schedule_type as string) === 'once' ? 'once' : 'recurring') as 'once' | 'recurring';
    const intervalPreset = (formData.interval_preset as string) || 'custom';
    const cronIntervalMinutes = parseInt((formData.cron_interval_minutes as string) || '5', 10);
    const rawRunAt = ((formData.next_run_at as string) || '').trim();
    const nextRunAt = rawRunAt ? new Date(rawRunAt).toISOString() : undefined;
    const effectiveSiteId = siteId || c.get('siteId') || undefined;

    const payload: Record<string, any> = {};
    const targetNodeId = ((formData.target_node_id as string) || '').trim();
    if (targetNodeId) payload.node_id = targetNodeId;
    if (formData.retention_days !== undefined && formData.retention_days !== '') {
        const days = parseInt(formData.retention_days as string, 10);
        if (!Number.isNaN(days) && days > 0) payload.retention_days = days;
    }
    if (formData.retention_count !== undefined && formData.retention_count !== '') {
        const count = parseInt(formData.retention_count as string, 10);
        if (!Number.isNaN(count) && count > 0) payload.retention_count = count;
    }

    try {
        await runAdminPipeline(
            c,
            'TASK_CREATE',
            {
                id,
                siteId,
                taskType,
                scheduleType,
                intervalPreset,
                cronIntervalMinutes,
                nextRunAt,
                payload,
                emitActivity: true
            },
            effectiveSiteId
        );

        const i18n = getAdminI18nSlice(locale, 'tasks');
        c.header('HX-Refresh', 'true');
        return renderStatusMessage(c, i18n.tasks.save_success, 'success');
    } catch (err: any) {
        return renderStatusMessage(c, `${err.message || 'Error'}`, 'error', 500);
    }
});

tasksRouter.post('/api/trigger/:id', handleTaskByIdAction('TASK_EXECUTE'));

tasksRouter.post('/:id/run', async (c) => {
    const id = c.req.param('id') || '';
    const locale = getAdminLocale(c);
    try {
        const result = await runAdminPipeline<{ id: string }, { success: boolean; details: string }>(
            c,
            'TASK_RUN_NOW',
            { id }
        );
        const i18n = getAdminI18nSlice(locale, 'tasks');
        c.header('HX-Refresh', 'true');
        if (c.req.header('Accept')?.includes('application/json')) {
            return c.json(result);
        }
        return renderStatusMessage(c, `${i18n.tasks.run_now_success}: ${result.details}`, result.success ? 'success' : 'error');
    } catch (err: any) {
        return renderStatusMessage(c, `${err.message || 'Error'}`, 'error', 500);
    }
});

tasksRouter.delete('/api/delete/:id', handleTaskByIdAction('TASK_DELETE'));

export { tasksRouter };

