import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser, Dataset, DatasetCollection } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, parseJson, extractSchemaFields } from '../../engine';
import { safeJsonStringify } from '../../engine/render/markdown-parser';

export const DatasetCollectionEditorPage = async (props: {
    collection?: DatasetCollection;
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
    const collectionTitle = props.collection?.name || props.schemaItem?.title || props.schemaSlug;
    const collectionId = props.collection?.id || '';
    const collectionSlug = props.collection?.slug || props.schemaSlug;
    const schemaLabel = props.schemaItem?.title || props.schemaSlug;

    const rowsPayload = props.datasets.map(d => {
        const meta = parseJson<Record<string, any>>(d.metadata, {});
        const fields = (meta.fields && typeof meta.fields === 'object')
            ? meta.fields
            : ((meta.data && typeof meta.data === 'object') ? meta.data : meta);
        return {
            id: d.id,
            slug: d.slug || '',
            title: d.title,
            summary: d.summary || '',
            sort_order: Number(d.sort_order) || 0,
            fields
        };
    });

    const pageHtml = renderTemplate(template, {
        collection_id: collectionId,
        collection_slug: collectionSlug,
        schema_slug: props.schemaSlug,
        schema_label: schemaLabel,
        collection_title: collectionTitle,
        collection_subtitle: i18n.collection_subtitle,
        breadcrumb_root: i18n.breadcrumb_root,
        btn_add_row: i18n.btn_add_row,
        btn_save_collection: i18n.btn_save_collection,
        btn_export_json: i18n.btn_export_json,
        btn_copy_ai_clean_context: i18n.btn_copy_ai_clean_context,
        btn_import_json: i18n.btn_import_json,
        modal_collection_import_title: i18n.modal_collection_import_title,
        import_paste_label: i18n.import_paste_label,
        import_paste_placeholder: i18n.import_paste_placeholder,
        import_skip_conflicts: i18n.import_skip_conflicts,
        btn_confirm_import: i18n.btn_confirm_import,
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
