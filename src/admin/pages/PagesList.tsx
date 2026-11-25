import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, formatRelativeOrShortTime, getUserTimezone, normalizeLocaleCode, DEFAULT_DEV_HOST, ENGINE_CORE_VERSION, t, getCommercialSnippet, isFeatureEnabled } from '../../engine';
import { safeJsonStringify } from '../../engine/render/markdown-parser';
import { escapeHtmlAttr, formatStatusBadgeInfo, renderEmptyTableRow, renderFolderChips, renderTrashBadgeHtml, serializePageContractContext } from '../routes/common';

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
    themeComponents?: any[];
    datasetCollections?: any[];
    datasetSchemas?: any[];
    siteTaxonomy?: any;
    recentMedia?: Array<{ url: string; filename: string; alt: string }>;
    externalExtensions?: Array<{ slug: string; name: string }>;
    slotQuotas?: Record<string, number | null>;
    trashCount?: number;
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
    const i18n = getAdminI18nSlice(locale, ['pages', 'editor', 'common']);

    const [
        pagesListTemplate,
        pageRowTemplate,
        pageContractModalTemplate
    ] = await Promise.all([
        fetchAsset('/admin/pages/pages-list.html'),
        fetchAsset('/admin/snippets/page-row.html'),
        fetchAsset('/admin/modals/page-contract-modal.html')
    ]);

    const distinctFolders = Array.from(new Set(props.pages.map(p => p.folder || '/'))).filter(Boolean);

    const folderChipsHtml = renderFolderChips(distinctFolders, 'pages-table', 'pages-folder-chips');

    const transGroupsMap: Record<string, PageRow[]> = {};
    const groupedEntries: Array<{ isGroup: boolean; groupId?: string; items: PageRow[] }> = [];
    const seenGroupIds = new Set<string>();

    props.pages.forEach(page => {
        if (page.translation_group_id) {
            if (!transGroupsMap[page.translation_group_id]) {
                transGroupsMap[page.translation_group_id] = [];
            }
            transGroupsMap[page.translation_group_id].push(page);
        }
    });

    // Preserve updated_at DESC display order while collapsing sibling translations at their newest group member.
    props.pages.forEach(page => {
        if (page.translation_group_id) {
            if (!seenGroupIds.has(page.translation_group_id)) {
                seenGroupIds.add(page.translation_group_id);
                groupedEntries.push({
                    isGroup: true,
                    groupId: page.translation_group_id,
                    items: transGroupsMap[page.translation_group_id]
                });
            }
        } else {
            groupedEntries.push({ isGroup: false, items: [page] });
        }
    });

    const siteDefaultLocale = normalizeLocaleCode(activeSite?.default_locale || 'zh-CN');

    const renderPageRow = (page: PageRow, groupItems?: PageRow[]) => {
        const { badgeClass: statusClass, badgeText: statusText } = formatStatusBadgeInfo(page.status, i18n);

        const isTemplate = page.page_type === 'template';
        const normRoute = isTemplate ? '' : (page.route_path || (page.slug === '/' ? '/' : `/${page.slug.replace(/^\/+/, '')}`));
        const displayTpl = page.template_title || page.template_name || i18n.default_template;
        const safeJsTitle = escapeHtmlAttr(page.title || '').replace(/'/g, "\\'");
        const safeJsRoute = escapeHtmlAttr(normRoute).replace(/'/g, "\\'");

        const routePathHtml = isTemplate
            ? ''
            : `<button type="button" onclick="window.openSandboxedPreview('${safeJsRoute}', '${safeJsTitle}')" class="text-[11px] font-mono text-[var(--admin-text-muted)] hover:text-[var(--admin-accent-text)] bg-[var(--admin-chrome)] px-1.5 py-0.5 rounded truncate max-w-[200px] shrink-0 cursor-pointer">${escapeHtmlAttr(normRoute)}</button>`;
        const previewHtml = isTemplate
            ? ''
            : `<button type="button" onclick="window.openSandboxedPreview('${safeJsRoute}', '${safeJsTitle}')" class="text-xs font-medium text-[var(--admin-text-muted)] hover:text-[var(--admin-text)] cursor-pointer transition">${i18n.preview}</button>`;

        const rawVariants = groupItems && groupItems.length > 1 ? [...groupItems] : [page];
        rawVariants.sort((a, b) => {
            if (a.id === page.id) return -1;
            if (b.id === page.id) return 1;
            return (a.locale || '').localeCompare(b.locale || '');
        });

        const translationPillsHtml = `<div class="inline-flex items-center gap-1 whitespace-nowrap justify-center">${rawVariants.map(peer => {
            const isCurrent = peer.id === page.id;
            return `<a href="/admin/pages/edit/${peer.id}" class="list-pill ${isCurrent ? 'list-pill-locale-active' : 'list-pill-locale'}" title="${escapeHtmlAttr(peer.title || '')}">${escapeHtmlAttr(peer.locale || 'zh-CN')}</a>`;
        }).join('')}</div>`;

        const searchTokens = new Set<string>();
        rawVariants.forEach(v => {
            if (v.title) searchTokens.add(v.title);
            if (v.slug) searchTokens.add(v.slug);
            if (v.route_path) searchTokens.add(v.route_path);
            if (v.locale) searchTokens.add(v.locale);
            if (v.template_title) searchTokens.add(v.template_title);
        });
        const searchText = Array.from(searchTokens).join(' ');

        const ts = formatRelativeOrShortTime(page.updated_at, locale, timezone);

        return renderTemplate(pageRowTemplate, {
            id: page.id,
            folder: page.folder || '/',
            title: escapeHtmlAttr(page.title || ''),
            slug: page.slug,
            route_path: normRoute,
            route_path_html: routePathHtml,
            preview_html: previewHtml,
            template_name: escapeHtmlAttr(displayTpl),
            locale: page.locale,
            translation_pills_html: translationPillsHtml,
            search_text: escapeHtmlAttr(searchText),
            status_badge_class: statusClass,
            status_text: statusText,
            updated_at: page.updated_at,
            updated_at_formatted: ts.short,
            updated_at_full: ts.full,
            domain,
            preview: i18n.preview,
            edit: i18n.edit,
            confirm_delete: escapeHtmlAttr(i18n.format(i18n.confirm_delete, { title: page.title })),
            delete: i18n.delete,
            btn_move_to_trash: i18n.btn_move_to_trash
        });
    };

    const pagesTableBodyHtml = props.pages.length === 0
        ? renderEmptyTableRow('8', i18n.empty)
        : groupedEntries.map(entry => {
            if (entry.isGroup && entry.items.length > 1) {
                const primaryItem = entry.items.find(it => normalizeLocaleCode(it.locale) === siteDefaultLocale) || entry.items[0];
                return renderPageRow(primaryItem, entry.items);
            }
            return renderPageRow(entry.items[0]);
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

    const totalRecordsText = groupedEntries.length !== props.pages.length
        ? i18n.format(i18n.total_grouped_records, { groups: groupedEntries.length, count: props.pages.length })
        : i18n.format(i18n.total_records, { count: props.pages.length });

    const hasPublicExtensions = Boolean(isCommercial && Array.isArray(props.externalExtensions) && props.externalExtensions.length > 0);
    const {
        componentsPayload: contractComponents,
        templatesPayload: contractTemplates,
        datasetsPayload: contractDatasets
    } = serializePageContractContext({
        themeComponents: props.themeComponents || [],
        templatePages: props.templates || [],
        datasetCollections: props.datasetCollections || [],
        datasetSchemas: props.datasetSchemas || [],
        siteTaxonomy: props.siteTaxonomy,
        recentMedia: props.recentMedia || [],
        externalExtensions: hasPublicExtensions ? (props.externalExtensions || []) : [],
        extIslandEnabled: hasPublicExtensions,
        slotQuotas: props.slotQuotas || {},
        includeTemplateHtmlAndPreview: false
    });
    const pageContractModalHtml = renderTemplate(pageContractModalTemplate, {
        page_contract_ctx_mode: 'list'
    }, i18n);

    const pageHtml = renderTemplate(pagesListTemplate, {
        trash_badge_html: renderTrashBadgeHtml(props.trashCount),
        slot_bulk_landing_button: bulkLandingButtonHtml,
        folder_chips_html: folderChipsHtml,
        total_records_text: totalRecordsText,
        selected_count_zero: i18n.format(i18n.selected_count, { count: 0 }),
        entity_name: t(locale, 'nav.pages'),
        pages_table_body: pagesTableBodyHtml,
        page_contract_modal: pageContractModalHtml,
        theme_components_json: safeJsonStringify(contractComponents),
        theme_templates_json: safeJsonStringify(contractTemplates),
        page_datasets_json: safeJsonStringify(contractDatasets),
        engine_version: ENGINE_CORE_VERSION
    }, i18n);

    return (
        <AdminLayout
            title={i18n.pages.title}
            {...props}
            clientI18nSections={['pages', 'editor']}
            locale={locale}
        >
            {raw(pageHtml)}
        </AdminLayout>
    );
};
