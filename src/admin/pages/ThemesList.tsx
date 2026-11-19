import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser, Theme } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, t, parseJson, escapeHtmlAttr } from '../../engine';
import { processThemeMarkdownComponents } from '../../engine/render';

export function buildThemePreviewIframeSrcdoc(contentHtml: string, themeAssetPrefix = '/theme/univers', isComp = false, rawMode = false): string {
    const html = `<!DOCTYPE html><html class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=${isComp ? 1080 : 1280}"><link rel="stylesheet" href="/shared/app.css"><link rel="stylesheet" href="/shared/material-symbols.css"><link rel="stylesheet" href="${themeAssetPrefix}/assets/css/style.css"><style>*{box-sizing:border-box}html,body{margin:0;padding:0;overflow-x:hidden;font-family:ui-sans-serif,system-ui,sans-serif}.fixed,.sticky{position:relative!important}[id*="mobile"],[class*="mobile"],[class*="drawer"],[class*="backdrop"],.fixed.inset-0,[x-cloak]{display:none!important}${isComp ? 'body{min-height:auto;padding:12px 16px!important}body>*{width:100%}.h-screen,.min-h-screen{height:480px!important;min-height:480px!important}' : ''}</style><script>function __applyDocTheme(isDark){if(isDark){document.documentElement.classList.add('dark');if(document.body){document.body.classList.remove('bg-white','text-slate-900');document.body.classList.add('bg-[#0b1120]','text-slate-100');}}else{document.documentElement.classList.remove('dark');if(document.body){document.body.classList.remove('bg-[#0b1120]','text-slate-100');document.body.classList.add('bg-white','text-slate-900');}}}try{var p=window.parent;if(p&&p.document&&p.document.documentElement){var isDark=p.document.documentElement.classList.contains('dark')||p.document.documentElement.getAttribute('data-theme-mode')==='dark';if(!isDark){__applyDocTheme(false);}}}catch(_){}window.addEventListener('message',function(e){if(e.data&&e.data.type==='walnut:theme_mode'&&typeof e.data.isDark==='boolean'){__applyDocTheme(e.data.isDark);}});${isComp ? "window.addEventListener('load',function(){try{window.parent?.adaptThemeComponentHeight?.(window.frameElement)}catch(_){}});" : ''}</script></head><body class="bg-[#0b1120] text-slate-100 p-6 antialiased">${contentHtml}</body></html>`;
    return rawMode ? html : escapeHtmlAttr(html);
}

export const ThemesListPage = async (props: {
    themeNode?: Theme | any;
    allThemes?: Theme[] | any[];
    deletedThemes?: Theme[] | any[];
    templateNodes: any[];
    componentNodes: any[];
    schemaNodes?: any[];
    sites: Site[];
    currentSiteId: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const schemaNodes = props.schemaNodes || [];
    const i18n = getAdminI18nSlice(locale, ['themes', 'common']);

    const [
        themesListTemplate,
        importThemeModalTemplate,
        themeFormModalTemplate,
        themeForkModalTemplate,
        cloneTemplatePageModalTemplate,
        themeCardTemplate,
        trashThemeCardTemplate,
        templateCardTemplate,
        componentCardTemplate,
        schemaCardTemplate,
        emptyBlockTemplate,
        mdComponentCardTemplate
    ] = await Promise.all([
        fetchAsset('/admin/pages/themes-list.html'),
        fetchAsset('/admin/modals/import-theme-modal.html'),
        fetchAsset('/admin/modals/theme-form-modal.html'),
        fetchAsset('/admin/modals/theme-fork-modal.html'),
        fetchAsset('/admin/modals/clone-template-page-modal.html'),
        fetchAsset('/admin/snippets/theme-card.html'),
        fetchAsset('/admin/snippets/theme-trash-card.html'),
        fetchAsset('/admin/snippets/theme-template-card.html'),
        fetchAsset('/admin/snippets/theme-component-card.html'),
        fetchAsset('/admin/snippets/theme-schema-card.html'),
        fetchAsset('/admin/snippets/empty-block.html'),
        fetchAsset('/admin/snippets/theme-md-component-card.html')
    ]);
    const activeTheme = props.themeNode;
    const rawAllThemes = props.allThemes && props.allThemes.length > 0 ? props.allThemes : (activeTheme ? [activeTheme] : []);
    const allThemes = [...rawAllThemes].sort((a, b) => {
        const isA = a.id === activeTheme?.id || a.slug === activeTheme?.slug;
        const isB = b.id === activeTheme?.id || b.slug === activeTheme?.slug;
        if (isA) return -1;
        if (isB) return 1;
        return 0;
    });
    const deletedThemes = props.deletedThemes || [];
    const themeMeta = parseJson<Record<string, any>>(activeTheme?.metadata, {});

    const mdComponents = themeMeta.md_components || {};
    const mdKeys = Object.keys(mdComponents);

    const allThemesGridHtml = allThemes.map(th => {
        const isCurrent = th.id === activeTheme?.id || th.slug === activeTheme?.slug;
        const meta = parseJson<Record<string, any>>(th.metadata, {});

        const hasComponents = (props.componentNodes && props.componentNodes.length > 0) || (Array.isArray(meta.components) && meta.components.length > 0);
        const isProblematic = !hasComponents || !meta.version;

        const borderClass = isProblematic
            ? 'border-red-500 ring-2 ring-red-500/20 bg-red-50/10'
            : isCurrent
                ? 'border-emerald-500 ring-2 ring-emerald-500/20'
                : 'border-slate-200/80 dark:border-slate-700 hover:border-slate-300';

        const statusBadge = isCurrent
            ? `<span class="text-[10px] font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 px-2 py-0.5 rounded">${i18n.active_status}</span>`
            : isProblematic
                ? `<span class="text-[10px] font-bold text-red-700 dark:text-red-400 bg-red-100 dark:bg-red-950 border border-red-200 dark:border-red-800 px-2 py-0.5 rounded flex items-center space-x-1"><span class="material-symbols-outlined text-[12px]">warning</span><span>${i18n.status_abnormal}</span></span>`
                : `<span class="text-[10px] font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950 px-2 py-0.5 rounded">${i18n.installed_status}</span>`;

        const isRepoTheme = !!meta.repo_config?.url;
        const safeTitle = (th.title || th.name || '').replace(/'/g, "\\'");
        const safeDesc = (th.summary || th.description || '').replace(/'/g, "\\'");
        const safeAuthor = (th.author || meta.author || '').replace(/'/g, "\\'");

        return renderTemplate(themeCardTemplate, {
            id: th.id,
            border_class: borderClass,
            slug: th.slug,
            status_badge_html: statusBadge,
            repo_badge_class: isRepoTheme ? '' : 'hidden',
            repo_url: meta.repo_config?.url || '',
            version: th.version || meta.version || '1.0.0',
            title: safeTitle,
            summary: safeDesc,
            author: safeAuthor,
            update_btn_class: isRepoTheme ? '' : 'hidden',
            activate_btn_class: !isCurrent ? '' : 'hidden',
            active_indicator_class: isCurrent ? '' : 'hidden',
            delete_btn_class: (!isCurrent && allThemes.length > 1) ? '' : 'hidden'
        }, i18n);
    }).join('');

    const renderEmptyBlock = (icon: string, title: string, desc: string) =>
        renderTemplate(emptyBlockTemplate, { icon, title, desc });

    const gridWrap = (items: any[], empty: string, renderItem: (it: any) => string, cols = 'md:grid-cols-2') =>
        items.length === 0 ? empty : `<div class="grid grid-cols-1 ${cols} gap-6">${items.map(renderItem).join('')}</div>`;

    const themesTrashContentHtml = gridWrap(
        deletedThemes,
        renderEmptyBlock('delete_sweep', t(locale, 'themes.trash_empty_title'), t(locale, 'themes.trash_empty_desc')),
        th => renderTemplate(trashThemeCardTemplate, { id: th.id, slug: th.slug, title: th.title || th.name, summary: th.summary || th.description || '' }, i18n),
        'md:grid-cols-3'
    );

    const compMap = new Map<string, any>();
    for (const comp of props.componentNodes) {
        const cMeta = parseJson<Record<string, any>>(comp.metadata, {});
        const cSlug = comp.slug || cMeta.slug;
        if (cSlug) compMap.set(cSlug, { ...comp, meta: cMeta });
        if (comp.type) compMap.set(comp.type, { ...comp, meta: cMeta });
        if (cMeta.type) compMap.set(cMeta.type, { ...comp, meta: cMeta });
    }

    const themeAssetPrefix = activeTheme?.slug ? `/theme/${activeTheme.slug}` : '/theme/univers';
    const buildTemplateIframeSrcdoc = (h: string) => buildThemePreviewIframeSrcdoc(h, themeAssetPrefix, false);
    const buildComponentIframeSrcdoc = (h: string) => buildThemePreviewIframeSrcdoc(h, themeAssetPrefix, true);

    const templateNodesContentHtml = gridWrap(
        props.templateNodes,
        renderEmptyBlock('web', i18n.themes.empty_templates, i18n.themes.empty_templates_desc),
        tpl => {
            const meta = parseJson<Record<string, any>>(tpl.metadata, {});
            const blocksList = meta.blocks || [];
            const previewHtml = blocksList.map((b: any) => {
                const compKey = b.component || b.type || '';
                const comp = compMap.get(compKey);
                const tplHtml = comp?.meta?.template_html || comp?.meta?.templateHtml || comp?.template_html || '';
                const defaultProps = comp?.meta?.default_props || comp?.meta?.defaultProps || {};
                const propsObj = { ...defaultProps, ...(b.props || {}) };
                return tplHtml ? renderTemplate(tplHtml, propsObj) : '';
            }).filter(Boolean).join('\n') || `<div class="p-8 text-center text-xs text-slate-400">${i18n.themes?.no_preview_comps || 'No preview components'}</div>`;

            const safeTitle = (tpl.title || tpl.name || tpl.slug || '').replace(/'/g, "\\'");
            const safeSummary = (tpl.summary || tpl.description || '').replace(/'/g, "\\'");

            return renderTemplate(templateCardTemplate, {
                id: tpl.id,
                title: tpl.title,
                safe_title: safeTitle,
                slug: tpl.slug,
                summary: tpl.summary || i18n.themes.no_description,
                safe_summary: safeSummary,
                preview_html: previewHtml,
                safe_template_srcdoc: buildTemplateIframeSrcdoc(previewHtml)
            }, i18n);
        },
        'grid-cols-1 xl:grid-cols-2'
    );

    const renderFieldTableRows = (fields: any[]) => {
        if (!fields || fields.length === 0) {
            return `<tr><td colspan="3" class="py-3 px-3 text-center text-xs text-slate-400 italic">${i18n.themes?.no_schema_fields || ''}</td></tr>`;
        }
        return fields.map((f: any) => {
            const key = f.key || f.name || '-';
            const label = f.label || f.title || f.name || key;
            const type = f.type || f.widget || 'text';
            return `<tr class="hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition">
                <td class="py-2 px-3 font-mono font-medium text-emerald-600 dark:text-emerald-400 text-xs">${key}</td>
                <td class="py-2 px-3 font-medium text-slate-700 dark:text-slate-200 text-xs">${label}</td>
                <td class="py-2 px-3 text-slate-400 font-mono text-[11px]"><span class="bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded border border-slate-200/60 dark:border-slate-700/60">${type}</span></td>
            </tr>`;
        }).join('');
    };

    const componentNodesContentHtml = gridWrap(
        props.componentNodes,
        renderEmptyBlock('widgets', i18n.themes.empty_components, i18n.themes.empty_components_desc),
        comp => {
            const cMeta = parseJson<Record<string, any>>(comp.metadata, {});
            const tplHtml = cMeta.template_html || cMeta.templateHtml || comp.template_html || '';
            const defaultProps = cMeta.default_props || cMeta.defaultProps || {};
            const previewHtml = tplHtml ? renderTemplate(tplHtml, defaultProps) : `<div class="text-xs text-slate-400 text-center py-4">${i18n.themes?.no_template_content || 'No template content'}</div>`;

            const rawSlots = cMeta.slots || cMeta.allowed_slots || ['main'];
            const slotsArr = Array.isArray(rawSlots) ? rawSlots : (typeof rawSlots === 'string' ? rawSlots.split(',').map((s: string) => s.trim()).filter(Boolean) : ['main']);
            const safeSlotsAttr = encodeURIComponent(JSON.stringify(slotsArr));
            const slotsBadgesHtml = slotsArr.length > 0
                ? slotsArr.map((s: string) => `<span class="bg-indigo-50 dark:bg-indigo-950/80 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800/80 px-2 py-0.5 rounded-lg font-mono text-[10px] font-semibold">${s}</span>`).join(' ')
                : `<span class="bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 px-2 py-0.5 rounded-lg font-mono text-[10px] font-semibold">main</span>`;

            const safeTitle = (comp.title || comp.slug || '').replace(/'/g, "\\'");
            const safeSummary = (comp.summary || i18n.themes.no_description || '').replace(/'/g, "\\'");
            const safeTemplateHtml = encodeURIComponent(tplHtml);
            const safeDefaultPropsJson = encodeURIComponent(JSON.stringify(defaultProps, null, 2));
            const safePropsSchemaJson = encodeURIComponent(JSON.stringify(cMeta.schema || cMeta.props_schema || {}, null, 2));

            return renderTemplate(componentCardTemplate, {
                id: comp.id,
                theme_id: activeTheme?.id || '',
                title: comp.title,
                safe_title: safeTitle,
                slug: comp.slug,
                version: String(cMeta.version || 1),
                icon: cMeta.icon || 'widgets',
                summary: comp.summary || i18n.themes.no_description,
                safe_summary: safeSummary,
                slots_attr: safeSlotsAttr,
                slots_badges_html: slotsBadgesHtml,
                safe_template_html: safeTemplateHtml,
                safe_default_props_json: safeDefaultPropsJson,
                safe_props_schema_json: safePropsSchemaJson,
                preview_html: previewHtml,
                safe_component_srcdoc: buildComponentIframeSrcdoc(previewHtml)
            }, i18n);
        },
        'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
    );

    const mdSampleText = t(locale, 'themes.md_sample_text');
    const mdComponentsContentHtml = gridWrap(
        mdKeys,
        renderEmptyBlock('code_blocks', i18n.themes.empty_md_components, i18n.themes.empty_md_components_desc),
        key => {
            const rawSample = processThemeMarkdownComponents(`[[${key}: ${mdSampleText}]]`, themeMeta);
            return renderTemplate(mdComponentCardTemplate, {
                key,
                theme_id: activeTheme?.id || '',
                syntax_prefix: t(locale, 'themes.syntax_prefix'),
                live_preview: t(locale, 'themes.live_preview'),
                safe_md_srcdoc: buildComponentIframeSrcdoc(rawSample)
            }, i18n);
        },
        'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
    );

    const datasetSchemasContentHtml = gridWrap(
        schemaNodes,
        renderEmptyBlock('data_object', i18n.themes.empty_schemas, i18n.themes.empty_schemas_desc),
        schema => {
            const sMeta = parseJson<Record<string, any>>(schema.metadata, {});
            const fields = sMeta.fields || (sMeta.schema?.fields) || [];
            return renderTemplate(schemaCardTemplate, {
                id: schema.id, title: schema.title, safe_title: schema.title.replace(/'/g, "\\'"), slug: schema.slug,
                summary: schema.summary || i18n.themes.schema_default_summary,
                safe_json_attr: encodeURIComponent(JSON.stringify(sMeta, null, 2)),
                fields_count_label: t(locale, 'themes.schema_fields_count_def', { count: fields.length }),
                fields_table_rows: renderFieldTableRows(fields)
            }, i18n);
        }
    );

    const importThemeModalHtml = renderTemplate(importThemeModalTemplate, {}, i18n);
    const themeFormModalHtml = renderTemplate(themeFormModalTemplate, {}, i18n);
    const themeForkModalHtml = renderTemplate(themeForkModalTemplate, {}, i18n);
    const cloneTemplatePageModalHtml = renderTemplate(cloneTemplatePageModalTemplate, {}, i18n);

    const pageHtml = renderTemplate(themesListTemplate, {
        tab_themes_label: `${i18n.tab_themes} (${allThemes.length})`,
        tab_templates_label: `${i18n.tab_templates} (${props.templateNodes.length})`,
        tab_components_label: `${i18n.tab_components} (${props.componentNodes.length})`,
        tab_md_components_label: t(locale, 'themes.tab_md_components', { count: mdKeys.length }),
        tab_dataset_schemas_label: t(locale, 'themes.tab_dataset_schemas', { count: schemaNodes.length }),
        tab_themes_trash_label: `${t(locale, 'themes.tab_trash')} (${deletedThemes.length})`,
        active_theme_card: '',
        all_themes_grid: allThemesGridHtml,
        template_nodes_content: templateNodesContentHtml,
        component_nodes_content: componentNodesContentHtml,
        md_components_content: mdComponentsContentHtml,
        dataset_schemas_content: datasetSchemasContentHtml,
        themes_trash_content: themesTrashContentHtml,
        modal_export_schema_header: i18n.export_schema_title,
        import_theme_modal: importThemeModalHtml,
        theme_form_modal: themeFormModalHtml,
        theme_fork_modal: themeForkModalHtml,
        clone_template_page_modal: cloneTemplatePageModalHtml
    }, i18n);

    return (
        <AdminLayout
            title={i18n.title}
            {...props}
            clientI18nSections={['themes', 'editor']}
            locale={locale}
        >
            {raw(pageHtml)}
        </AdminLayout>
    );
};
