import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, formatSiteDateTime, getUserTimezone, parseJson } from '../../engine';
import { formatTagsHtml, formatMaturityBadgeHtml, formatStatusBadgeInfo, renderEmptyTableRow, renderFolderChips } from '../routes/common';

export interface MicroRow {
    id: string;
    slug?: string;
    type?: string;
    title: string;
    summary?: string;
    locale: string;
    progress?: string;
    maturity?: string;
    status: string;
    folder?: string;
    updated_at: string;
    metadata?: any;
}

export const MicroListPage = async (props: {
    micros: MicroRow[];
    sites: Site[];
    currentSiteId: string;
    currentDomain?: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    locale?: string;
    activeType?: string;
    trashCount?: number;
}) => {
    const locale = props.locale || 'zh-CN';
    const trashCount = props.trashCount || 0;
    const activeSite = props.sites.find(s => s.id === props.currentSiteId) || props.sites[0];
    const timezone = getUserTimezone(props.currentUser, activeSite);
    const i18n = getAdminI18nSlice(locale, ['micro', 'common']);

    const [
        microListTemplate,
        microRowTemplate
    ] = await Promise.all([
        fetchAsset('/admin/pages/micro-list.html'),
        fetchAsset('/admin/snippets/micro-row.html')
    ]);

    const distinctFolders = Array.from(new Set(props.micros.map(n => n.folder || '').filter(Boolean)));

    const trashBadgeHtml = trashCount > 0
        ? `<span class="bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400 px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold">${trashCount}</span>`
        : '';

    const folderChipsHtml = renderFolderChips(distinctFolders, 'micro-table', 'micro-folder-chips');

    const emptyText = i18n.empty;
    const microTableBodyHtml = props.micros.length === 0
        ? renderEmptyTableRow('9', emptyText)
        : props.micros.map(node => {
            const meta = parseJson<Record<string, any>>(node.metadata, {});
            const tags: string[] = Array.isArray(meta?.tags) ? meta.tags : [];

            const tagsHtml = formatTagsHtml(tags);
            const maturityHtml = formatMaturityBadgeHtml(node.progress || node.maturity, i18n);
            const { badgeClass: statusBadgeClass, badgeText: statusBadgeText } = formatStatusBadgeInfo(node.status, i18n);

            return renderTemplate(microRowTemplate, {
                id: node.id,
                folder: node.folder || '',
                folder_badge_html: node.folder
                    ? `<span class="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300"><span class="material-symbols-outlined text-[13px] text-amber-500">folder</span><span>${node.folder}</span></span>`
                    : `<span class="text-slate-400 font-mono text-[11px]">-</span>`,
                title: node.title,
                status_badge_class: statusBadgeClass,
                status_badge_text: statusBadgeText,
                maturity_html: maturityHtml,
                locale: node.locale || 'zh-CN',
                tags_html: tagsHtml,
                updated_at: node.updated_at,
                updated_at_formatted: formatSiteDateTime(node.updated_at, locale, timezone),
                btn_convert_to_article: i18n.btn_convert_to_article,
                edit: i18n.edit,
                confirm_delete: i18n.confirm_delete,
                delete: i18n.delete
            });
        }).join('');

    const pageHtml = renderTemplate(microListTemplate, {
        title: i18n.title,
        trash_badge_html: trashBadgeHtml,
        folder_chips_html: folderChipsHtml,
        total_records_text: i18n.format(i18n.total_records, { count: props.micros.length }),
        selected_count_zero: i18n.format(i18n.selected_count, { count: 0 }),
        entity_name: i18n.title,
        micro_table_body: microTableBodyHtml,
    }, i18n);

    return (
        <AdminLayout
            title={i18n.title}
            {...props}
            clientI18nSections={['micro', 'fast_memo', 'editor']}
            locale={locale}
        >
            {raw(pageHtml)}
        </AdminLayout>
    );
};
