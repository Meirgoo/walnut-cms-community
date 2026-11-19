import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, formatSiteDateTime, getUserTimezone, DEFAULT_DEV_HOST } from '../../engine';
import { escapeHtmlAttr, formatTagsHtml, formatMaturityBadgeHtml, formatStatusBadgeInfo, renderEmptyTableRow, renderFolderChips } from '../routes/common';

export interface ArticleRow {
    id: string;
    slug: string;
    title: string;
    type: string;
    locale: string;
    translation_group_id?: string;
    translation_group_name?: string;
    status: string;
    progress?: string;
    maturity?: string;
    tags?: string[];
    folder?: string;
    updated_at: string;
}

export const ArtifactListPage = async (props: {
    nodes: ArticleRow[];
    sites: Site[];
    currentSiteId: string;
    currentDomain?: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    canUseFeature?: (feature?: string) => boolean;
    locale?: string;
    trashCount?: number;
}) => {
    const locale = props.locale || 'zh-CN';
    const domain = props.currentDomain || DEFAULT_DEV_HOST;
    const trashCount = props.trashCount || 0;
    const activeSite = props.sites.find(s => s.id === props.currentSiteId) || props.sites[0];
    const timezone = getUserTimezone(props.currentUser, activeSite);
    const i18n = getAdminI18nSlice(locale, ['articles', 'common']);

    const [
        artifactListTemplate,
        articleRowTemplate
    ] = await Promise.all([
        fetchAsset('/admin/pages/artifact-list.html'),
        fetchAsset('/admin/snippets/article-row.html')
    ]);

    const distinctFolders = Array.from(new Set(props.nodes.map(n => n.folder || '/'))).filter(Boolean);

    const transGroupsMap: Record<string, ArticleRow[]> = {};
    const standAloneNodes: ArticleRow[] = [];

    props.nodes.forEach(node => {
        if (node.translation_group_id) {
            if (!transGroupsMap[node.translation_group_id]) {
                transGroupsMap[node.translation_group_id] = [];
            }
            transGroupsMap[node.translation_group_id].push(node);
        } else {
            standAloneNodes.push(node);
        }
    });

    const groupedEntries: Array<{ isGroup: boolean; groupId?: string; groupName?: string; items: ArticleRow[] }> = [];

    Object.keys(transGroupsMap).forEach(gid => {
        const items = transGroupsMap[gid];
        const groupName = items[0].translation_group_name || gid;
        groupedEntries.push({ isGroup: true, groupId: gid, groupName, items });
    });

    standAloneNodes.forEach(node => {
        groupedEntries.push({ isGroup: false, items: [node] });
    });

    const trashBadgeHtml = trashCount > 0
        ? `<span class="bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400 px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold">${trashCount}</span>`
        : '';

    const folderChipsHtml = renderFolderChips(distinctFolders, 'articles-table', 'articles-folder-chips');

    const renderArticleRow = (item: ArticleRow, groupItems?: ArticleRow[]) => {
        const safeTitle = escapeHtmlAttr(item.title || '').replace(/'/g, "\\'");
        const displayTitle = escapeHtmlAttr(item.title || '');
        const safeSlug = escapeHtmlAttr(item.slug || '');
        const titleHtml = `<div class="flex items-center space-x-2 min-w-0"><a href="/admin/articles/edit/${item.id}" class="font-bold text-slate-900 dark:text-white hover:text-emerald-700 dark:hover:text-emerald-400 truncate">${displayTitle}</a><button type="button" onclick="window.openSandboxedPreview('/${safeSlug}', '${safeTitle}')" class="text-[11px] text-slate-400 hover:text-emerald-600 font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded truncate max-w-[180px] shrink-0 cursor-pointer">/${safeSlug}</button></div>`;

        const tagsHtml = formatTagsHtml(item.tags);
        const maturityHtml = formatMaturityBadgeHtml(item.progress || item.maturity, i18n);
        const { badgeClass: statusBadgeClass, badgeText: statusBadgeText } = formatStatusBadgeInfo(item.status, i18n);

        const transGroupBadgeHtml = item.translation_group_name
            ? `<span class="text-xs font-mono text-indigo-600 dark:text-indigo-400 max-w-[160px] truncate inline-block align-middle" title="${item.translation_group_name}">${item.translation_group_name}</span>`
            : `<span class="text-slate-300 dark:text-slate-600 text-xs">-</span>`;

        const variants = groupItems && groupItems.length > 1 ? groupItems : [item];
        const localeBadgesHtml = `<div class="inline-flex items-center gap-1 whitespace-nowrap justify-center">${variants.map(v => {
            const isCurrent = v.id === item.id;
            return `<a href="/admin/articles/edit/${v.id}" class="px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors duration-75 ${isCurrent ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-bold border border-emerald-500/30' : 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-300 border border-indigo-200/60 dark:border-indigo-800/50 hover:bg-indigo-100 dark:hover:bg-indigo-900'}" title="${v.title}">${v.locale}</a>`;
        }).join('')}</div>`;

        return renderTemplate(articleRowTemplate, {
            id: item.id,
            folder: item.folder || '/',
            title: item.title,
            title_html: titleHtml,
            trans_group_badge_html: transGroupBadgeHtml,
            slug: item.slug,
            locale_badges_html: localeBadgesHtml,
            tags_html: tagsHtml,
            maturity_html: maturityHtml,
            status_badge_class: statusBadgeClass,
            status_badge_text: statusBadgeText,
            updated_at: item.updated_at,
            updated_at_formatted: formatSiteDateTime(item.updated_at, locale, timezone),
            domain,
            preview: i18n.preview,
            edit: i18n.edit,
            confirm_delete: i18n.confirm_delete,
            delete: i18n.soft_delete
        });
    };

    const articlesTableBodyHtml = props.nodes.length === 0
        ? renderEmptyTableRow('11', i18n.empty)
        : groupedEntries.map(entry => {
            if (entry.isGroup && entry.items.length > 1) {
                const primaryItem = entry.items.find(it => it.locale === locale) || entry.items[0];
                return renderArticleRow(primaryItem, entry.items);
            }
            return renderArticleRow(entry.items[0]);
        }).join('');

    const porterTpl = await fetchAsset('/admin/snippets/article-batch-porter.html');
    const batchPorterButtonsHtml = porterTpl ? renderTemplate(porterTpl, {}, i18n) : '';

    const pageHtml = renderTemplate(artifactListTemplate, {
        slot_batch_porter_buttons: batchPorterButtonsHtml,
        trash_badge_html: trashBadgeHtml,
        folder_chips_html: folderChipsHtml,
        total_records_text: i18n.format(i18n.total_records, { count: props.nodes.length }),
        selected_count_zero: i18n.format(i18n.selected_count, { count: 0 }),
        articles_table_body: articlesTableBodyHtml,
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
