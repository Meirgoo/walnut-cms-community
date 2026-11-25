import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, formatRelativeOrShortTime, getUserTimezone, parseJson } from '../../engine';
import { formatTagsHtml, formatProgressBadgeHtml, formatStatusBadgeInfo, renderEmptyTableRow, renderFolderChips, renderTrashBadgeHtml } from '../routes/common';

export interface MicroRow {
    id: string;
    slug?: string;
    type?: string;
    title: string;
    summary?: string;
    content_raw?: string;
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

    const trashBadgeHtml = renderTrashBadgeHtml(trashCount);

    const folderChipsHtml = renderFolderChips(distinctFolders, 'micro-table', 'micro-folder-chips');

    const emptyText = i18n.empty;
    const microTableBodyHtml = props.micros.length === 0
        ? renderEmptyTableRow('9', emptyText)
        : props.micros.map(node => {
            const meta = parseJson<Record<string, any>>(node.metadata, {});
            const tags: string[] = Array.isArray(meta?.tags) ? meta.tags : [];

            const tagsHtml = formatTagsHtml(tags);
            const maturityHtml = formatProgressBadgeHtml(node.progress || node.maturity, i18n);
            const { badgeClass: statusBadgeClass, badgeText: statusBadgeText } = formatStatusBadgeInfo(node.status, i18n);
            const ts = formatRelativeOrShortTime(node.updated_at, locale, timezone);

            const rawBody = String(node.content_raw || node.summary || '');
            const cleanExcerpt = rawBody
                .replace(/```[\s\S]*?```/g, ' ')
                .replace(/`([^`]*)`/g, '$1')
                .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
                .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
                .replace(/[#>*_~\-]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            const fallbackExcerpt = cleanExcerpt.length > 72 ? cleanExcerpt.slice(0, 72) + '…' : cleanExcerpt;
            const displayTitle = (node.title || '').trim() || fallbackExcerpt || node.slug || node.id;

            return renderTemplate(microRowTemplate, {
                id: node.id,
                folder: node.folder || '',
                folder_badge_html: node.folder
                    ? `<span class="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-medium bg-[var(--admin-chrome)] text-[var(--admin-text-muted)]"><span class="material-symbols-outlined text-[13px] opacity-75">folder</span><span>${node.folder}</span></span>`
                    : `<span class="text-[var(--admin-text-muted)] font-mono text-[11px]">-</span>`,
                title: displayTitle,
                status_badge_class: statusBadgeClass,
                status_badge_text: statusBadgeText,
                maturity_html: maturityHtml,
                locale: node.locale || 'zh-CN',
                tags_html: tagsHtml,
                updated_at: node.updated_at,
                updated_at_formatted: ts.short,
                updated_at_full: ts.full,
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
