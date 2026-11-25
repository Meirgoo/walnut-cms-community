import type { Site, AuthenticatedUser, ScheduledTask } from '../../engine';
import {
    renderTemplate,
    formatSiteDateTime,
    t,
    escapeHtml
} from '../../engine';
import { renderEmptyTableRow } from '../routes/common';

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

export const BADGE_OK = 'bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800';
export const BADGE_ERR = 'bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800';
export const BADGE_WARN = 'bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800';
export const BADGE_MUTED = 'bg-stone-100 dark:bg-stone-800 text-stone-500 border border-stone-200 dark:border-stone-700';
export const pillBadge = (cls: string, text: string, title = '') =>
    `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${cls}"${title ? ` title="${title}"` : ''}>${text}</span>`;

export function buildHourlyAggregatedLogsHtml(logs: AuditLogRow[], locale: string): string {
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
                : 'bg-stone-100 dark:bg-stone-700 text-stone-700 dark:text-stone-300';
            return `<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold ${badgeClass}">${escapeHtml(act)} × ${cnt}</span>`;
        }).join(' ');

        return `<div class="p-4 bg-stone-50 dark:bg-stone-900/60 rounded-xl border border-stone-200/80 dark:border-stone-700/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:border-amber-500/50 transition"><div class="space-y-1"><div class="flex items-center space-x-2"><span class="font-mono font-bold text-xs text-stone-800 dark:text-stone-100">${safeHour}:00 ~ ${safeHour}:59</span><span class="text-xs font-bold text-amber-600 dark:text-amber-400 font-mono">${totalOpsPrefix}: ${grp.total}</span></div><div class="flex flex-wrap gap-1.5 pt-1">${actionBadges}</div></div><div class="flex items-center space-x-3 shrink-0"><div class="text-[11px] font-mono space-x-1.5"><span class="text-amber-600 dark:text-amber-400 font-bold">${successLabel}: ${grp.success}</span>${grp.failed > 0 ? `<span class="text-red-500 font-bold">${failedLabel}: ${grp.failed}</span>` : ''}</div><button type="button" onclick="window.viewHourLogsDetail ? window.viewHourLogsDetail('${safeHour}') : viewHourLogsDetail('${safeHour}')" class="px-2.5 py-1 rounded-lg text-xs font-bold bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-700 transition cursor-pointer">${expandLabel}</button></div></div>`;
    }).join('') || `<div class="p-8 text-center text-xs text-stone-400">${emptyAggregated}</div>`;
}

export function buildUserRowsHtml(
    users: UserRow[],
    i18n: any,
    locale: string,
    currentUser: any,
    userRowTemplate: string,
    timezone = '+08:00'
): string {
    if (users.length === 0) return renderEmptyTableRow('8', i18n.users?.empty || i18n.empty);
    return users.map(u => {
        const isSelf = currentUser && currentUser.id === u.id;
        const userJson = JSON.stringify(u);
        const folder = u.folder || u.global_role || 'member';

        const editBtn = `<button type="button" onclick='openEditUserModal(${userJson})' class="text-xs font-medium text-[var(--admin-text-muted)] hover:text-[var(--admin-text)] cursor-pointer transition">${i18n.edit}</button>`;
        const deleteBtn = !isSelf ? `<button type="button" hx-delete="/admin/users/api/delete/${u.id}" hx-target="#user-row-${u.id}" hx-swap="outerHTML" hx-confirm="${i18n.format(i18n.confirm_delete, { username: u.username })}" class="p-1 rounded-md list-action-trash cursor-pointer ml-1.5 inline-flex items-center justify-center align-middle" title="${i18n.delete}"><span class="material-symbols-outlined text-[16px]">delete</span></button>` : '';
        const currentUserBadgeHtml = isSelf ? `<span class="list-pill list-pill-locale-active">${i18n.current_user_badge}</span>` : '';
        const globalRoleBadgeClass = u.global_role === 'superadmin' ? 'list-pill list-pill-locale-active' : 'list-pill list-pill-draft';
        const siteRoleBadgeClass = u.site_role === 'admin' ? 'list-pill list-pill-locale' : 'list-pill list-pill-draft';

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

export function buildTaskRowsHtml(
    tasks: ScheduledTask[],
    i18n: any,
    locale: string,
    timezone: string,
    taskRowTemplate: string
): string {
    if (tasks.length === 0) return renderEmptyTableRow('7', i18n.tasks?.empty || i18n.empty);
    return tasks.map(task => {
        const taskJson = JSON.stringify(task).replace(/"/g, '&quot;');
        const folder = task.task_type || 'default';
        const statusClass = task.status === 'running' ? 'list-pill list-pill-scheduled' :
            ((task.status === 'pending' || task.status === 'completed') ? 'list-pill list-pill-published' : 'bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800');
        const safeLastResult = (task.last_result || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const lastResultHtml = safeLastResult
            ? `<div class="text-[11px] text-stone-500 dark:text-stone-400 mt-0.5 truncate max-w-xs" title="${safeLastResult.replace(/"/g, '&quot;')}">${safeLastResult}</div>`
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
    if (logs.length === 0) return renderEmptyTableRow('6', i18n.logs?.empty || i18n.empty);
    return logs.map(l => {
        const actionKey = 'logs.action_' + (l.action || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
        const locAct = t(locale, actionKey);
        const localizedAction = locAct !== actionKey ? locAct : l.action;
        const actionCodeHtml = localizedAction === l.action
            ? ''
            : `<span class="text-[9px] font-mono font-semibold bg-[var(--admin-chrome)] text-[var(--admin-text-muted)] px-1.5 py-0.5 rounded border border-[var(--admin-border)] whitespace-nowrap">${l.action}</span>`;
        const logJsonEscaped = escapeHtml(JSON.stringify(l));
        const statusBadgeClass = l.status === 'success' ? BADGE_OK : BADGE_ERR;

        const detailsShort = (l.details || '').replace(/[\r\n\t]+/g, ' ').trim();
        const detailsDisplay = detailsShort.length > 60 ? detailsShort.slice(0, 60) + '...' : (detailsShort || '-');
        const safeUsername = escapeHtml(l.username || i18n.anonymous_user);
        const safeUserId = l.user_id ? escapeHtml(l.user_id) : '';

        return renderTemplate(logRowTemplate, {
            id: escapeHtml(l.id),
            log_json: logJsonEscaped,
            view_detail: i18n.view_detail,
            action: escapeHtml(l.action),
            localized_action: escapeHtml(localizedAction),
            action_code_html: actionCodeHtml,
            username_sort: escapeHtml(l.username || l.user_id || 'System'),
            avatar_initial: escapeHtml((l.username || 'U').slice(0, 1).toUpperCase()),
            display_username: safeUsername,
            user_id_html: safeUserId ? `<div class="text-[10px] text-stone-400 font-mono">${safeUserId}</div>` : '',
            details: escapeHtml(l.details || ''),
            details_display: escapeHtml(detailsDisplay),
            status: escapeHtml(l.status),
            status_class: statusBadgeClass,
            status_text: l.status === 'success' ? i18n.status_success : i18n.status_failed,
            ip_address: escapeHtml(l.ip_address || '-'),
            created_at: escapeHtml(l.created_at),
            created_at_formatted: escapeHtml(formatSiteDateTime(l.created_at, locale, timezone))
        });
    }).join('');
}

export function buildWebhookConfigRowsHtml(
    configs: WebhookConfigItem[],
    i18n: any,
    webhookRowTemplate: string
): string {
    if (configs.length === 0) return `<tr><td colspan="7" class="px-5 py-8 text-center text-xs text-[var(--admin-text-muted)]">${i18n.webhooks?.empty || i18n.empty}</td></tr>`;
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
    if (logs.length === 0) return `<tr><td colspan="7" class="px-5 py-8 text-center text-xs text-stone-400"></td></tr>`;
    return logs.map(l => {
        const logJson = escapeHtml(JSON.stringify(l));
        const statusBadgeClass = l.status_code >= 200 && l.status_code < 300 ? BADGE_OK : BADGE_ERR;

        return renderTemplate(webhookLogRowTemplate, {
            id: escapeHtml(l.id),
            form_id: escapeHtml(l.form_id),
            platform: escapeHtml(l.platform),
            status_code: l.status_code,
            status_badge_class: statusBadgeClass,
            client_ip: escapeHtml(l.client_ip || '-'),
            target_url: escapeHtml(l.target_url),
            created_at_formatted: escapeHtml(formatSiteDateTime(l.created_at, locale, timezone)),
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
            ? `<a href="/admin/audit/api/backups/download?key=${encodeURIComponent(s.key)}" class="inline-flex items-center space-x-1 text-xs font-bold text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 transition cursor-pointer"><span class="material-symbols-outlined text-[15px]">download</span><span>${i18n.audit.download_backup}</span></a>`
            : `<span class="inline-flex items-center space-x-1 text-xs font-medium text-stone-400 dark:text-stone-500 cursor-not-allowed" title="${i18n.audit.cf_access_required}"><span class="material-symbols-outlined text-[15px]">lock</span><span>${i18n.audit.read_only_locked}</span></span>`;

        const td = (cls: string, content: string, title = '') =>
            `<td class="px-5 py-3.5 text-xs ${cls}"${title ? ` title="${title}"` : ''}>${content}</td>`;
        const monoCell = 'text-stone-600 dark:text-stone-300 font-mono';
        const mutedCell = 'text-stone-500 dark:text-stone-400';

        return `<tr>${td('font-mono text-stone-700 dark:text-stone-200', `<div class="flex items-center space-x-1.5"><span class="material-symbols-outlined text-[16px] text-stone-400">database</span><span class="truncate max-w-xs font-bold">${filename}</span></div><div class="text-[10px] text-stone-400 font-mono mt-0.5 truncate">${s.key}</div>`, s.key)}${td(monoCell, siteLabel)}${td(monoCell, rowsCount)}${td(`${mutedCell} font-mono`, sizeKb)}${td(mutedCell, formattedDate)}${td('text-right font-mono', actionHtml)}</tr>`;
    }).join('');
}
