import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import {
    renderTemplate,
    fetchAsset,
    getAdminI18nSlice,
    formatSiteDateTime,
    getUserTimezone,
    getCommercialSnippet,
    getCommercialModal,
    isFeatureEnabled
} from '../../engine';
import { renderFolderChips } from '../routes/common';
import {
    BADGE_OK,
    BADGE_WARN,
    pillBadge,
    buildHourlyAggregatedLogsHtml,
    buildUserRowsHtml,
    buildTaskRowsHtml,
    buildLogRowsHtml,
    buildWebhookConfigRowsHtml,
    buildWebhookLogRowsHtml,
    buildBackupRowsHtml,
    type AuditListPageProps
} from './audit-rows';

export {
    buildUserRowsHtml,
    buildTaskRowsHtml,
    buildLogRowsHtml,
    buildWebhookConfigRowsHtml,
    buildWebhookLogRowsHtml,
    buildBackupRowsHtml,
    type UserRow,
    type AuditLogRow,
    type WebhookConfigItem,
    type WebhookLogItem,
    type D1SnapshotListItem,
    type AuditListPageProps
} from './audit-rows';

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
    let slotAuditWorkersContent = '';

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
            ? pillBadge(BADGE_OK, `<span class="w-1.5 h-1.5 rounded-full bg-amber-500 mr-1.5"></span>${i18n.audit.cf_verified_badge}`)
            : pillBadge(BADGE_WARN, `<span class="w-1.5 h-1.5 rounded-full bg-amber-500 mr-1.5"></span>${i18n.audit.cf_locked_badge}`, i18n.audit.cf_access_required);

        const btnBase = 'h-8 px-3 rounded-lg text-[13px] font-semibold flex items-center space-x-1.5 ';
        const btnCreateBackupHtml = isCfAccess
            ? `<button type="button" hx-post="/admin/audit/api/backups/create" hx-target="#status-message" class="${btnBase}bg-[var(--admin-accent)] hover:bg-[var(--admin-accent-hover)] text-[var(--admin-accent-on)] shadow-sm transition cursor-pointer"><span class="material-symbols-outlined text-[16px]">backup</span><span>${i18n.audit.btn_create_backup}</span></button>`
            : `<button type="button" disabled class="${btnBase}bg-[var(--admin-chrome)] text-[var(--admin-text-muted)] border border-[var(--admin-border)] opacity-60 cursor-not-allowed" title="${i18n.audit.cf_access_required}"><span class="material-symbols-outlined text-[16px]">lock</span><span>${i18n.audit.btn_create_backup}</span></button>`;

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
            ? `<tr><td colspan="4" class="py-8 text-center text-xs text-[var(--admin-text-muted)]">${i18n.audit.empty_blocklist}</td></tr>`
            : blocklist.map((item: any) => `
                <tr id="block-row-${item.id}" class="hover:bg-stone-50/60 dark:hover:bg-stone-800/40 transition">
                    <td class="py-3 px-4 font-mono font-bold text-red-600 dark:text-red-400">${item.ip_address}</td>
                    <td class="py-3 px-4 text-stone-600 dark:text-stone-300">${item.reason || 'Manual block'}</td>
                    <td class="py-3 px-4 text-stone-400 font-mono text-[11px]">${item.created_at || '-'}</td>
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
                `<div class="flex justify-between items-center py-1 border-b border-stone-100 dark:border-stone-700/50">${left}<span class="font-mono text-stone-500">${right}</span></div>`;

            const countryRows = Object.entries(trafficData?.countryMap || { 'US': 42, 'CN': 28, 'SG': 14, 'DE': 9, 'JP': 7 })
                .map(([c, count]) => trafficRow(`<span class="font-mono font-bold text-stone-700 dark:text-stone-300">${c}</span>`, `${count}%`)).join('');

            const topUrlsRows = (trafficData?.topUrls || [
                { path: '/', count: Math.round(pvs * 0.45) },
                { path: '/showcase', count: Math.round(pvs * 0.25) },
                { path: '/articles', count: Math.round(pvs * 0.18) },
                { path: '/contact', count: Math.round(pvs * 0.12) }
            ]).map((u: any) => trafficRow(
                `<span class="font-mono text-amber-600 dark:text-amber-400 truncate max-w-[200px]">${u.path}</span>`,
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
    const baseBtnClass = 'px-4 py-2.5 border-b-2 transition-colors duration-75 ease-out flex items-center space-x-1.5 cursor-pointer whitespace-nowrap ';
    const tabBtnClass = (id: string) => baseBtnClass + (isTabActive(id)
        ? 'border-[var(--admin-accent)] text-[var(--admin-text)]'
        : 'border-transparent text-[var(--admin-text-muted)] hover:text-[var(--admin-text)]');
    const tabVis = (id: string) => isTabActive(id) ? 'display: block;' : 'display: none;';

    let slotTrafficSyncControls = '';
    if (isCommercial) {
        if (trafficEnabled) {
            const lastSyncText = props.traffic?.latest?.recordedAt
                ? formatSiteDateTime(props.traffic.latest.recordedAt, locale, timezone)
                : i18n.audit.traffic_never_synced;
            slotTrafficSyncControls = `<div id="audit-traffic-sync-bar" style="${isTabActive('tab-traffic') ? 'display: flex;' : 'display: none;'}" class="items-center gap-2.5 pb-1 shrink-0"><span class="text-[11px] text-[var(--admin-text-muted)] font-mono">${lastSyncText}</span><button type="button" hx-post="/admin/audit/api/traffic/sync" hx-target="#status-message" class="h-8 px-3 rounded-lg text-[13px] font-semibold bg-[var(--admin-accent)] hover:bg-[var(--admin-accent-hover)] text-[var(--admin-accent-on)] transition-colors duration-75 ease-out flex items-center gap-1 cursor-pointer shrink-0"><span class="material-symbols-outlined text-[15px]">sync</span><span>${i18n.audit.traffic_sync_metrics}</span></button></div>`;
        } else {
            slotAuditTrafficContent = '';
        }

        const workersEnabled = props.canUseFeature ? props.canUseFeature('cms:worker_bridge') : false;
        const workersTabTpl = workersEnabled ? getCommercialSnippet('audit-workers-tab.html') : null;
        if (workersTabTpl) {
            slotAuditWorkersContent = renderTemplate(workersTabTpl, {}, i18n);
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
            tab_workers_label: i18n.audit.tab_workers,
            tab_workers_btn_class: workersEnabled ? tabBtnClass('tab-workers') : 'hidden',
        });
        if (!trafficEnabled) {
            slotCommercialAuditTabButtons = slotCommercialAuditTabButtons.replace(/<button\b[^>]*id="btn-tab-traffic"[^>]*>[\s\S]*?<\/button>/gi, '');
        }
        if (!workersEnabled) {
            slotCommercialAuditTabButtons = slotCommercialAuditTabButtons.replace(/<button\b[^>]*id="btn-tab-workers"[^>]*>[\s\S]*?<\/button>/gi, '');
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
        tab_workers_style: tabVis('tab-workers'),
        tab_users_style: tabVis('tab-users'),
        slot_audit_logs_content: slotAuditLogsContent,
        slot_audit_tasks_content: slotAuditTasksContent,
        slot_audit_webhooks_content: slotAuditWebhooksContent,
        slot_audit_backups_content: slotAuditBackupsContent,
        slot_audit_blocklist_content: slotAuditBlocklistContent,
        slot_audit_traffic_content: slotAuditTrafficContent,
        slot_audit_workers_content: slotAuditWorkersContent,
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
