import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, formatSiteDateTime, getUserTimezone, t } from '../../engine';

export interface TrashVersionItem {
    versionId: string;
    versionNumber: number;
    commitMessage?: string;
    contentRaw?: string;
    deletedAt?: string;
    createdAt: string;
}

export interface TrashArticleGroup {
    nodeId: string;
    title: string;
    slug: string;
    type: string;
    isNodeDeleted: boolean;
    deletedAt: string;
    versions: TrashVersionItem[];
}

export const TrashListPage = async (props: {
    groups: TrashArticleGroup[];
    sites: Site[];
    currentSiteId: string;
    currentDomain: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    locale?: string;
    activeTab?: 'article' | 'page' | 'micro' | 'dataset';
    articleCount?: number;
    pageCount?: number;
    microCount?: number;
    datasetCount?: number;
}) => {
    const locale = props.locale || 'zh-CN';
    const activeSite = props.sites.find(s => s.id === props.currentSiteId) || props.sites[0];
    const timezone = getUserTimezone(props.currentUser, activeSite);
    const i18n = getAdminI18nSlice(locale, ['trash', 'common']);

    const trashListTemplate = await fetchAsset('/admin/pages/trash-list.html');
    const snapshotPreviewModalTemplate = await fetchAsset('/admin/modals/snapshot-preview-modal.html');
    const trashGroupCardTemplate = await fetchAsset('/admin/snippets/trash-group-card.html');
    const trashVersionItemTemplate = await fetchAsset('/admin/snippets/trash-version-item.html');
    const emptyPlaceholderTemplate = await fetchAsset('/admin/snippets/empty-placeholder.html');
    const activeTab = props.activeTab || 'article';

    const filteredGroups = props.groups.filter(g => g.type === activeTab);

    const articleCount = props.articleCount ?? props.groups.filter(g => g.type === 'article').length;
    const pageCount = props.pageCount ?? props.groups.filter(g => g.type === 'page').length;
    const microCount = props.microCount ?? props.groups.filter(g => g.type === 'micro').length;
    const datasetCount = props.datasetCount ?? props.groups.filter(g => g.type === 'dataset').length;
    const backHrefMap: Record<string, string> = {
        article: '/admin/articles',
        page: '/admin/pages',
        micro: '/admin/micros',
        dataset: '/admin/datasets'
    };
    const activeTabCls = 'border-amber-600 text-amber-700 dark:text-amber-400';
    const inactiveTabCls = 'border-transparent text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200';

    const trashGroupsContentHtml = filteredGroups.length === 0
        ? renderTemplate(emptyPlaceholderTemplate, { message: i18n.empty })
        : filteredGroups.map(group => {
            const versionsHtml = group.versions.length === 0
                ? `<div class="p-4 text-center text-xs text-stone-400">${i18n.full_article_archived}</div>`
                : group.versions.map(ver => renderTemplate(trashVersionItemTemplate, {
                    version_id: ver.versionId,
                    node_id: group.nodeId,
                    version_number: ver.versionNumber,
                    commit_message: ver.commitMessage || i18n.version_snapshot_default,
                    created_at_prefix: i18n.created_at_prefix,
                    created_at_formatted: formatSiteDateTime(ver.createdAt, locale, timezone),
                    deleted_at_info: ver.deletedAt ? `${i18n.deleted_at_prefix}${formatSiteDateTime(ver.deletedAt, locale, timezone)}` : '',
                    safe_title: group.title.replace(/'/g, "\\'"),
                    content_raw_json: JSON.stringify(ver.contentRaw || ''),
                    btn_preview_snapshot: i18n.btn_preview_snapshot,
                    confirm_restore: i18n.confirm_restore,
                    btn_restore_version: i18n.btn_restore_version,
                    confirm_hard_delete: i18n.confirm_hard_delete,
                    btn_hard_delete: i18n.btn_hard_delete
                })).join('');

            return renderTemplate(trashGroupCardTemplate, {
                node_id: group.nodeId,
                title: group.title,
                slug: group.slug,
                type: group.type,
                snapshots_count_text: i18n.format(i18n.snapshots_count, { count: group.versions.length }),
                deleted_time_prefix: i18n.deleted_time_prefix,
                deleted_at_formatted: formatSiteDateTime(group.deletedAt, locale, timezone),
                confirm_restore: i18n.confirm_restore,
                btn_restore: i18n.btn_restore,
                confirm_hard_delete: i18n.confirm_hard_delete,
                btn_hard_delete: i18n.btn_hard_delete,
                versions_html: versionsHtml
            });
        }).join('');

    const snapshotPreviewModalHtml = renderTemplate(snapshotPreviewModalTemplate, {}, i18n);

    const pageHtml = renderTemplate(trashListTemplate, {
        back_href: backHrefMap[activeTab] || '/admin/articles',
        active_tab: activeTab,
        empty_trash_button_class: filteredGroups.length > 0 ? '' : 'hidden',
        tab_article_class: activeTab === 'article' ? activeTabCls : inactiveTabCls,
        tab_page_class: activeTab === 'page' ? activeTabCls : inactiveTabCls,
        tab_micro_class: activeTab === 'micro' ? activeTabCls : inactiveTabCls,
        tab_dataset_class: activeTab === 'dataset' ? activeTabCls : inactiveTabCls,
        tab_pages: i18n.tab_pages || t(locale, 'trash.tab_pages'),
        tab_micro: i18n.tab_micro || t(locale, 'trash.title_micro'),
        tab_datasets: i18n.tab_datasets || t(locale, 'trash.tab_datasets'),
        article_count: articleCount,
        page_count: pageCount,
        micro_count: microCount,
        dataset_count: datasetCount,
        total_records_text: t(locale, 'common.total_records', { count: filteredGroups.length }),
        selected_count_zero: t(locale, 'common.selected_count', { count: 0 }),
        trash_groups_content: trashGroupsContentHtml,
        snapshot_preview_modal: snapshotPreviewModalHtml
    }, i18n);

    return (
        <AdminLayout
            title={i18n.title}
            {...props}
            clientI18nSections={['trash', 'editor', 'micro']}
            locale={locale}
        >
            {raw(pageHtml)}
        </AdminLayout>
    );
};
