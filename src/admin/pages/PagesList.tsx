import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, formatSiteDateTime, getUserTimezone, DEFAULT_DEV_HOST, t, getCommercialSnippet, isFeatureEnabled } from '../../engine';
import { renderEmptyTableRow, renderFolderChips } from '../routes/common';

export interface PageRow {
    id: string;
    slug: string;
    route_path?: string;
    title: string;
    page_type?: string;
    template_name?: string;
    template_title?: string;
    locale: string;
    status: string;
    folder?: string;
    translation_group_id?: string;
    updated_at: string;
}

export const PagesListPage = async (props: {
    pages: PageRow[];
    templates?: any[];
    sites: Site[];
    currentSiteId: string;
    currentDomain?: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    canUseFeature?: (feature?: string) => boolean;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const isCommercial = props.canUseFeature ? props.canUseFeature('cms:*') : false;
    const domain = props.currentDomain || DEFAULT_DEV_HOST;
    const activeSite = props.sites.find(s => s.id === props.currentSiteId) || props.sites[0];
    const timezone = getUserTimezone(props.currentUser, activeSite);
    const i18n = getAdminI18nSlice(locale, ['pages', 'common']);

    const [
        pagesListTemplate,
        pageRowTemplate
    ] = await Promise.all([
        fetchAsset('/admin/pages/pages-list.html'),
        fetchAsset('/admin/snippets/page-row.html')
    ]);

    const distinctFolders = Array.from(new Set(props.pages.map(p => p.folder || '/'))).filter(Boolean);

    const folderChipsHtml = renderFolderChips(distinctFolders, 'pages-table', 'pages-folder-chips');

    const tgPeersMap = new Map<string, PageRow[]>();
    for (const p of props.pages) {
        if (p.translation_group_id) {
            const arr = tgPeersMap.get(p.translation_group_id) || [];
            arr.push(p);
            tgPeersMap.set(p.translation_group_id, arr);
        }
    }

    const pagesTableBodyHtml = props.pages.length === 0
        ? renderEmptyTableRow('8', i18n.empty)
        : props.pages.map(page => {
            const statusClass = page.status === 'published'
                ? 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800'
                : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300';
            const statusText = page.status === 'published' ? i18n.status_published : i18n.status_draft;

            const isTemplate = page.page_type === 'template';
            const normRoute = isTemplate ? '' : (page.route_path || (page.slug === '/' ? '/' : `/${page.slug.replace(/^\/+/, '')}`));
            const displayTpl = page.template_title || page.template_name || i18n.default_template;

            const routePathHtml = isTemplate
                ? ''
                : `<span class="text-[11px] font-mono text-slate-400 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded truncate max-w-[200px] shrink-0">${normRoute}</span>`;
            const safeTitle = (page.title || '').replace(/'/g, "\\'");
            const previewHtml = isTemplate
                ? ''
                : `<button type="button" onclick="window.openSandboxedPreview('${normRoute}', '${safeTitle}')" class="text-xs font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer">${i18n.preview}</button>`;

            const peers = page.translation_group_id ? (tgPeersMap.get(page.translation_group_id) || [page]) : [page];
            const pillBase = 'px-1.5 py-0.5 rounded border text-[10px] font-mono ';
            const translationPillsHtml = peers.length > 1
                ? `<div class="inline-flex items-center gap-1 whitespace-nowrap justify-center">${peers.map(peer => `<a href="/admin/pages/edit/${peer.id}" class="${pillBase}${peer.id === page.id ? 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800 font-bold' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-emerald-600 border-slate-200 dark:border-slate-700'}" title="${peer.title}">${peer.locale || 'zh-CN'}</a>`).join('')}</div>`
                : `<span>${page.locale}</span>`;

            return renderTemplate(pageRowTemplate, {
                id: page.id,
                folder: page.folder || '/',
                title: page.title,
                slug: page.slug,
                route_path: normRoute,
                route_path_html: routePathHtml,
                preview_html: previewHtml,
                template_name: displayTpl,
                locale: page.locale,
                translation_pills_html: translationPillsHtml,
                status_badge_class: statusClass,
                status_text: statusText,
                updated_at: page.updated_at,
                updated_at_formatted: formatSiteDateTime(page.updated_at, locale, timezone),
                domain,
                preview: i18n.preview,
                edit: i18n.edit,
                confirm_delete: i18n.format(i18n.confirm_delete, { title: page.title }),
                delete: i18n.delete
            });
        }).join('');

    let bulkLandingButtonHtml = '';
    if (isCommercial && isFeatureEnabled('bulkLanding')) {
        const btnTpl = getCommercialSnippet('bulk-landing-button.html');
        if (btnTpl) {
            bulkLandingButtonHtml = renderTemplate(btnTpl, {
                pages: {
                    bulk_landing_btn: i18n.bulk_landing_btn || t(locale, 'pages.bulk_landing_btn'),
                    bulk_landing_btn_tip: i18n.bulk_landing_btn_tip || t(locale, 'pages.bulk_landing_btn_tip')
                },
                bulk_landing_btn: i18n.bulk_landing_btn || t(locale, 'pages.bulk_landing_btn'),
                bulk_landing_btn_tip: i18n.bulk_landing_btn_tip || t(locale, 'pages.bulk_landing_btn_tip')
            }, i18n);
        }
    }

    const pageHtml = renderTemplate(pagesListTemplate, {
        slot_bulk_landing_button: bulkLandingButtonHtml,
        folder_chips_html: folderChipsHtml,
        total_records_text: i18n.format(i18n.total_records, { count: props.pages.length }),
        selected_count_zero: i18n.format(i18n.selected_count, { count: 0 }),
        entity_name: i18n.pages || 'Pages',
        pages_table_body: pagesTableBodyHtml,
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
