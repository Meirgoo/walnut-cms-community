import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import { safeJsonStringify } from '../../engine/render/markdown-parser';
import type { Site, AuthenticatedUser, Dataset } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, extractSchemaFields, parseJson } from '../../engine';

export const DatasetEditorPage = async (props: {
    dataset?: Dataset;
    schemas: any[];
    selectedSchemaSlug: string;
    sites: Site[];
    currentSiteId: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const isEdit = !!props.dataset;
    const i18n = getAdminI18nSlice(locale, ['datasets', 'common']);
    const editorTemplate = await fetchAsset('/admin/pages/dataset-editor.html');

    const selectedSchemaSlug = props.selectedSchemaSlug || props.dataset?.schema_slug || '';
    const selectedSchema = props.schemas.find(s => s.slug === selectedSchemaSlug) || props.schemas[0];

    const datasetMeta = parseJson<Record<string, any>>(props.dataset?.metadata, {});

    const currentValues = datasetMeta.fields || datasetMeta || {};

    const fields = extractSchemaFields(selectedSchema);

    const dynamicFieldsHtml = fields.length === 0
        ? `<div class="p-6 text-center text-slate-400 text-xs italic">${i18n.no_fields}</div>`
        : fields.map((f: any) => {
            const val = currentValues[f.key] !== undefined ? currentValues[f.key] : (f.default ?? '');
            const req = f.required ? '<span class="text-red-500 font-bold ml-0.5">*</span>' : '';
            const reqAttr = f.required ? 'required' : '';
            const fid = `field_${f.key}`;
            const labelHtml = `<label class="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1" for="${fid}">${f.label || f.key}${req}</label>`;
            const baseCls = 'w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 outline-none focus:border-emerald-500';

            if (f.type === 'textarea') {
                return `<div>${labelHtml}<textarea id="${fid}" name="field_${f.key}" ${reqAttr} placeholder="${f.placeholder || ''}" class="${baseCls} h-24 resize-none leading-relaxed">${val}</textarea></div>`;
            } else if (f.type === 'select' && f.options && Array.isArray(f.options)) {
                const optionsHtml = f.options.map((opt: any) => `<option value="${opt.value}" ${String(opt.value) === String(val) ? 'selected' : ''}>${opt.label || opt.value}</option>`).join('');
                return `<div>${labelHtml}<walnut-select id="${fid}" name="field_${f.key}" class="${baseCls} p-2.5">${optionsHtml}</walnut-select></div>`;
            } else if (f.type === 'boolean') {
                return `<div class="flex items-center space-x-2 pt-2"><input type="checkbox" id="${fid}" name="field_${f.key}" value="true" ${(val === true || val === 'true' || val === 1) ? 'checked' : ''} class="rounded text-emerald-600 focus:ring-0 cursor-pointer w-4 h-4" /><label class="text-xs font-bold text-slate-700 dark:text-slate-300 cursor-pointer" for="${fid}">${f.label || f.key}${req}</label></div>`;
            } else {
                return `<div>${labelHtml}<input type="${f.type === 'number' ? 'number' : 'text'}" id="${fid}" name="field_${f.key}" value="${val}" ${reqAttr} placeholder="${f.placeholder || ''}" class="${baseCls}" /></div>`;
            }
        }).join('');

    const currentSchemaSlug = selectedSchema?.slug || '';
    const currentSchemaLabel = selectedSchema ? `${selectedSchema.title || selectedSchema.slug} (${selectedSchema.slug})` : i18n.no_schema_specified;

    const schemaDropdownOptionsHtml = props.schemas.length === 0
        ? `<div class="p-3 text-center text-slate-400 text-xs">${i18n.no_schemas_available}</div>`
        : props.schemas.map(s => {
            return `
                <div
                    onclick="window.selectDatasetSchemaOption && window.selectDatasetSchemaOption('${s.slug}', '${(s.title || s.slug).replace(/'/g, "\\'")} (${s.slug})')"
                    class="px-3 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-700 cursor-pointer text-slate-800 dark:text-slate-200 flex items-center justify-between"
                >
                    <span class="truncate">${s.title || s.slug}</span>
                    <span class="text-[10px] text-slate-400 font-mono ml-2 shrink-0">${s.slug}</span>
                </div>
            `;
        }).join('');

    const schemasData = props.schemas.map(s => ({
        slug: s.slug,
        title: s.title || s.slug,
        fields: extractSchemaFields(s)
    }));

    const versionBadgeHtml = isEdit
        ? `<div class="flex items-center space-x-2"><span class="text-xs font-mono bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700">${i18n.version_active}</span></div>`
        : '';

    const pageHtml = renderTemplate(editorTemplate, {
        editor_title: isEdit ? i18n.format(i18n.editor_edit_title, { title: props.dataset?.title || '' }) : i18n.editor_new_title,
        version_badge_html: versionBadgeHtml,
        dataset_id: props.dataset?.id || '',
        is_edit: isEdit ? 'true' : 'false',
        dataset_title: props.dataset?.title || '',
        dataset_summary: props.dataset?.summary || '',
        current_schema_slug: currentSchemaSlug,
        current_schema_label: currentSchemaLabel,
        schema_dropdown_options_html: schemaDropdownOptionsHtml,
        schema_selector_disabled: isEdit ? 'pointer-events-none opacity-80' : '',
        dynamic_fields_html: dynamicFieldsHtml,
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
