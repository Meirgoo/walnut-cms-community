import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser, Dataset } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, parseJson, extractSchemaFields } from '../../engine';
import { safeJsonStringify } from '../../engine/render/markdown-parser';

export const DatasetCollectionEditorPage = async (props: {
    schemaSlug: string;
    schemaItem?: any;
    datasets: Dataset[];
    sites: Site[];
    currentSiteId: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const i18n = getAdminI18nSlice(locale, ['datasets', 'common']);
    const template = await fetchAsset('/admin/pages/dataset-collection-editor.html');

    const schemaFields = props.schemaItem ? extractSchemaFields(props.schemaItem) : [];
    const collectionTitle = props.schemaItem?.title || props.schemaSlug;

    const rowsPayload = props.datasets.map(d => {
        const meta = parseJson<Record<string, any>>(d.metadata, {});
        const fields = (meta.fields && typeof meta.fields === 'object')
            ? meta.fields
            : ((meta.data && typeof meta.data === 'object') ? meta.data : meta);
        return {
            id: d.id,
            title: d.title,
            summary: d.summary || '',
            fields
        };
    });

    const pageHtml = renderTemplate(template, {
        schema_slug: props.schemaSlug,
        collection_title: collectionTitle,
        collection_subtitle: i18n.collection_subtitle,
        btn_add_row: i18n.btn_add_row,
        btn_save_collection: i18n.btn_save_collection,
        schema_fields_json: safeJsonStringify(schemaFields),
        rows_json: safeJsonStringify(rowsPayload)
    }, i18n);

    return (
        <AdminLayout
            title={`${collectionTitle} - ${i18n.title}`}
            {...props}
            clientI18nSections={['datasets']}
            locale={locale}
        >
            {raw(pageHtml)}
        </AdminLayout>
    );
};
