import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import { safeJsonStringify } from '../../engine/render/markdown-parser';
import type { Site, AuthenticatedUser, Dataset } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, extractSchemaFields, parseJson, getUserTimezone } from '../../engine';
import { renderPastVersionsHtml, renderNewSchemaModalHtml } from '../routes/common';

export const DatasetEditorPage = async (props: {
    dataset?: Dataset;
    schemas: any[];
    versions?: any[];
    selectedSchemaSlug: string;
    sites: Site[];
    currentSiteId: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    canUseFeature?: (feature?: string) => boolean;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const isEdit = !!props.dataset;
    const activeSite = props.sites.find(s => s.id === props.currentSiteId) || props.sites[0];
    const timezone = getUserTimezone(props.currentUser, activeSite);
    const i18n = getAdminI18nSlice(locale, ['datasets', 'editor', 'common']);
    const [editorTemplate, versionItemTemplate] = await Promise.all([
        fetchAsset('/admin/pages/dataset-editor.html'),
        fetchAsset('/admin/snippets/editor-version-item.html')
    ]);

    const selectedSchemaSlug = props.selectedSchemaSlug || props.dataset?.schema_slug || '';
    const selectedSchema = props.schemas.find(s => s.slug === selectedSchemaSlug) || props.schemas[0];

    const datasetMeta = parseJson<Record<string, any>>(props.dataset?.metadata, {});

    const currentValues = datasetMeta.fields || datasetMeta || {};

    const fields = extractSchemaFields(selectedSchema);

    const dynamicFieldsHtml = fields.length === 0
        ? `<div class="p-6 text-center text-stone-400 text-xs italic">${i18n.no_fields}</div>`
        : fields.map((f: any) => {
            const val = currentValues[f.key] !== undefined ? currentValues[f.key] : (f.default ?? '');
            const req = f.required ? '<span class="text-red-500 font-bold ml-0.5">*</span>' : '';
            const reqAttr = f.required ? 'required' : '';
            const fid = `field_${f.key}`;
            const labelHtml = `<label class="block text-xs font-bold text-stone-700 dark:text-stone-300 mb-1" for="${fid}">${f.label || f.key}${req}</label>`;
            const baseCls = 'w-full bg-stone-50 dark:bg-stone-950 border border-stone-300 dark:border-stone-700 rounded-xl px-3 py-2 text-xs font-semibold text-stone-800 dark:text-stone-100 outline-none focus:border-amber-500';

            if (f.type === 'textarea') {
                return `<div>${labelHtml}<textarea id="${fid}" name="field_${f.key}" ${reqAttr} placeholder="${f.placeholder || ''}" class="${baseCls} h-24 resize-none leading-relaxed">${val}</textarea></div>`;
            } else if (f.type === 'select' && f.options && Array.isArray(f.options)) {
                const optionsHtml = f.options.map((opt: any) => `<option value="${opt.value}" ${String(opt.value) === String(val) ? 'selected' : ''}>${opt.label || opt.value}</option>`).join('');
                return `<div>${labelHtml}<edge-select id="${fid}" name="field_${f.key}" class="${baseCls} p-2.5">${optionsHtml}</edge-select></div>`;
            } else if (f.type === 'boolean') {
                return `<div class="flex items-center space-x-2 pt-2"><input type="checkbox" id="${fid}" name="field_${f.key}" value="true" ${(val === true || val === 'true' || val === 1) ? 'checked' : ''} class="rounded text-amber-600 focus:ring-0 cursor-pointer w-4 h-4" /><label class="text-xs font-bold text-stone-700 dark:text-stone-300 cursor-pointer" for="${fid}">${f.label || f.key}${req}</label></div>`;
            } else {
                return `<div>${labelHtml}<input type="${f.type === 'number' ? 'number' : 'text'}" id="${fid}" name="field_${f.key}" value="${val}" ${reqAttr} placeholder="${f.placeholder || ''}" class="${baseCls}" /></div>`;
            }
        }).join('');

    const currentSchemaSlug = selectedSchema?.slug || '';
    const currentSchemaLabel = selectedSchema ? `${selectedSchema.title || selectedSchema.slug} (${selectedSchema.slug})` : i18n.no_schema_specified;

    const schemaDropdownOptionsHtml = props.schemas.length === 0
        ? `<div class="p-3 text-center text-stone-400 text-xs">${i18n.no_schemas_available}</div>`
        : props.schemas.map(s => {
            return `
                <div
                    onclick="window.selectDatasetSchemaOption && window.selectDatasetSchemaOption('${s.slug}', '${(s.title || s.slug).replace(/'/g, "\\'")} (${s.slug})')"
                    class="px-3 py-2.5 hover:bg-stone-50 dark:hover:bg-stone-700 cursor-pointer text-stone-800 dark:text-stone-200 flex items-center justify-between"
                >
                    <span class="truncate">${s.title || s.slug}</span>
                    <span class="text-[10px] text-stone-400 font-mono ml-2 shrink-0">${s.slug}</span>
                </div>
            `;
        }).join('');

    const schemasData = props.schemas.map(s => ({
        slug: s.slug,
        title: s.title || s.slug,
        fields: extractSchemaFields(s)
    }));

    const allVersions = props.versions || [];
    const currentVerId = props.dataset?.current_version_id;
    const latestVer = allVersions.find((v: any) => v.id === currentVerId) || allVersions[0];
    const currentVersionNumber = latestVer?.version_number || 1;
    const pastVersions = allVersions.filter((v: any) => v.id !== latestVer?.id && v.version_number !== currentVersionNumber);

    const vcsVersionsMap: Record<string, any> = {};
    pastVersions.forEach((v: any) => {
        const snapMeta = parseJson<Record<string, any>>(v.metadata_snapshot, {});
        const snapFields = (snapMeta.fields && typeof snapMeta.fields === 'object')
            ? snapMeta.fields
            : parseJson<Record<string, any>>(v.content_raw, {});
        vcsVersionsMap[v.id] = {
            title: v.title || props.dataset?.title || '',
            summary: v.summary ?? '',
            fields: snapFields,
            contentRaw: v.content_raw || '{}'
        };
    });

    const pastVersionsHtml = renderPastVersionsHtml(pastVersions, versionItemTemplate, locale, timezone, i18n.editor, i18n.common.delete);

    const versionBadgeHtml = isEdit
        ? `<div class="flex items-center space-x-2"><span class="text-xs font-mono bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300 px-2.5 py-1 rounded-lg border border-stone-200 dark:border-stone-700">${String(i18n.version_active || 'v1').replace(/v\d+/, `v${currentVersionNumber}`)}</span></div>`
        : '';

    const modalNewSchemaHtml = await renderNewSchemaModalHtml(locale, props.canUseFeature, i18n.cancel || '');

    const pageHtml = renderTemplate(editorTemplate, {
        modal_new_schema: modalNewSchemaHtml,
        editor_title: isEdit ? i18n.format(i18n.editor_edit_title, { title: props.dataset?.title || '' }) : i18n.editor_new_title,
        version_badge_html: versionBadgeHtml,
        dataset_id: props.dataset?.id || '',
        is_edit: isEdit ? 'true' : 'false',
        dataset_title: props.dataset?.title || '',
        dataset_summary: props.dataset?.summary || '',
        dataset_sort_order: String(props.dataset?.sort_order ?? 0),
        current_schema_slug: currentSchemaSlug,
        current_schema_label: currentSchemaLabel,
        schema_dropdown_options_html: schemaDropdownOptionsHtml,
        schema_selector_disabled: isEdit ? 'pointer-events-none opacity-80' : '',
        dynamic_fields_html: dynamicFieldsHtml,
        versions_count: i18n.t('editor.versions_count', { count: pastVersions.length }),
        past_versions_html: pastVersionsHtml,
        vcs_versions_json: safeJsonStringify(vcsVersionsMap),
        versions_section_class: isEdit ? '' : 'hidden',
        soft_delete_btn_class: (isEdit && props.dataset?.id) ? '' : 'hidden',
        schemas_json: safeJsonStringify(schemasData)
    }, i18n);

    return (
        <AdminLayout
            title={isEdit ? `${i18n.edit} - ${i18n.title}` : i18n.btn_new}
            {...props}
            clientI18nSections={['datasets', 'schemas', 'editor']}
            locale={locale}
        >
            {raw(pageHtml)}
        </AdminLayout>
    );
};
