import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, getCommercialSnippet } from '../../engine';

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
    title: string;
    slug?: string;
    nodeType?: string;
    action?: string;
    status: string;
    versionNumber?: number;
    time: string;
    isAutomated?: boolean;
}

export const DashboardPage = async (props: {
    stats: DashboardStats;
    recentFeed: RecentFeedItem[];
    recentContent?: RecentFeedItem[];
    recentSystem?: RecentFeedItem[];
    sites: Site[];
    currentSiteId: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    canUseFeature?: (feature?: string) => boolean;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const isCommercial = props.canUseFeature ? props.canUseFeature('cms:*') : false;
    const i18n = getAdminI18nSlice(locale, ['dashboard', 'common']);

    const dashboardTemplate = await fetchAsset('/admin/pages/dashboard.html');
    const feedItemTemplate = await fetchAsset('/admin/snippets/dashboard-feed-item.html');
    const taskItemTemplate = await fetchAsset('/admin/snippets/dashboard-task-item.html');
    const emptyPlaceholderTpl = await fetchAsset('/admin/snippets/empty-placeholder.html');

    const contentList = props.recentContent || props.recentFeed.filter(i => i.itemType !== 'automated_task' && i.itemType !== 'audit_log');
    const systemList = props.recentSystem || props.recentFeed.filter(i => i.itemType === 'automated_task' || i.itemType === 'audit_log');

    const recentContentItemsHtml = contentList.length === 0
        ? renderTemplate(emptyPlaceholderTpl, { message: i18n.no_records })
        : contentList.map(item => {
            const isPub = item.status === 'published';
            const statusClass = isPub
                ? 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300';
            const statusText = isPub ? i18n.status_published : i18n.status_draft;

            const isPage = item.itemType === 'page';
            const isMicro = item.itemType === 'micro';
            const typeBadgeClass = isPage
                ? 'bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800'
                : (isMicro
                    ? 'bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800'
                    : 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800');
            const typeIcon = isPage ? 'web' : (isMicro ? 'lightbulb' : 'edit_note');
            const typeLabel = isPage ? i18n.tag_page : (isMicro ? i18n.tag_micro : i18n.activity_article_tag);
            const editUrl = isPage ? `/admin/pages/edit/${item.id}` : (isMicro ? '/admin/micros' : `/admin/articles/edit/${item.id}`);
            const slugDisplay = item.slug ? `/${item.slug}` : '';

            return renderTemplate(feedItemTemplate, {
                id: item.id,
                title: item.title,
                slug_display: slugDisplay,
                edit_url: editUrl,
                type_badge_class: typeBadgeClass,
                type_icon: typeIcon,
                type_label: typeLabel,
                time: item.time,
                status_class: statusClass,
                status_text: statusText,
                item_module: item.itemType || 'article',
                edit: i18n.edit
            }, i18n);
        }).join('');

    const recentSystemItemsHtml = systemList.length === 0
        ? renderTemplate(emptyPlaceholderTpl, { message: i18n.no_records })
        : systemList.map(item => {
            const isTask = item.itemType === 'automated_task';
            const badgeClass = isTask
                ? 'bg-purple-50 dark:bg-purple-950 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800'
                : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-600';
            const badgeIcon = isTask ? 'schedule' : 'policy';
            const badgeLabel = isTask ? i18n.activity_automated_tag : i18n.tag_audit;
            const statusClass = item.status === 'success' || item.status === 'active'
                ? 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300'
                : 'bg-purple-100 dark:bg-purple-950 text-purple-800 dark:text-purple-300';

            return renderTemplate(taskItemTemplate, {
                item_module: item.itemType,
                badge_class: badgeClass,
                badge_icon: badgeIcon,
                badge_label: badgeLabel,
                title: item.title,
                status_class: statusClass,
                status_text: item.status || i18n.status_executed,
                time: item.time
            }, i18n);
        }).join('');

    let commercialFeedControlsHtml = '';
    if (isCommercial) {
        const controlsTpl = getCommercialSnippet('dashboard-feed-controls.html');
        if (controlsTpl) {
            commercialFeedControlsHtml = renderTemplate(controlsTpl, {}, i18n);
        }
    }

    const dirtyCount = props.stats.dirtyRouteCount || 0;
    const pageHtml = renderTemplate(dashboardTemplate, {
        current_site_name: props.stats.currentSiteName,
        total_nodes: props.stats.totalNodes,
        published_count: props.stats.publishedCount,
        draft_count: props.stats.draftCount,
        media_count: props.stats.mediaCount,
        micro_count: props.stats.microCount ?? 0,
        micro_folder_count: props.stats.microFolderCount ?? 0,
        page_count: props.stats.pageCount ?? 0,
        dirty_route_count: dirtyCount,
        dirty_route_dot_class: dirtyCount > 0 ? 'bg-amber-400' : 'bg-emerald-500',
        dataset_group_count: props.stats.datasetGroupCount ?? 0,
        route_count: props.stats.routeCount ?? 0,
        recent_content_items: recentContentItemsHtml,
        recent_system_items: recentSystemItemsHtml,
        slot_commercial_dashboard_feed_controls: commercialFeedControlsHtml
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
