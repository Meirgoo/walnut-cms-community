import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser, Dataset } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, parseJson, formatSiteDateTime, getUserTimezone, parseUtcDate } from '../../engine';
import { renderEmptyTableRow } from '../routes/common';

export const DatasetListPage = async (props: {
    datasets: Dataset[];
    schemas: any[];
    sites: Site[];
    currentSiteId: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const activeSite = props.sites.find(s => s.id === props.currentSiteId) || props.sites[0];
    const timezone = getUserTimezone(props.currentUser, activeSite);
    const i18n = getAdminI18nSlice(locale, ['datasets', 'common']);
    const [listTemplate, datasetRowTemplate] = await Promise.all([
        fetchAsset('/admin/pages/dataset-list.html'),
        fetchAsset('/admin/snippets/dataset-row.html')
    ]);

    const schemaMap = new Map<string, string>();
    props.schemas.forEach(s => {
        schemaMap.set(s.id, s.title || s.slug);
        schemaMap.set(s.slug, s.title || s.slug);
    });

    const collectionMap = new Map<string, { schemaSlug: string; items: Dataset[]; latestAt: string }>();
    for (const s of props.schemas) {
        if (s.slug) {
            collectionMap.set(s.slug, { schemaSlug: s.slug, items: [], latestAt: '' });
        }
    }
    for (const d of props.datasets) {
        const meta = parseJson<Record<string, any>>(d.metadata, {});
        const key = d.schema_slug || meta.schema_slug || 'default';
        let entry = collectionMap.get(key);
        if (!entry) {
            entry = { schemaSlug: key, items: [], latestAt: '' };
            collectionMap.set(key, entry);
        }
        entry.items.push(d);
        const ts = d.updated_at || d.created_at || '';
        if (!entry.latestAt || (parseUtcDate(ts)?.getTime() || 0) > (parseUtcDate(entry.latestAt)?.getTime() || 0)) {
            entry.latestAt = ts;
        }
    }

    const collections = Array.from(collectionMap.values());

    const rowsHtml = collections.length === 0
        ? renderEmptyTableRow('6', i18n.empty)
        : collections.map(col => {
            const schemaTitle = schemaMap.get(col.schemaSlug) || col.schemaSlug || i18n.no_schema_specified;
            return renderTemplate(datasetRowTemplate, {
                schema_slug: col.schemaSlug,
                collection_name: schemaTitle,
                schema_title: col.schemaSlug,
                item_count_label: i18n.format(i18n.items_count_label, { count: col.items.length }),
                ref_pages_count: String((col.items[0] as any)?.ref_pages_count ?? 0),
                created_at_formatted: col.items[0]?.created_at ? formatSiteDateTime(col.items[0].created_at, locale, timezone) : '-',
                updated_at_formatted: col.latestAt ? formatSiteDateTime(col.latestAt, locale, timezone) : '-',
                btn_manage_items: i18n.btn_manage_items,
                btn_export_json: i18n.btn_export_json
            });
        }).join('');

    const schemaOptionsHtml = props.schemas.map(s => {
        const sMeta = parseJson<Record<string, any>>(s.metadata, {});
        const safeJson = encodeURIComponent(JSON.stringify(sMeta));
        return `<option value="${s.slug}" data-fields="${safeJson}">${s.title || s.slug} (${s.slug})</option>`;
    }).join('');

    const pageHtml = renderTemplate(listTemplate, {
        total_count: String(collections.length),
        dataset_rows_html: rowsHtml,
        schema_options_html: schemaOptionsHtml || `<option value="">${i18n.no_schemas}</option>`,
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
