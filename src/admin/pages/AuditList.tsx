import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser, ScheduledTask } from '../../engine';
import {
    renderTemplate,
    fetchAsset,
    getAdminI18nSlice,
    formatSiteDateTime,
    getUserTimezone,
    t,
    escapeHtml,
    getCommercialSnippet,
    getCommercialModal,
    isFeatureEnabled
} from '../../engine';
import { renderEmptyTableRow, renderFolderChips } from '../routes/common';

export interface UserRow {
    id: string;
    username: string;
    email: string;
    global_role: string;
    site_role?: string;
    folder?: string;
    created_at: string;
}

export interface AuditLogRow {
    id: string;
    site_id?: string;
    user_id?: string;
    username?: string;
    action: string;
    details?: string;
    ip_address?: string;
    status: string;
    created_at: string;
}

export interface WebhookConfigItem {
    id: string;
    site_id?: string;
    form_id: string;
    name: string;
    form_webhook_url: string;
    form_webhook_secret?: string | null;
    is_active: number;
    created_at?: string;
    updated_at?: string;
}

export interface WebhookLogItem {
    id: string;
    site_id: string;
    form_id: string;
    target_url: string;
    platform: string;
    status_code: number;
    payload?: string | null;
    response_body?: string | null;
    error_message?: string | null;
    client_ip?: string | null;
    created_at: string;
}

function buildHourlyAggregatedLogsHtml(logs: AuditLogRow[], locale: string): string {
    const hourlyMap = new Map<string, { total: number; success: number; failed: number; actions: Record<string, number> }>();
    for (const l of logs) {
        const hourKey = (l.created_at || '').slice(0, 13).replace('T', ' ');
        if (!hourKey) continue;
        if (!hourlyMap.has(hourKey)) {
            hourlyMap.set(hourKey, { total: 0, success: 0, failed: 0, actions: {} });
        }
        const grp = hourlyMap.get(hourKey)!;
        grp.total++;
        if (l.status === 'success') grp.success++;
        else grp.failed++;
        const act = l.action || 'UNKNOWN';
        grp.actions[act] = (grp.actions[act] || 0) + 1;
    }

    const totalOpsPrefix = t(locale, 'logs.total_operations');
    const successLabel = t(locale, 'common.success');
    const failedLabel = t(locale, 'common.error');
    const expandLabel = t(locale, 'logs.view_detail');
    const emptyAggregated = t(locale, 'logs.empty_aggregated');

    return Array.from(hourlyMap.entries()).map(([hourStr, grp]) => {
        const safeHour = escapeHtml(hourStr);
        const actionBadges = Object.entries(grp.actions).map(([act, cnt]) => {
            const isWebhook = act.includes('WEBHOOK');
            const badgeClass = isWebhook
                ? 'bg-purple-50 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 border border-purple-200/60'
                : 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300';
            return `<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold ${badgeClass}">${escapeHtml(act)} × ${cnt}</span>`;
        }).join(' ');

        return `<div class="p-4 bg-slate-50 dark:bg-slate-900/60 rounded-xl border border-slate-200/80 dark:border-slate-700/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:border-emerald-500/50 transition"><div class="space-y-1"><div class="flex items-center space-x-2"><span class="font-mono font-bold text-xs text-slate-800 dark:text-slate-100">${safeHour}:00 ~ ${safeHour}:59</span><span class="text-xs font-bold text-emerald-600 dark:text-emerald-400 font-mono">${totalOpsPrefix}: ${grp.total}</span></div><div class="flex flex-wrap gap-1.5 pt-1">${actionBadges}</div></div><div class="flex items-center space-x-3 shrink-0"><div class="text-[11px] font-mono space-x-1.5"><span class="text-emerald-600 dark:text-emerald-400 font-bold">${successLabel}: ${grp.success}</span>${grp.failed > 0 ? `<span class="text-red-500 font-bold">${failedLabel}: ${grp.failed}</span>` : ''}</div><button type="button" onclick="window.viewHourLogsDetail ? window.viewHourLogsDetail('${safeHour}') : viewHourLogsDetail('${safeHour}')" class="px-2.5 py-1 rounded-lg text-xs font-bold bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition cursor-pointer">${expandLabel}</button></div></div>`;
    }).join('') || `<div class="p-8 text-center text-xs text-slate-400">${emptyAggregated}</div>`;
}

export interface D1SnapshotListItem {
    key: string;
    sizeBytes: number;
    uploadedAt: string;
    siteId?: string;
    totalRows?: number;
}

export interface AuditListPageProps {
    users: UserRow[];
    sites: Site[];
    currentSiteId: string;
    currentDomain?: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    canUseFeature?: (feature?: string) => boolean;
    tasks?: ScheduledTask[];
    logs?: AuditLogRow[];
    webhookConfigs?: WebhookConfigItem[];
    webhookLogs?: WebhookLogItem[];
    backups?: D1SnapshotListItem[];
    blocklist?: Array<{ id: string; ip_address: string; reason: string; created_at: string }>;
    traffic?: any;
    isCfAccess?: boolean;
    activeTab?: 'tab-logs' | 'tab-tasks' | 'tab-webhooks' | 'tab-backups' | 'tab-blocklist' | 'tab-traffic' | 'tab-users';
    locale?: string;
}

export function buildUserRowsHtml(
    users: UserRow[],
    i18n: any,
    locale: string,
    currentUser: any,
    userRowTemplate: string,
    timezone = 'Asia/Shanghai'
): string {
    if (users.length === 0) return renderEmptyTableRow('8', i18n.empty);
    return users.map(u => {
        const isSelf = currentUser && currentUser.id === u.id;
        const userJson = JSON.stringify(u);
        const folder = u.folder || u.global_role || 'member';

        const editBtn = `<button type="button" onclick='openEditUserModal(${userJson})' class="text-xs font-bold text-slate-700 dark:text-slate-200 hover:text-slate-900 dark:hover:text-white hover:underline cursor-pointer">${i18n.edit}</button>`;
        const deleteBtn = !isSelf ? `<button type="button" hx-delete="/admin/users/api/delete/${u.id}" hx-target="#user-row-${u.id}" hx-swap="outerHTML" hx-confirm="${i18n.format(i18n.confirm_delete, { username: u.username })}" class="text-xs font-bold text-red-500 hover:text-red-700 cursor-pointer ml-2">${i18n.delete}</button>` : '';
        const currentUserBadgeHtml = isSelf ? `<span class="bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 text-[10px] px-1.5 py-0.2 rounded font-bold font-mono">${i18n.current_user_badge}</span>` : '';
        const globalRoleBadgeClass = u.global_role === 'superadmin' ? 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-800' : 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200';
        const siteRoleBadgeClass = u.site_role === 'admin' ? 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300 border border-purple-200 dark:border-purple-800' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700';

        return renderTemplate(userRowTemplate, {
            id: u.id,
            folder,
            username: u.username,
            avatar_initial: u.username.slice(0, 2).toUpperCase(),
            current_user_badge_html: currentUserBadgeHtml,
            email: u.email,
            global_role: u.global_role,
            global_role_badge_class: globalRoleBadgeClass,
            global_role_text: u.global_role === 'superadmin' ? i18n.role_superadmin : i18n.role_user,
            site_role: u.site_role || 'admin',
            site_role_badge_class: siteRoleBadgeClass,
            site_role_text: u.site_role === 'admin' ? i18n.role_admin : i18n.role_visitor,
            created_at: u.created_at,
            created_at_formatted: formatSiteDateTime(u.created_at, locale, timezone),
            actions_html: `${editBtn}${deleteBtn}`
        });
    }).join('');
}

const BADGE_OK = 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800';
const BADGE_ERR = 'bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800';
const BADGE_WARN = 'bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800';
const BADGE_MUTED = 'bg-slate-100 dark:bg-slate-800 text-slate-500 border border-slate-200 dark:border-slate-700';
const pillBadge = (cls: string, text: string, title = '') =>
    `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${cls}"${title ? ` title="${title}"` : ''}>${text}</span>`;

export function buildTaskRowsHtml(
    tasks: ScheduledTask[],
    i18n: any,
    locale: string,
    timezone: string,
    taskRowTemplate: string
): string {
    if (tasks.length === 0) return renderEmptyTableRow('7', i18n.empty);
    return tasks.map(task => {
        const taskJson = JSON.stringify(task).replace(/"/g, '&quot;');
        const folder = task.task_type || 'default';
        const statusClass = task.status === 'running' ? 'bg-blue-100 dark:bg-blue-950 text-blue-800 dark:text-blue-300' :
            ((task.status === 'pending' || task.status === 'completed') ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300' : 'bg-red-100 dark:bg-red-950 text-red-800 dark:text-red-300');
        const safeLastResult = (task.last_result || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const lastResultHtml = safeLastResult
            ? `<div class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate max-w-xs" title="${safeLastResult.replace(/"/g, '&quot;')}">${safeLastResult}</div>`
            : '';

        return renderTemplate(taskRowTemplate, {
            id: task.id,
            task_type: task.task_type,
            folder,
            last_result_html: lastResultHtml,
            cron_interval_minutes: task.cron_interval_minutes,
            minutes: i18n.minutes,
            next_run_at: task.next_run_at,
            next_run_at_formatted: formatSiteDateTime(task.next_run_at, locale, timezone),
            last_run_at: task.last_run_at || '',
            last_run_at_formatted: task.last_run_at ? formatSiteDateTime(task.last_run_at, locale, timezone) : i18n.not_run_yet,
            status: task.status,
            status_class: statusClass,
            trigger_success: i18n.trigger_success,
            btn_trigger_now: i18n.btn_trigger_now,
            task_json: taskJson,
            edit: i18n.edit,
            confirm_delete: i18n.confirm_delete,
            delete: i18n.delete
        });
    }).join('');
}

export function buildLogRowsHtml(
    logs: AuditLogRow[],
    i18n: any,
    locale: string,
    timezone: string,
    logRowTemplate: string
): string {
    if (logs.length === 0) return renderEmptyTableRow('6', i18n.empty);
    return logs.map(l => {
        const actionKey = 'logs.action_' + (l.action || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
        const locAct = t(locale, actionKey);
        const localizedAction = locAct !== actionKey ? locAct : l.action;
        const logJsonEscaped = JSON.stringify(l).replace(/"/g, '&quot;');
        const statusBadgeClass = l.status === 'success' ? BADGE_OK : BADGE_ERR;

        const detailsShort = (l.details || '').replace(/[\r\n\t]+/g, ' ').trim();
        const detailsDisplay = detailsShort.length > 60 ? detailsShort.slice(0, 60) + '...' : (detailsShort || '-');

        return renderTemplate(logRowTemplate, {
            id: l.id,
            log_json: logJsonEscaped,
            view_detail: i18n.view_detail,
            action: l.action,
            localized_action: localizedAction,
            username_sort: l.username || l.user_id || 'System',
            avatar_initial: (l.username || 'U').slice(0, 1).toUpperCase(),
            display_username: l.username || i18n.anonymous_user,
            user_id_html: l.user_id ? `<div class="text-[10px] text-slate-400 font-mono">${l.user_id}</div>` : '',
            details: l.details || '',
            details_display: detailsDisplay,
            status: l.status,
            status_class: statusBadgeClass,
            status_text: l.status === 'success' ? i18n.status_success : i18n.status_failed,
            ip_address: l.ip_address || '-',
            created_at: l.created_at,
            created_at_formatted: formatSiteDateTime(l.created_at, locale, timezone)
        });
    }).join('');
}

export function buildWebhookConfigRowsHtml(
    configs: WebhookConfigItem[],
    i18n: any,
    webhookRowTemplate: string
): string {
    if (configs.length === 0) return `<tr><td colspan="7" class="px-5 py-8 text-center text-xs text-slate-400">${i18n.empty}</td></tr>`;
    return configs.map(c => {
        const configJson = JSON.stringify(c).replace(/"/g, '&quot;');
        const statusBadge = c.is_active
            ? pillBadge(BADGE_OK, i18n.status_active)
            : pillBadge(BADGE_MUTED, i18n.status_disabled);

        return renderTemplate(webhookRowTemplate, {
            id: c.id,
            form_id: c.form_id,
            name: c.name,
            form_webhook_url: c.form_webhook_url,
            form_webhook_secret: c.form_webhook_secret || '',
            status_badge_html: statusBadge,
            config_json: configJson
        });
    }).join('');
}

export function buildWebhookLogRowsHtml(
    logs: WebhookLogItem[],
    locale: string,
    timezone: string,
    webhookLogRowTemplate: string
): string {
    if (logs.length === 0) return `<tr><td colspan="7" class="px-5 py-8 text-center text-xs text-slate-400"></td></tr>`;
    return logs.map(l => {
        const logJson = JSON.stringify(l).replace(/"/g, '&quot;');
        const statusBadgeClass = l.status_code >= 200 && l.status_code < 300 ? BADGE_OK : BADGE_ERR;

        return renderTemplate(webhookLogRowTemplate, {
            id: l.id,
            form_id: l.form_id,
            platform: l.platform,
            status_code: l.status_code,
            status_badge_class: statusBadgeClass,
            client_ip: l.client_ip || '-',
            target_url: l.target_url,
            created_at_formatted: formatSiteDateTime(l.created_at, locale, timezone),
            log_json: logJson
        });
    }).join('');
}

export function buildBackupRowsHtml(
    snapshots: D1SnapshotListItem[],
    i18n: any,
    locale: string,
    timezone: string,
    isCfAccess: boolean
): string {
    if (snapshots.length === 0) return renderEmptyTableRow('6', i18n.audit.empty_backups);
    return snapshots.map(s => {
        const sizeKb = (s.sizeBytes / 1024).toFixed(1) + ' KB';
        const formattedDate = s.uploadedAt ? formatSiteDateTime(s.uploadedAt, locale, timezone) : '-';
        const filename = s.key.split('/').pop() || s.key;
        const rowsCount = s.totalRows !== undefined ? String(s.totalRows) : '-';
        const siteLabel = s.siteId || 'all';

        const actionHtml = isCfAccess
            ? `<a href="/admin/audit/api/backups/download?key=${encodeURIComponent(s.key)}" class="inline-flex items-center space-x-1 text-xs font-bold text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 transition cursor-pointer"><span class="material-symbols-outlined text-[15px]">download</span><span>${i18n.audit.download_backup}</span></a>`
            : `<span class="inline-flex items-center space-x-1 text-xs font-medium text-slate-400 dark:text-slate-500 cursor-not-allowed" title="${i18n.audit.cf_access_required}"><span class="material-symbols-outlined text-[15px]">lock</span><span>${i18n.audit.read_only_locked}</span></span>`;

        const td = (cls: string, content: string, title = '') =>
            `<td class="px-5 py-3.5 text-xs ${cls}"${title ? ` title="${title}"` : ''}>${content}</td>`;
        const monoCell = 'text-slate-600 dark:text-slate-300 font-mono';
        const mutedCell = 'text-slate-500 dark:text-slate-400';

        return `<tr>${td('font-mono text-slate-700 dark:text-slate-200', `<div class="flex items-center space-x-1.5"><span class="material-symbols-outlined text-[16px] text-slate-400">database</span><span class="truncate max-w-xs font-bold">${filename}</span></div><div class="text-[10px] text-slate-400 font-mono mt-0.5 truncate">${s.key}</div>`, s.key)}${td(monoCell, siteLabel)}${td(monoCell, rowsCount)}${td(`${mutedCell} font-mono`, sizeKb)}${td(mutedCell, formattedDate)}${td('text-right font-mono', actionHtml)}</tr>`;
    }).join('');
}

export const AuditListPage = async (props: AuditListPageProps) => {
    const locale = props.locale || 'zh-CN';
    const isCommercial = props.canUseFeature ? props.canUseFeature('cms:*') : false;
    const activeSite = props.sites.find(s => s.id === props.currentSiteId) || props.sites[0];
    const timezone = getUserTimezone(props.currentUser, activeSite);
    const isCfAccess = props.isCfAccess ?? (props.currentUser?.auth_provider === 'cf_access');

    const i18n = getAdminI18nSlice(locale, ['audit', 'users', 'tasks', 'logs', 'webhooks', 'common']);

    const [
        auditPageTemplate,
        usersTabTemplate,
        userModalTemplate,
        editUserModalTemplate,
        userRowTemplate
    ] = await Promise.all([
        fetchAsset('/admin/pages/audit-page.html'),
        fetchAsset('/admin/snippets/audit-users-tab.html'),
        fetchAsset('/admin/modals/user-modal.html'),
        fetchAsset('/admin/modals/edit-user-modal.html'),
        fetchAsset('/admin/snippets/user-row.html')
    ]);

    const distinctUserFolders = Array.from(new Set(props.users.map(u => u.folder || u.global_role || 'member'))).filter(Boolean);
    const userFolderChipsHtml = renderFolderChips(distinctUserFolders, 'users-table', 'users-folder-chips');
    const usersTableBodyHtml = buildUserRowsHtml(props.users, i18n, locale, props.currentUser, userRowTemplate, timezone);

    const userModalHtml = renderTemplate(userModalTemplate, {}, i18n);
    const editUserModalHtml = renderTemplate(editUserModalTemplate, {}, i18n);

    const usersTabContentHtml = renderTemplate(usersTabTemplate, {
        new_user_btn_class: '',
        new_user_lock_class: 'hidden',
        folder_chips_html: userFolderChipsHtml,
        total_records_text: i18n.format(i18n.total_records, { count: props.users.length }),
        selected_count_zero: i18n.format(i18n.selected_count, { count: 0 }),
        users_table_body: usersTableBodyHtml,
        user_modal_html: userModalHtml,
        edit_user_modal_html: editUserModalHtml
    }, i18n);

    let slotCommercialAuditTabButtons = '';
    let slotAuditLogsContent = '';
    let slotAuditTasksContent = '';
    let slotAuditWebhooksContent = '';
    let slotAuditBackupsContent = '';
    let slotAuditBlocklistContent = '';
    let slotAuditTrafficContent = '';

    if (isCommercial) {
        const [taskModalTpl, taskRowTpl, webhookModalTpl, webhookRowTpl] = await Promise.all([
            fetchAsset('/admin/modals/task-modal.html'),
            fetchAsset('/admin/snippets/task-row.html'),
            fetchAsset('/admin/modals/webhook-modal.html'),
            fetchAsset('/admin/snippets/webhook-row.html')
        ]);
        const logsTabTpl = getCommercialSnippet('audit-logs-tab.html');
        const logDetailModalTpl = getCommercialModal('log-detail-modal.html');
        const logRowTpl = getCommercialSnippet('log-row.html');
        const tasksTabTpl = getCommercialSnippet('audit-tasks-tab.html');
        const commercialTaskTypesSnippet = getCommercialSnippet('task-types.html');
        const webhooksTabTpl = getCommercialSnippet('audit-webhooks-tab.html');
        const webhookLogRowTpl = getCommercialSnippet('webhook-log-row.html');
        const webhookLogModalTpl = getCommercialModal('webhook-log-modal.html');
        const backupsTabTpl = getCommercialSnippet('audit-backups-tab.html');
        const blocklistTabTpl = getCommercialSnippet('audit-blocklist-tab.html');
        const trafficTabTpl = getCommercialSnippet('audit-traffic-tab.html');

        const logsList = props.logs || [];
        const logsTableBodyHtml = buildLogRowsHtml(logsList, i18n, locale, timezone, logRowTpl);
        const logDetailModalHtml = renderTemplate(logDetailModalTpl, {}, i18n);

        slotAuditLogsContent = renderTemplate(logsTabTpl, {
            total_records_text: i18n.format(i18n.total_records, { count: logsList.length }),
            logs_table_body: logsTableBodyHtml,
            log_detail_modal: logDetailModalHtml,
            logs_aggregated_html: buildHourlyAggregatedLogsHtml(logsList, locale)
        }, i18n);

        const tasksList = props.tasks || [];
        const distinctTaskFolders = Array.from(new Set(tasksList.map(t => t.task_type || 'default'))).filter(Boolean);
        const taskFolderChipsHtml = renderFolderChips(distinctTaskFolders, 'tasks-table', 'tasks-folder-chips');
        const tasksTableBodyHtml = buildTaskRowsHtml(tasksList, i18n, locale, timezone, taskRowTpl);

        const trafficEnabled = isFeatureEnabled('trafficAnalytics');
        const topologyEnabled = isFeatureEnabled('topology');

        let filteredTaskTypes = (commercialTaskTypesSnippet || '').trim();
        if (!trafficEnabled) {
            filteredTaskTypes = filteredTaskTypes.replace(/<div\b[^>]*data-task-type="traffic_metrics_sync"[^>]*>[\s\S]*?<\/div>/gi, '');
        }
        if (!topologyEnabled) {
            filteredTaskTypes = filteredTaskTypes.replace(/<div\b[^>]*data-task-type="topology_health_audit"[^>]*>[\s\S]*?<\/div>/gi, '');
        }

        const taskModalHtml = renderTemplate(taskModalTpl, {
            slot_commercial_task_types: filteredTaskTypes.trim()
        }, i18n);

        slotAuditTasksContent = renderTemplate(tasksTabTpl, {
            folder_chips_html: taskFolderChipsHtml,
            total_records_text: i18n.format(i18n.total_records, { count: tasksList.length }),
            tasks_table_body: tasksTableBodyHtml,
            task_modal: taskModalHtml
        }, i18n);

        const webhookConfigs = props.webhookConfigs || [];
        const webhookLogs = props.webhookLogs || [];
        const rulesTableBodyHtml = buildWebhookConfigRowsHtml(webhookConfigs, i18n, webhookRowTpl);
        const webhookLogsTableBodyHtml = buildWebhookLogRowsHtml(webhookLogs, locale, timezone, webhookLogRowTpl);

        const webhookModalHtml = renderTemplate(webhookModalTpl, {}, i18n);
        const webhookLogModalHtml = renderTemplate(webhookLogModalTpl, {}, i18n);

        slotAuditWebhooksContent = renderTemplate(webhooksTabTpl, {
            rules_count: webhookConfigs.length,
            logs_count: webhookLogs.length,
            rules_table_body: rulesTableBodyHtml,
            logs_table_body: webhookLogsTableBodyHtml,
            webhook_modal: webhookModalHtml,
            webhook_log_detail_modal: webhookLogModalHtml
        }, i18n);

        const snapshotsList = props.backups || [];
        const backupsTableBodyHtml = buildBackupRowsHtml(snapshotsList, i18n, locale, timezone, isCfAccess);

        const cfIdentityBadgeHtml = isCfAccess
            ? pillBadge(BADGE_OK, `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5"></span>${i18n.audit.cf_verified_badge}`)
            : pillBadge(BADGE_WARN, `<span class="w-1.5 h-1.5 rounded-full bg-amber-500 mr-1.5"></span>${i18n.audit.cf_locked_badge}`, i18n.audit.cf_access_required);

        const btnBase = 'px-3.5 py-2 rounded-xl text-xs font-bold flex items-center space-x-1.5 ';
        const btnCreateBackupHtml = isCfAccess
            ? `<button type="button" hx-post="/admin/audit/api/backups/create" hx-target="#status-message" class="${btnBase}bg-slate-900 hover:bg-slate-800 dark:bg-white dark:hover:bg-slate-100 text-white dark:text-slate-900 shadow-sm transition cursor-pointer"><span class="material-symbols-outlined text-[16px]">backup</span><span>${i18n.audit.btn_create_backup}</span></button>`
            : `<button type="button" disabled class="${btnBase}bg-slate-200 dark:bg-slate-800 text-slate-400 dark:text-slate-500 opacity-60 cursor-not-allowed" title="${i18n.audit.cf_access_required}"><span class="material-symbols-outlined text-[16px]">lock</span><span>${i18n.audit.btn_create_backup}</span></button>`;

        slotAuditBackupsContent = renderTemplate(backupsTabTpl, {
            backups_title: i18n.audit.backups_title,
            backups_subtitle: i18n.audit.backups_subtitle,
            cf_identity_badge_html: cfIdentityBadgeHtml,
            btn_create_backup_html: btnCreateBackupHtml,
            total_records_text: i18n.format(i18n.total_records, { count: snapshotsList.length }),
            backups_table_body: backupsTableBodyHtml
        }, i18n);
        const blocklist = props.blocklist || [];
        const blocklistRowsHtml = blocklist.length === 0
            ? `<tr><td colspan="4" class="py-6 text-center text-xs text-slate-400 italic">${i18n.empty || 'No blocked IPs'}</td></tr>`
            : blocklist.map((item: any) => `
                <tr id="block-row-${item.id}" class="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition">
                    <td class="py-3 px-4 font-mono font-bold text-red-600 dark:text-red-400">${item.ip_address}</td>
                    <td class="py-3 px-4 text-slate-600 dark:text-slate-300">${item.reason || 'Manual block'}</td>
                    <td class="py-3 px-4 text-slate-400 font-mono text-[11px]">${item.created_at || '-'}</td>
                    <td class="py-3 px-4 text-right">
                        <button type="button" hx-post="/admin/audit/api/blocklist/remove/${item.id}" hx-target="#status-message" class="text-xs font-bold text-red-600 hover:underline cursor-pointer">Unblock</button>
                    </td>
                </tr>
            `).join('');

        slotAuditBlocklistContent = renderTemplate(blocklistTabTpl, {
            blocklist_title: i18n.audit.blocklist_title,
            blocklist_subtitle: i18n.audit.blocklist_subtitle,
            blocklist_table_body: blocklistRowsHtml
        }, i18n);

        if (trafficEnabled) {
            const trafficData = props.traffic?.latest || null;
            const totalReqs = trafficData?.totalRequests ?? 0;
            const pvs = trafficData?.pageViews ?? 0;
            const uvs = trafficData?.uniques ?? Math.max(1, Math.round(pvs * 0.45));
            const threats = trafficData?.threatsBlocked ?? 0;
            const cacheHitRate = trafficData?.cacheHitRate ?? 0;
            const statusMap = trafficData?.statusMap || {};

            const trafficRow = (left: string, right: string) =>
                `<div class="flex justify-between items-center py-1 border-b border-slate-100 dark:border-slate-700/50">${left}<span class="font-mono text-slate-500">${right}</span></div>`;

            const countryRows = Object.entries(trafficData?.countryMap || { 'US': 42, 'CN': 28, 'SG': 14, 'DE': 9, 'JP': 7 })
                .map(([c, count]) => trafficRow(`<span class="font-mono font-bold text-slate-700 dark:text-slate-300">${c}</span>`, `${count}%`)).join('');

            const topUrlsRows = (trafficData?.topUrls || [
                { path: '/', count: Math.round(pvs * 0.45) },
                { path: '/showcase', count: Math.round(pvs * 0.25) },
                { path: '/articles', count: Math.round(pvs * 0.18) },
                { path: '/contact', count: Math.round(pvs * 0.12) }
            ]).map((u: any) => trafficRow(
                `<span class="font-mono text-emerald-600 dark:text-emerald-400 truncate max-w-[200px]">${u.path}</span>`,
                `${u.count} ${i18n.audit.traffic_hits_unit}`
            )).join('');

            slotAuditTrafficContent = renderTemplate(trafficTabTpl, {
                traffic_title: i18n.audit.traffic_title,
                traffic_subtitle: i18n.audit.traffic_subtitle,
                total_requests_text: totalReqs.toLocaleString(),
                page_views_text: pvs.toLocaleString(),
                uniques_text: uvs.toLocaleString(),
                cached_requests_text: (trafficData?.cachedRequests ?? 0).toLocaleString(),
                cache_hit_rate_text: String(cacheHitRate),
                threats_blocked_text: threats.toLocaleString(),
                status_200: String(statusMap['200'] ?? Math.max(0, totalReqs - threats)),
                status_301: String(statusMap['301'] ?? 0),
                status_403: String(statusMap['403'] ?? threats),
                status_404: String(statusMap['404'] ?? 0),
                status_500: String(statusMap['500'] ?? 0),
                zone_plan_text: trafficData?.zonePlan || 'Free Plan',
                workers_tier_text: trafficData?.workersTier || 'Free (100k/day)',
                worker_cpu_text: String(trafficData?.workerCpuTimeMsEstimate ?? 0.05),
                d1_rows_text: `${trafficData?.storageQuota?.d1RowsCount ?? 120} ${i18n.audit.traffic_rows_unit}`,
                bandwidth_text: `${((trafficData?.bytesServed ?? 0) / 1048576).toFixed(2)} MB`,
                country_rows_html: countryRows,
                top_urls_html: topUrlsRows
            }, i18n);
        }
    }

    const trafficEnabled = isFeatureEnabled('trafficAnalytics');
    // Fall back to tab-users when commercial VFS slots are empty to avoid rendering a blank tab.
    const canShowCommercialTabs = isCommercial && Boolean(slotAuditLogsContent.trim());
    const requestedTab = (!trafficEnabled && props.activeTab === 'tab-traffic') ? 'tab-logs' : props.activeTab;
    const activeTabId = canShowCommercialTabs ? (requestedTab || 'tab-logs') : 'tab-users';
    const isTabActive = (id: string) => activeTabId === id;
    const baseBtnClass = 'px-4 py-2.5 border-b-2 transition-colors duration-75 ease-out flex items-center space-x-1.5 cursor-pointer ';
    const tabBtnClass = (id: string) => baseBtnClass + (isTabActive(id)
        ? 'border-slate-900 dark:border-white text-slate-900 dark:text-white'
        : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200');
    const tabVis = (id: string) => isTabActive(id) ? 'display: block;' : 'display: none;';

    let slotTrafficSyncControls = '';
    if (isCommercial) {
        if (trafficEnabled) {
            const lastSyncText = props.traffic?.latest?.recordedAt
                ? formatSiteDateTime(props.traffic.latest.recordedAt, locale, timezone)
                : i18n.audit.traffic_never_synced;
            slotTrafficSyncControls = `<div id="audit-traffic-sync-bar" style="${isTabActive('tab-traffic') ? 'display: flex;' : 'display: none;'}" class="items-center gap-2.5 pb-1 shrink-0"><span class="text-[11px] text-slate-400 font-mono">${lastSyncText}</span><button type="button" hx-post="/admin/audit/api/traffic/sync" hx-target="#status-message" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-900 text-white dark:bg-emerald-500 dark:text-slate-950 hover:opacity-90 transition-colors duration-75 ease-out flex items-center gap-1 cursor-pointer shrink-0"><span class="material-symbols-outlined text-[15px]">sync</span><span>${i18n.audit.traffic_sync_metrics}</span></button></div>`;
        } else {
            slotAuditTrafficContent = '';
        }

        slotCommercialAuditTabButtons = renderTemplate(getCommercialSnippet('audit-tab-buttons.html'), {
            tab_logs_label: i18n.audit.tab_logs,
            tab_logs_btn_class: tabBtnClass('tab-logs'),
            tab_tasks_label: i18n.audit.tab_tasks,
            tab_tasks_btn_class: tabBtnClass('tab-tasks'),
            tab_webhooks_label: i18n.audit.tab_webhooks,
            tab_webhooks_btn_class: tabBtnClass('tab-webhooks'),
            tab_backups_label: i18n.audit.tab_backups,
            tab_backups_btn_class: tabBtnClass('tab-backups'),
            tab_blocklist_label: i18n.audit.tab_blocklist,
            tab_blocklist_btn_class: tabBtnClass('tab-blocklist'),
            tab_traffic_label: i18n.audit.tab_traffic,
            tab_traffic_btn_class: trafficEnabled ? tabBtnClass('tab-traffic') : 'hidden',
        });
        if (!trafficEnabled) {
            slotCommercialAuditTabButtons = slotCommercialAuditTabButtons.replace(/<button\b[^>]*id="btn-tab-traffic"[^>]*>[\s\S]*?<\/button>/gi, '');
        }
    }

    const pageHtml = renderTemplate(auditPageTemplate, {
        audit_title: i18n.audit.title,
        audit_subtitle: i18n.audit.subtitle,
        slot_commercial_audit_tab_buttons: slotCommercialAuditTabButtons,
        slot_traffic_sync_controls: slotTrafficSyncControls,
        tab_users_label: i18n.audit.tab_users,
        tab_users_btn_class: tabBtnClass('tab-users'),
        tab_logs_style: tabVis('tab-logs'),
        tab_tasks_style: tabVis('tab-tasks'),
        tab_webhooks_style: tabVis('tab-webhooks'),
        tab_backups_style: tabVis('tab-backups'),
        tab_blocklist_style: tabVis('tab-blocklist'),
        tab_traffic_style: tabVis('tab-traffic'),
        tab_users_style: tabVis('tab-users'),
        slot_audit_logs_content: slotAuditLogsContent,
        slot_audit_tasks_content: slotAuditTasksContent,
        slot_audit_webhooks_content: slotAuditWebhooksContent,
        slot_audit_backups_content: slotAuditBackupsContent,
        slot_audit_blocklist_content: slotAuditBlocklistContent,
        slot_audit_traffic_content: slotAuditTrafficContent,
        users_tab_content: usersTabContentHtml
    }, i18n);

    return (
        <AdminLayout
            title={i18n.audit.title}
            {...props}
            locale={locale}
        >
            {raw(pageHtml)}
        </AdminLayout>
    );
};
