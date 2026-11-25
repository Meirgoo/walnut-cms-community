import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser, DashboardActionItem, BrokenComponentsDiagnostic } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, t, escapeHtmlAttr } from '../../engine';

export interface DashboardStats {
    totalNodes: number;
    publishedCount: number;
    draftCount: number;
    mediaCount: number;
    microCount?: number;
    microFolderCount?: number;
    pageCount?: number;
    dirtyRouteCount?: number;
    datasetGroupCount?: number;
    routeCount?: number;
    currentSiteName: string;
}

export interface RecentFeedItem {
    id: string;
    itemType: 'article' | 'page' | 'micro' | 'automated_task' | 'audit_log';
    category?: 'content' | 'system';
    title: string;
    slug?: string;
    nodeType?: string;
    action?: string;
    status: string;
    versionNumber?: number;
    time: string;
    timeShort?: string;
    isAutomated?: boolean;
}

function resolveAlertActionHtml(item: DashboardActionItem, locale: string): string {
    const label = item.actionLabelKey ? t(locale, item.actionLabelKey) : '';
    if (item.actionType === 'rebuild_dirty_routes') {
        return `<button type="button" onclick="window.rebuildDirtyRoutes && window.rebuildDirtyRoutes(this)" class="h-7 px-2.5 rounded-md bg-[var(--admin-accent)] hover:bg-[var(--admin-accent-hover)] text-[var(--admin-accent-on)] text-[11px] font-semibold shrink-0 cursor-pointer transition-colors">${label}</button>`;
    }
    if (item.actionType === 'link' && item.actionHref) {
        return `<a href="${item.actionHref}" class="h-7 px-2.5 rounded-md bg-[var(--admin-surface)] hover:bg-[var(--admin-surface-hover)] border border-[var(--admin-border)] text-[var(--admin-text)] text-[11px] font-semibold inline-flex items-center shrink-0 transition-colors">${label}</a>`;
    }
    return '';
}

export const DashboardPage = async (props: {
    stats: DashboardStats;
    recentFeed: RecentFeedItem[];
    recentContent?: RecentFeedItem[];
    recentSystem?: RecentFeedItem[];
    actionAlerts?: DashboardActionItem[];
    brokenDiagnostic?: BrokenComponentsDiagnostic;
    hasR2Bucket?: boolean;
    sites: Site[];
    currentSiteId: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    canUseFeature?: (feature?: string) => boolean;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const i18n = getAdminI18nSlice(locale, ['dashboard', 'common']);

    const dashboardTemplate = await fetchAsset('/admin/pages/dashboard.html');
    const feedItemTemplate = await fetchAsset('/admin/snippets/dashboard-feed-item.html');
    const taskItemTemplate = await fetchAsset('/admin/snippets/dashboard-task-item.html');

    const timelineSource = (props.recentFeed && props.recentFeed.length > 0)
        ? props.recentFeed
        : (props.recentContent || []);

    const timelineRowsHtml = timelineSource.slice(0, 10).map((item) => {
        const isSystem = item.category === 'system' || item.itemType === 'automated_task' || item.itemType === 'audit_log';
        const isPage = item.itemType === 'page';
        const isMicro = item.itemType === 'micro';
        const isTask = item.itemType === 'automated_task';

        const semanticKey = isSystem ? 'system' : (isPage ? 'page' : (isMicro ? 'micro' : 'article'));
        const badgeClass = `tl-pill-${semanticKey}`;
        const nodeDotClass = `tl-node-${semanticKey}`;

        const typeIcon = isSystem
            ? (isTask ? 'schedule' : 'policy')
            : (isPage ? 'web' : (isMicro ? 'lightbulb' : 'edit_note'));

        const typeLabel = isSystem
            ? (isTask ? i18n.activity_automated_tag : i18n.tag_audit)
            : (isPage ? i18n.tag_page : (isMicro ? i18n.tag_micro : i18n.activity_article_tag));

        const targetUrl = isSystem
            ? (isTask ? '/admin/tasks' : '/admin/audit?tab=logs')
            : (isPage ? `/admin/pages/edit/${item.id}` : (isMicro ? '/admin/micros' : `/admin/articles/edit/${item.id}`));

        // Avoid double-slash "//" when homepage slug is stored as "/".
        const rawSlug = String(item.slug || '').trim();
        const slugDisplay = rawSlug ? (rawSlug.startsWith('/') ? rawSlug : `/${rawSlug}`) : '';

        return renderTemplate(feedItemTemplate, {
            item_category: isSystem ? 'system' : 'content',
            item_module: item.itemType || 'article',
            node_dot_class: nodeDotClass,
            badge_class: badgeClass,
            type_icon: typeIcon,
            type_label: typeLabel,
            target_url: targetUrl,
            title: item.title,
            slug_display: slugDisplay,
            time_short: item.timeShort || item.time,
            time_full: item.time,
            action_tip: isSystem ? i18n.view_all : i18n.edit
        }, i18n);
    }).join('');

    const timelineItemsHtml = timelineSource.length === 0
        ? `<div class="py-8 text-center text-xs text-[var(--admin-text-muted)]">${i18n.no_timeline_records}</div>`
        : `<div class="relative before:content-[''] before:absolute before:left-[3px] before:top-2 before:bottom-2 before:w-px before:bg-[var(--admin-border)]">${timelineRowsHtml}</div>`;

    const allAlerts = props.actionAlerts || [];
    const tierConfigs: Array<{
        tier: 'critical' | 'warning' | 'scheduled';
        label: string;
        headerClass: string;
        dotClass: string;
        boxClass: string;
        iconClass: string;
    }> = [
        {
            tier: 'critical',
            label: i18n.tier_critical,
            headerClass: 'text-red-600 dark:text-red-400',
            dotClass: 'bg-red-500',
            boxClass: 'bg-red-50/70 dark:bg-red-950/30 border-red-200 dark:border-red-900/50',
            iconClass: 'text-red-600 dark:text-red-400'
        },
        {
            tier: 'warning',
            label: i18n.tier_warning,
            headerClass: 'text-[var(--admin-accent-text)]',
            dotClass: 'bg-[var(--admin-accent)]',
            boxClass: 'bg-[var(--admin-accent-soft)] border-[var(--admin-accent-border)]',
            iconClass: 'text-[var(--admin-accent-text)]'
        },
        {
            tier: 'scheduled',
            label: i18n.tier_scheduled,
            headerClass: 'text-[var(--admin-text-muted)]',
            dotClass: 'bg-[var(--admin-text-muted)]',
            boxClass: 'bg-[var(--admin-chrome)] border-[var(--admin-border)]',
            iconClass: 'text-[var(--admin-text-muted)]'
        }
    ];

    const tierBlocksHtml = tierConfigs.map((cfg) => {
        const items = allAlerts.filter((a) => a.tier === cfg.tier);
        if (items.length === 0) return '';
        const rows = items.map((item) => {
            const translatedTitle = t(locale, item.titleKey, item.titleParams);
            const displayTitle = translatedTitle === item.titleKey && item.rawTitle ? item.rawTitle : translatedTitle;
            return renderTemplate(taskItemTemplate, {
                item_box_class: cfg.boxClass,
                icon_class: cfg.iconClass,
                icon: item.icon,
                title: displayTitle,
                meta_class: item.meta ? '' : 'hidden',
                meta: item.meta || '',
                action_html: resolveAlertActionHtml(item, locale)
            }, i18n);
        }).join('');
        return `<div class="space-y-2"><div class="flex items-center justify-between"><span class="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider ${cfg.headerClass}"><span class="w-1.5 h-1.5 rounded-full ${cfg.dotClass}"></span>${cfg.label}</span><span class="text-[11px] font-mono text-[var(--admin-text-muted)]">${items.length}</span></div><div class="space-y-2">${rows}</div></div>`;
    }).filter(Boolean).join('');

    const actionAlertsHtml = tierBlocksHtml || `
        <div class="flex items-center gap-2.5 px-3.5 py-3 rounded-lg bg-[var(--admin-chrome)] border border-[var(--admin-border)] text-xs text-[var(--admin-text-muted)]">
            <span class="material-symbols-outlined text-[16px] text-[var(--admin-accent-text)] shrink-0">check_circle</span>
            <span class="font-medium text-[var(--admin-text)]">${i18n.system_healthy_tip}</span>
        </div>
    `;

    const dirtyCount = props.stats.dirtyRouteCount || 0;
    const r2Ready = props.hasR2Bucket !== false;
    const brokenDiag = props.brokenDiagnostic;
    const brokenComponentsAlertHtml = (brokenDiag && brokenDiag.broken_pages_count > 0)
        ? `<div id="dashboard-broken-components-alert" class="mb-6 rounded-xl border border-red-300 dark:border-red-900/70 bg-red-50/70 dark:bg-red-950/30 p-4 space-y-3">
            <div class="flex items-start justify-between gap-3">
                <div class="flex items-start gap-2.5 min-w-0">
                    <span class="material-symbols-outlined text-[20px] text-red-600 dark:text-red-400 shrink-0 mt-0.5">warning</span>
                    <div class="min-w-0">
                        <h2 class="text-sm font-bold text-red-800 dark:text-red-200">${escapeHtmlAttr(t(locale, 'dashboard.broken_comp_alert_title', { pages: brokenDiag.broken_pages_count, blocks: brokenDiag.broken_blocks_count }))}</h2>
                        <p class="text-xs text-red-700/90 dark:text-red-300/90 mt-0.5">${escapeHtmlAttr(t(locale, 'dashboard.broken_comp_alert_desc'))}</p>
                    </div>
                </div>
            </div>
            <div class="space-y-2">
                ${brokenDiag.items.map((item) => {
                    const tplBadge = item.page_type === 'template'
                        ? `<span class="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/60 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700 text-[10px] font-bold shrink-0">${escapeHtmlAttr(t(locale, 'dashboard.badge_template_master'))}</span>`
                        : '';
                    const slugText = item.slug.startsWith('/') ? item.slug : `/${item.slug}`;
                    const pills = item.missing_components.map((c) => `<code class="px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/60 text-red-700 dark:text-red-300 font-mono text-[11px]">${escapeHtmlAttr(c)}</code>`).join(' ');
                    return `<div class="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--admin-surface)] border border-red-200/80 dark:border-red-900/60 px-3 py-2">
                        <div class="flex flex-wrap items-center gap-2 min-w-0">
                            ${tplBadge}
                            <span class="text-xs font-bold text-[var(--admin-text)] truncate">${escapeHtmlAttr(item.title)}</span>
                            <span class="text-[11px] font-mono text-[var(--admin-text-muted)]">${escapeHtmlAttr(slugText)}</span>
                            <div class="flex flex-wrap items-center gap-1">${pills}</div>
                        </div>
                        <a href="/admin/pages/edit/${escapeHtmlAttr(item.id)}" class="h-7 px-2.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-[11px] font-semibold inline-flex items-center shrink-0 transition-colors">${escapeHtmlAttr(t(locale, 'dashboard.btn_fix_in_editor'))} &rarr;</a>
                    </div>`;
                }).join('')}
            </div>
        </div>`
        : '';

    const pageHtml = renderTemplate(dashboardTemplate, {
        broken_components_alert_html: brokenComponentsAlertHtml,
        current_site_name: props.stats.currentSiteName,
        total_nodes: props.stats.totalNodes,
        published_count: props.stats.publishedCount,
        draft_count: props.stats.draftCount,
        media_count: props.stats.mediaCount,
        micro_count: props.stats.microCount ?? 0,
        micro_folder_count: props.stats.microFolderCount ?? 0,
        page_count: props.stats.pageCount ?? 0,
        dirty_route_count: dirtyCount,
        dirty_route_dot_class: dirtyCount > 0 ? 'bg-[var(--admin-accent)]' : 'bg-[var(--admin-text-muted)]',
        r2_status_text: r2Ready ? i18n.stat_r2_ready : i18n.stat_r2_unready,
        dataset_group_count: props.stats.datasetGroupCount ?? 0,
        route_count: props.stats.routeCount ?? 0,
        timeline_items_html: timelineItemsHtml,
        action_alerts_html: actionAlertsHtml
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
