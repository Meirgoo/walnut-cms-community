import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser, ScheduledTask } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, getSiteTimezone, getCommercialSnippet } from '../../engine';
import { renderFolderChips } from '../routes/common';
import { buildTaskRowsHtml } from './AuditList';

export const TasksListPage = async (props: {
    tasks: ScheduledTask[];
    sites: Site[];
    currentSiteId: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    canUseFeature?: (feature?: string) => boolean;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const isCommercial = props.canUseFeature ? props.canUseFeature('cms:*') : false;
    const i18n = getAdminI18nSlice(locale, ['tasks', 'common']);
    const activeSite = props.sites.find(s => s.id === props.currentSiteId) || props.sites[0];
    const timezone = getSiteTimezone(activeSite);
    const distinctFolders = Array.from(new Set(props.tasks.map(t => t.task_type || 'default'))).filter(Boolean);

    const [
        tasksListTemplate,
        taskModalTemplate,
        taskRowTemplate
    ] = await Promise.all([
        fetchAsset('/admin/pages/tasks-list.html'),
        fetchAsset('/admin/modals/task-modal.html'),
        fetchAsset('/admin/snippets/task-row.html')
    ]);

    const folderChipsHtml = renderFolderChips(distinctFolders, 'tasks-table', 'tasks-folder-chips');
    const tasksTableBodyHtml = buildTaskRowsHtml(props.tasks, i18n, locale, timezone, taskRowTemplate);

    let commercialTaskTypesHtml = '';
    if (isCommercial) {
        const typesTpl = getCommercialSnippet('task-types.html');
        if (typesTpl) {
            commercialTaskTypesHtml = renderTemplate(typesTpl, {}, i18n);
        }
    }

    const taskModalHtml = renderTemplate(taskModalTemplate, {
        site_id: props.currentSiteId,
        slot_commercial_task_types: commercialTaskTypesHtml.trim(),
    }, i18n);

    const pageHtml = renderTemplate(tasksListTemplate, {
        folder_chips_html: folderChipsHtml,
        total_records_text: i18n.format(i18n.total_records, { count: props.tasks.length }),
        tasks_table_body: tasksTableBodyHtml,
        task_modal: taskModalHtml
    }, i18n);

    return (
        <AdminLayout
            title={i18n.title}
            {...props}
            locale={locale}
        >
            {raw(pageHtml)}
        </AdminLayout>
    );
};
