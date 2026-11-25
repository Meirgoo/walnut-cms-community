import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser, Page, PageVersion } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, getUserTimezone, DEFAULT_DEV_HOST, SUPPORTED_LOCALES, ENGINE_CORE_VERSION, t, parseJson, getCommercialSnippet } from '../../engine';
import { safeJsonStringify } from '../../engine/render/markdown-parser';
import { buildThemePreviewIframeSrcdoc } from './ThemesList';
import { renderPastVersionsHtml, serializePageContractContext } from '../routes/common';

export const PageEditorPage = async (props: {
    node?: Page | Partial<Page> | any;
    page?: Page;
    latestVersion?: PageVersion | null;
    versions?: any[];
    templates?: any[];
    existingPages: any[];
    templatePages: any[];
    templateSinglePages?: any[];
    themeComponents: any[];
    datasetCollections?: any[];
    datasetSchemas?: any[];
    siteTaxonomy?: any;
    recentMedia?: Array<{ url: string; filename: string; alt: string }>;
    externalExtensions?: Array<{ slug: string; name: string }>;
    slotQuotas?: Record<string, number | null>;
    activeThemeId?: string;
    activeThemeSlug?: string;
    translationGroups?: Array<{ id: string; name: string }>;
    peerTranslations?: Array<{ id: string; title: string; slug: string; locale: string }>;
    sites: Site[];
    currentSiteId: string;
    currentDomain?: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    canUseFeature?: (feature?: string) => boolean;
    isEdit?: boolean;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const isCommercial = props.canUseFeature ? props.canUseFeature('cms:*') : false;
    const canUseWorkerBridge = props.canUseFeature ? props.canUseFeature('cms:worker_bridge') : false;
    const hasPublicExtensions = canUseWorkerBridge && Array.isArray(props.externalExtensions) && props.externalExtensions.length > 0;
    const node = props.page || props.node || ({} as any);
    const existingPages = props.existingPages || [];
    const templatePages = props.templatePages || props.templateSinglePages || [];
    const themeComponents = props.themeComponents || [];
    const i18n = getAdminI18nSlice(locale, ['pages', 'editor', 'common', 'nav']);
    const extIslandCardTpl = hasPublicExtensions ? getCommercialSnippet('page-editor-ext-island-card.html') : '';
    const slotExtIslandCard = extIslandCardTpl
        ? renderTemplate(extIslandCardTpl, {
            ext_island_title: i18n.pages.ext_island_title,
            ext_island_desc: i18n.pages.ext_island_desc
        })
        : '';

    const [pageEditorTemplate, nestedCompPickerModalTemplate, versionItemTemplate] = await Promise.all([
        fetchAsset('/admin/pages/page-editor.html'),
        fetchAsset('/admin/modals/nested-comp-picker-modal.html'),
        fetchAsset('/admin/snippets/editor-version-item.html')
    ]);

    const sites = props.sites || [];
    const currentSite = sites.find(s => s.id === props.currentSiteId) || sites[0];
    const timezone = getUserTimezone(props.currentUser, currentSite);
    const domain = currentSite?.primary_domain || DEFAULT_DEV_HOST;
    const metaObj = parseJson<Record<string, any>>(node.metadata, {});

    const pageLocale = node.locale || 'zh-CN';
    const parentId = node.parent_id || '';
    const pageStatus = node.status || 'published';
    const pageType = metaObj.page_type || 'single';
    const redirectUrl = metaObj.redirect_url || '';
    const redirectCode = metaObj.redirect_code || '301';
    const canonicalUrl = metaObj.canonical_url || '';
    const metaRobots = metaObj.robots || 'index, follow';
    const ogImage = metaObj.og_image || '';
    const accessPermission = metaObj.access_permission || 'public';
    const templatePageId = metaObj.template_page_id || metaObj.template_id || metaObj.template_slug || '';
    const translationGroupId = metaObj.translation_group_id || '';
    const translationGroups = props.translationGroups || [];
    const peerTranslations = props.peerTranslations || [];
    const currentTransGroup = translationGroups.find(g => g.id === translationGroupId);
    const transGroupsOptionsHtml = translationGroups.length === 0
        ? `<div class="px-3 py-2 text-xs text-stone-400 italic">${i18n.editor.trans_group_not_joined}</div>`
        : translationGroups.map(g =>
            `<div data-value="${g.id}" data-label="${g.name}" onclick="selectPageTransGroupOption('${g.id}', '${g.name.replace(/'/g, "\\'")}')" class="px-3 py-2 hover:bg-stone-50 dark:hover:bg-stone-700 cursor-pointer text-xs font-medium">${g.name}</div>`
        ).join('');
    const peerTranslationsHtml = peerTranslations.length === 0
        ? `<div class="text-[11px] text-stone-400 italic py-1">${i18n.editor.trans_peers_empty || i18n.editor.trans_group_not_joined}</div>`
        : peerTranslations.map(p =>
            `<a href="/admin/pages/edit/${p.id}" class="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-stone-50 dark:bg-stone-900 border border-stone-200/70 dark:border-stone-700 hover:border-amber-500 text-xs transition-colors duration-75"><span class="truncate font-semibold text-stone-800 dark:text-stone-200">${p.title}</span><span class="px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 font-mono text-[10px] font-bold shrink-0 ml-2">${p.locale}</span></a>`
        ).join('');
    const addTranslationUrl = `/admin/pages/new?translation_group_id=${encodeURIComponent(translationGroupId)}&source_id=${encodeURIComponent(node.id || '')}`;
    // Only master layouts with @slot:page_content can wrap single pages; blueprint pages without the slot are excluded from the dropdown.
    const hasPageContentSlot = (p: any): boolean => {
        const m = parseJson<Record<string, any>>(p.metadata, {});
        const blks = Array.isArray(p.blocks) ? p.blocks : (Array.isArray(m.blocks) ? m.blocks : parseJson<any[]>(p.content_raw, []));
        return Array.isArray(blks) && blks.some((b: any) => b && (b.component === '@slot:page_content' || b.component === 'slot:page_content' || b.id === '@slot:page_content'));
    };
    const eligibleTemplatePages = templatePages.filter(p => (!node?.id || p.id !== node.id) && hasPageContentSlot(p));

    const noTemplateLabel = t(locale, 'pages.no_template_standalone');
    const currentTplPage = eligibleTemplatePages.find(p => p.id === templatePageId || p.slug === templatePageId);
    const templatePageLabel = currentTplPage ? `${currentTplPage.title} (/${currentTplPage.slug})` : noTemplateLabel;

    const mapTpl = (items: any[], isPage = false) => items.map((x: any) => {
        const m = parseJson<Record<string, any>>(x.metadata, {});
        let blks = Array.isArray(x.blocks) ? x.blocks : (Array.isArray(m.blocks) ? m.blocks : []);
        if (isPage && blks.length === 0 && typeof x.content_raw === 'string' && x.content_raw.trim().startsWith('[')) {
            blks = parseJson(x.content_raw, []);
        }
        return { id: x.id || x.slug, slug: x.slug, title: x.title || x.name || x.slug, layout: x.layout || m.layout || 'default', blocks: blks };
    });
    const allEditorTemplates = mapTpl(eligibleTemplatePages, true);

    const pageTypeLabels: Record<string, string> = {
        single: i18n.pages.type_single_option || i18n.pages.type_single || '',
        template: i18n.pages.type_template_option || i18n.pages.type_template || '',
        redirect: i18n.pages.type_redirect_option || i18n.pages.type_redirect || ''
    };

    const pageLocaleOptionsHtml = Object.entries(SUPPORTED_LOCALES).map(([val, label]) => `
        <div data-value="${val}" data-label="${label}" onclick="selectPageLocaleOption('${val}', '${label}')" class="px-3 py-2 hover:bg-[var(--admin-surface-hover)] cursor-pointer">${label}</div>
    `).join('');

    // Exclude template and redirect pages so only single pages can serve as parent routes.
    const eligibleParentPages = existingPages.filter(p => {
        const meta = parseJson<Record<string, any>>(p.metadata, {});
        const pType = meta.page_type || 'single';
        return pType === 'single';
    });

    const currentParentPage = eligibleParentPages.find(p => p.id === parentId);
    const parentLabel = currentParentPage ? `${currentParentPage.title} (/${currentParentPage.slug})` : i18n.pages.no_parent;
    const parentSlugPrefix = currentParentPage && currentParentPage.slug ? `/${currentParentPage.slug.replace(/^\/+|\/+$/g, '')}` : '';

    const optRow = (val: string, label: string, sub = '', fn = 'selectTemplatePageOption', subClass = 'text-stone-400', extraArg = '') =>
        `<div data-value="${val}" data-label="${label}" onclick="${fn}('${val}', '${label}'${extraArg ? `, '${extraArg}'` : ''})" class="px-3 py-2 hover:bg-stone-50 dark:hover:bg-stone-700 cursor-pointer flex items-center justify-between"><span class="truncate font-medium">${label}</span>${sub ? `<span class="text-[10px] font-mono ${subClass}">${sub}</span>` : ''}</div>`;

    const tplSection = (title: string, list: any[], isTheme = false) => list.length === 0 ? '' :
        `<div class="px-3 pt-2 pb-1 text-[10px] font-black text-stone-400 uppercase tracking-wider border-t border-stone-100 dark:border-stone-700/60">${title}</div>` +
        list.map(t => optRow(t.id, t.title, `/${t.slug}`, 'selectTemplatePageOption', isTheme ? 'text-amber-600 dark:text-amber-400 font-bold' : 'text-stone-400')).join('');

    const templatePageOptionsHtml = `<div data-value="" data-label="${noTemplateLabel}" onclick="selectTemplatePageOption('', '${noTemplateLabel}')" class="px-3 py-2 hover:bg-stone-50 dark:hover:bg-stone-700 cursor-pointer font-bold text-amber-700 dark:text-amber-400">${noTemplateLabel}</div>`
        + (eligibleTemplatePages.length > 0
            ? tplSection(t(locale, 'pages.type_template_option'), eligibleTemplatePages, false)
            : `<div class="px-3 py-2 text-[11px] text-stone-400 dark:text-stone-500 italic border-t border-stone-100 dark:border-stone-700/60">${t(locale, 'pages.no_template_pages_hint')}</div>`);

    const parentOptionsHtml = `<div data-value="" data-label="${i18n.pages.no_parent}" onclick="selectParentPageOption('', '${i18n.pages.no_parent}', '')" class="px-3 py-2 hover:bg-stone-50 dark:hover:bg-stone-700 cursor-pointer font-bold text-amber-700 dark:text-amber-400">${i18n.pages.no_parent}</div>`
        + eligibleParentPages.map(p => optRow(p.id, p.title, `/${p.slug}`, 'selectParentPageOption', 'text-stone-400', p.slug)).join('');

    const rawSlug = node.slug || '';
    let nodeSlug: string;
    if (pageType === 'template') {
        nodeSlug = rawSlug || `tpl-${Date.now().toString(36)}`;
    } else if (rawSlug === '/' || rawSlug === 'index') {
        nodeSlug = '/';
    } else {
        nodeSlug = rawSlug.replace(/^\/+/, '');
    }

    const cleanParent = parentSlugPrefix ? parentSlugPrefix.replace(/^\/+|\/+$/g, '') : '';
    const cleanSelf = (nodeSlug === '/' || !nodeSlug) ? '' : nodeSlug.replace(/^\/+|\/+$/g, '');
    const fullPreviewPath = pageType === 'template' ? `/${nodeSlug}` : (cleanParent ? (cleanSelf ? `/${cleanParent}/${cleanSelf}` : `/${cleanParent}`) : (cleanSelf ? `/${cleanSelf}` : '/'));

    let accessPermissionLabel = i18n.pages.perm_public;
    if (accessPermission === 'members_only') accessPermissionLabel = i18n.pages.perm_members;
    else if (accessPermission === 'password_protected') accessPermissionLabel = i18n.pages.perm_password;
    else if (accessPermission === 'admin_only') accessPermissionLabel = i18n.pages.perm_admin_option;

    const nestedCompPickerModalHtml = renderTemplate(nestedCompPickerModalTemplate, {}, i18n);

    let initialBlocksJson = '[]';
    const verRaw = props.latestVersion?.content_raw;
    if (typeof verRaw === 'string' && verRaw.trim().length > 0 && (verRaw.trim().startsWith('[') || verRaw.trim().startsWith('{'))) {
        initialBlocksJson = verRaw.trim();
    } else if (typeof (node as any).content_raw === 'string' && (node as any).content_raw.trim().startsWith('[')) {
        initialBlocksJson = (node as any).content_raw.trim();
    } else if (Array.isArray(metaObj.blocks) && metaObj.blocks.length > 0) {
        initialBlocksJson = JSON.stringify(metaObj.blocks, null, 2);
    }

    const cleanSeoSummary = (node.summary || '').trim().startsWith('[') ? '' : (node.summary || '').trim();
    const rawPubAt = String((node as any).published_at || '').trim();
    const pubAtTs = rawPubAt ? Date.parse(rawPubAt) : NaN;
    const publishedAtInput = Number.isNaN(pubAtTs) ? '' : new Date(pubAtTs).toISOString().slice(0, 16);
    const metaAliasesText = Array.isArray(metaObj.aliases) ? metaObj.aliases.join('\n') : '';

    const themeAssetPrefix = props.activeThemeSlug ? `/theme/${props.activeThemeSlug}` : '';
    const {
        componentsPayload: enrichedThemeComponents,
        templatesPayload: serializedTemplates,
        datasetsPayload: serializedDatasets
    } = serializePageContractContext({
        themeComponents,
        templatePages: allEditorTemplates,
        datasetCollections: props.datasetCollections || [],
        datasetSchemas: props.datasetSchemas || [],
        siteTaxonomy: props.siteTaxonomy,
        recentMedia: props.recentMedia || [],
        externalExtensions: hasPublicExtensions ? (props.externalExtensions || []) : [],
        extIslandEnabled: hasPublicExtensions,
        slotQuotas: props.slotQuotas || {},
        includeTemplateHtmlAndPreview: true,
        themeAssetPrefix,
        buildPreviewSrcdoc: (h, prefix) => buildThemePreviewIframeSrcdoc(h, prefix, true, true)
    });

    const currentVerId = node.current_version_id || props.latestVersion?.id;
    const currentVerNum = props.latestVersion?.version_number;
    const pastVersions = (props.versions || []).filter((v: any) =>
        v.id !== currentVerId &&
        v.id !== props.latestVersion?.id &&
        (currentVerNum === undefined || v.version_number !== currentVerNum)
    );
    const vcsVersionsMap: Record<string, string> = {};
    pastVersions.forEach((v: any) => {
        vcsVersionsMap[v.id] = v.content_raw || '[]';
    });
    const pastVersionsHtml = renderPastVersionsHtml(pastVersions, versionItemTemplate, locale, timezone, i18n.editor, i18n.common.delete);

    const pageContractModalTemplate = await fetchAsset('/admin/modals/page-contract-modal.html');
    const pageContractModalHtml = renderTemplate(pageContractModalTemplate, {
        page_contract_ctx_mode: 'editor'
    }, i18n);

    const pageHtml = renderTemplate(pageEditorTemplate, {
        node_id: node.id || '',
        site_id: props.currentSiteId,
        is_edit: props.isEdit ? 'true' : 'false',
        page_type: pageType,
        template_page_id: templatePageId,
        parent_id: parentId,
        page_locale: pageLocale,
        page_status: pageStatus,
        meta_robots: metaRobots,
        access_permission: accessPermission,
        node_title: node.title || '',
        btn_save_page: props.isEdit ? i18n.pages.btn_save_page : i18n.pages.btn_create_page,
        page_summary: initialBlocksJson,
        page_type_label: pageTypeLabels[pageType] || pageType,
        template_box_class: pageType === 'single' ? '' : 'hidden',
        template_page_label: templatePageLabel,
        template_page_options_html: templatePageOptionsHtml,
        locale_box_class: pageType === 'redirect' ? 'hidden' : '',
        page_locale_label: (SUPPORTED_LOCALES as Record<string, string>)[pageLocale] || pageLocale,
        page_locale_options_html: pageLocaleOptionsHtml,
        parent_box_class: (pageType === 'template' || pageType === 'redirect') ? 'hidden' : '',
        parent_label: parentLabel,
        parent_options_html: parentOptionsHtml,
        parent_slug_prefix: parentSlugPrefix,
        slug_box_class: pageType === 'template' ? 'hidden' : '',
        node_slug: nodeSlug,
        domain: domain,
        full_preview_path: fullPreviewPath,
        published_at_input: publishedAtInput,
        meta_aliases_text: metaAliasesText,
        redirect_box_class: pageType === 'redirect' ? '' : 'hidden',
        redirect_url: redirectUrl,
        redirect_code: redirectCode,
        redirect_code_label: redirectCode === '302' ? i18n.pages.redirect_302 : i18n.pages.redirect_301,
        seo_section_class: (pageType === 'template' || pageType === 'redirect') ? 'hidden' : '',
        node_summary: cleanSeoSummary,
        canonical_url: canonicalUrl,
        og_image: ogImage,
        og_image_preview_class: ogImage ? '' : 'hidden',
        page_status_label: pageStatus === 'published' ? i18n.pages.status_online : (pageStatus === 'scheduled' ? i18n.pages.status_scheduled : i18n.pages.status_hidden),
        scheduled_option_class: isCommercial ? '' : 'hidden',
        scheduled_box_class: (isCommercial && pageStatus === 'scheduled') ? '' : 'hidden',
        meta_scheduled_at: metaObj.scheduled_at || '',
        access_permission_label: accessPermissionLabel,
        nested_comp_picker_modal: nestedCompPickerModalHtml,
        translation_group_id: translationGroupId,
        current_trans_group_name: currentTransGroup ? currentTransGroup.name : i18n.editor.trans_group_not_joined,
        leave_trans_group_class: translationGroupId ? '' : 'hidden',
        trans_groups_options_html: transGroupsOptionsHtml,
        peer_translations_html: peerTranslationsHtml,
        add_translation_url: addTranslationUrl,
        add_translation_btn_class: translationGroupId ? '' : 'hidden',
        theme_components_json: safeJsonStringify(enrichedThemeComponents),
        theme_templates_json: safeJsonStringify(serializedTemplates),
        page_contract_modal: pageContractModalHtml,
        slot_ext_island_card: slotExtIslandCard,
        versions_count: i18n.t('editor.versions_count', { count: pastVersions.length }),
        past_versions_html: pastVersionsHtml,
        vcs_versions_json: safeJsonStringify(vcsVersionsMap),
        soft_delete_btn_class: (props.isEdit && node.id) ? '' : 'hidden',
        page_datasets_json: safeJsonStringify(serializedDatasets),
        engine_version: ENGINE_CORE_VERSION
    }, i18n);

    return (
        <AdminLayout
            title={props.isEdit ? `${i18n.pages.edit_title}: ${node.title || ''}` : `${i18n.pages.new_title}`}
            {...props}
            clientI18nSections={['pages', 'editor']}
            locale={locale}
        >
            {raw(pageHtml)}
        </AdminLayout>
    );
};
