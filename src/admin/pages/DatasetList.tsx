import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser, Dataset, DatasetCollection } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, parseJson, formatRelativeOrShortTime, getUserTimezone, extractSchemaFields } from '../../engine';
import { safeJsonStringify } from '../../engine/render/markdown-parser';
import { escapeHtmlAttr, renderEmptyTableRow, renderTrashBadgeHtml, renderNewSchemaModalHtml } from '../routes/common';

export const DatasetListPage = async (props: {
    collections?: DatasetCollection[];
    datasets?: Dataset[];
    schemas: any[];
    trashCount?: number;
    sites: Site[];
    currentSiteId: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    canUseFeature?: (feature?: string) => boolean;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const activeSite = props.sites.find(s => s.id === props.currentSiteId) || props.sites[0];
    const timezone = getUserTimezone(props.currentUser, activeSite);
    const i18n = getAdminI18nSlice(locale, ['datasets', 'schemas', 'common']);
    const [listTemplate, datasetRowTemplate, modalNewSchemaHtml] = await Promise.all([
        fetchAsset('/admin/pages/dataset-list.html'),
        fetchAsset('/admin/snippets/dataset-row.html'),
        renderNewSchemaModalHtml(locale, props.canUseFeature, i18n.cancel || '')
    ]);

    const schemaBySlug = new Map<string, any>();
    props.schemas.forEach(s => {
        if (s.slug) schemaBySlug.set(s.slug, s);
        if (s.id) schemaBySlug.set(s.id, s);
    });

    const collections = props.collections || [];

    const rowsHtml = collections.length === 0
        ? renderEmptyTableRow('9', i18n.empty)
        : collections.map(col => {
            const schemaObj = schemaBySlug.get(col.schema_key);
            const schemaTitle = schemaObj?.title || col.schema_key || i18n.no_schema_specified;
            const itemCount = Number(col.item_count || 0);
            const updatedTs = formatRelativeOrShortTime(col.latest_updated_at || col.updated_at || col.created_at, locale, timezone);
            const createdTs = formatRelativeOrShortTime(col.created_at, locale, timezone);
            const safeName = escapeHtmlAttr(col.name || col.slug);
            const jsName = safeName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

            return renderTemplate(datasetRowTemplate, {
                id: col.id,
                collection_slug: escapeHtmlAttr(col.slug),
                schema_slug: escapeHtmlAttr(col.schema_key),
                collection_name: safeName,
                collection_name_js: jsName,
                schema_title: escapeHtmlAttr(schemaTitle),
                item_count: String(itemCount),
                item_count_label: i18n.format(i18n.items_count_label, { count: itemCount }),
                ref_pages_count: '0',
                created_at_formatted: createdTs.short,
                created_at_full: createdTs.full,
                updated_at_formatted: updatedTs.short,
                updated_at_full: updatedTs.full,
                btn_manage_items: i18n.btn_manage_items,
                btn_export_json: i18n.btn_export_json
            });
        }).join('');

    const schemaOptionsHtml = props.schemas.map(s => {
        const sMeta = parseJson<Record<string, any>>(s.metadata, {});
        const isCustom = Boolean(sMeta?.is_custom || sMeta?.source === 'custom' || s.is_custom);
        const sourceLabel = isCustom ? i18n.schemas.source_site : i18n.schemas.source_theme;
        const safeJson = encodeURIComponent(JSON.stringify(sMeta));
        return `<option value="${escapeHtmlAttr(s.slug)}" data-fields="${safeJson}" data-custom="${isCustom ? '1' : '0'}">${escapeHtmlAttr(s.title || s.slug)} (${escapeHtmlAttr(s.slug)}) · ${escapeHtmlAttr(sourceLabel)}</option>`;
    }).join('');

    const schemasData = props.schemas.map(s => {
        const sMeta = parseJson<Record<string, any>>(s.metadata, {});
        const isCustom = Boolean(sMeta?.is_custom || sMeta?.source === 'custom' || s.is_custom);
        const colRefs = collections.filter(c => c.schema_key === s.slug).length;
        const itemRefs = (props.datasets || []).filter((d: any) => d.schema_slug === s.slug).length;
        return {
            id: s.id || `schema_${s.slug}`,
            slug: s.slug,
            title: s.title || s.slug,
            summary: s.summary || '',
            is_custom: isCustom,
            dependent_count: colRefs + itemRefs,
            fields: extractSchemaFields(s)
        };
    });

    const collectionOptionsHtml = collections.map(col => {
        const schemaObj = schemaBySlug.get(col.schema_key);
        const sMeta = parseJson<Record<string, any>>(schemaObj?.metadata, {});
        const safeJson = encodeURIComponent(JSON.stringify(sMeta));
        return `<option value="${escapeHtmlAttr(col.id)}" data-schema="${escapeHtmlAttr(col.schema_key)}" data-fields="${safeJson}">${escapeHtmlAttr(col.name)} (${escapeHtmlAttr(col.slug)})</option>`;
    }).join('');

    const pageHtml = renderTemplate(listTemplate, {
        trash_badge_html: renderTrashBadgeHtml(props.trashCount),
        total_collections_text: i18n.format(i18n.total_collections_count, { count: collections.length }),
        selected_count_zero: i18n.format(i18n.selected_count, { count: 0 }),
        dataset_rows_html: rowsHtml,
        schema_options_html: schemaOptionsHtml || `<option value="">${i18n.no_schemas}</option>`,
        collection_options_html: collectionOptionsHtml || `<option value="">${i18n.no_collections}</option>`,
        schemas_json: safeJsonStringify(schemasData),
        modal_new_schema: modalNewSchemaHtml
    }, i18n);

    return (
        <AdminLayout
            title={i18n.title}
            {...props}
            clientI18nSections={['datasets', 'schemas', 'editor']}
            locale={locale}
        >
            {raw(pageHtml)}
        </AdminLayout>
    );
};
