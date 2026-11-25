import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser, Article, ArticleVersion } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, getUserTimezone, DEFAULT_DEV_HOST, SUPPORTED_LOCALES, renderLocaleOptions, t, parseJson, isFeatureEnabled, getCommercialSnippet } from '../../engine';
import { safeJsonStringify } from '../../engine/render/markdown-parser';
import { renderPastVersionsHtml, renderNewSchemaModalHtml } from '../routes/common';

export interface WikiRelationNode {
    id: string;
    title: string;
    slug: string;
    type: string;
    maturity?: string;
}

export const ContentEditorPage = async (props: {
    type: string;
    node?: Partial<Article> | any;
    article?: Partial<Article>;
    latestVersion?: Partial<ArticleVersion>;
    versions?: ArticleVersion[];
    siteNodes?: WikiRelationNode[];
    templatePages?: Array<{ id: string; title: string; slug: string }>;
    schemaNodes?: Array<{ id: string; title: string; slug: string; summary?: string; metadata?: any }>;
    translationGroups?: Array<{ id: string; name: string }>;
    peerTranslations?: Array<{ id: string; title: string; slug: string; locale: string }>;
    backlinks?: WikiRelationNode[];
    isEdit?: boolean;
    mdComponents?: Record<string, string>;
    sites: Site[];
    currentSiteId: string;
    currentDomain?: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    canUseFeature?: (feature?: string) => boolean;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const domain = props.currentDomain || DEFAULT_DEV_HOST;
    const activeSite = props.sites.find(s => s.id === props.currentSiteId) || props.sites[0];
    const timezone = getUserTimezone(props.currentUser, activeSite);
    const nodeType = props.node?.type === 'micro' ? 'micro' : 'articles';
    const i18n = getAdminI18nSlice(locale, ['editor', 'common', 'nav', nodeType]);

    const [
        contentEditorTemplate,
        versionItemTemplate,
        schemaBuiltinTemplate,
        siteNodeItemTemplate,
        schemaCustomGroupTemplate
    ] = await Promise.all([
        fetchAsset('/admin/pages/content-editor.html'),
        fetchAsset('/admin/snippets/editor-version-item.html'),
        fetchAsset('/admin/snippets/editor-schema-builtin.html'),
        fetchAsset('/admin/snippets/editor-site-node-item.html'),
        fetchAsset('/admin/snippets/editor-schema-custom-group.html')
    ]);
    const node = props.node || {};
    const latestVersion = props.latestVersion || {};
    const siteNodes = props.siteNodes || [];
    const templatePages = props.templatePages || [];
    const backlinks = props.backlinks || [];
    const currentVersionId = node.current_version_id || latestVersion.id;
    const currentVersionNumber = latestVersion.version_number;
    const initialType = node.type || props.type || 'article';

    const pastVersions = (props.versions || []).filter(v => 
        v.id !== currentVersionId && 
        v.id !== latestVersion.id && 
        (currentVersionNumber === undefined || v.version_number !== currentVersionNumber)
    );

    const metaObj = parseJson<Record<string, any>>(node.metadata, {});

    const existingTags: string[] = Array.isArray(metaObj.tags) 
        ? metaObj.tags 
        : (Array.isArray(metaObj.keywords) ? metaObj.keywords : (metaObj.tags || metaObj.keywords || '').split(',').map((s: string) => s.trim()).filter(Boolean));

    const keywords = Array.isArray(metaObj.keywords) ? metaObj.keywords.join(', ') : (metaObj.keywords || '');
    const metaSchemaType = metaObj.schema_type || 'default';
    const currentLocale = node.locale || 'zh-CN';
    const isCustomLocale = !['zh-CN', 'en-US', 'ja-JP', 'de-DE', 'fr-FR'].includes(currentLocale);
    const currentProgress = (node.progress && node.progress !== 'none') ? node.progress : (node.maturity && node.maturity !== 'none' ? node.maturity : '');
    const currentMaturity = currentProgress;
    const nodeVisibility = node.visibility || 'public';
    const isPublicVis = nodeVisibility !== 'private';
    const sourceUrl = metaObj.source_url || '';
    const selectedTemplateId = metaObj.template_id || '';
    const selectedTemplateSlug = metaObj.template_slug || '';
    const currentTemplateObj = templatePages.find(t => t.id === selectedTemplateId || t.slug === selectedTemplateSlug);
    const ogImage = metaObj.og_image || node.cover_image_url || '';
    const currentTemplateLabel = currentTemplateObj ? currentTemplateObj.title : i18n.editor.default_site_template;

    const translationGroups = props.translationGroups || [];
    const peerTranslations = props.peerTranslations || [];
    const currentTransGroup = translationGroups.find(g => g.id === node.translation_group_id);

    const vcsVersionsMap: Record<string, string> = {};
    pastVersions.forEach(v => {
        vcsVersionsMap[v.id] = v.content_raw || '';
    });

    const localeLabelMap: Record<string, string> = {
        ...SUPPORTED_LOCALES,
        'ja-JP': i18n.editor.locale_ja_option,
        'de-DE': 'Deutsch',
        'fr-FR': 'Français',
        '__custom__': i18n.editor.custom_locale_option
    };

    const schemaNodes = props.schemaNodes || [];
    const schemaLabelMap: Record<string, string> = {
        'default': i18n.editor.schema_standard
    };
    schemaNodes.forEach(s => {
        schemaLabelMap[s.slug] = `${s.title} (${s.slug})`;
    });

    const dropCls = 'px-2.5 py-1.5 hover:bg-[var(--admin-surface-hover)] cursor-pointer';
    const dropItem = (val: string, label: string, fn: string, sub = '', subClass = 'text-[var(--admin-text-muted)]') =>
        `<div data-value="${val}" data-label="${label}" onclick="${fn}('${val}', '${label}')" class="${dropCls} flex items-center justify-between"><span class="truncate">${label}</span>${sub ? `<span class="text-[10px] font-mono ${subClass}">(${sub})</span>` : ''}</div>`;

    const escapeJs = (s: string) => (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const templateOptionsHtml = `<div data-value="" data-label="${i18n.editor.default_site_template}" onclick="selectTemplateOption('', '', '${escapeJs(i18n.editor.default_site_template)}')" class="${dropCls} font-bold text-amber-700 dark:text-amber-400">${i18n.editor.default_site_template}</div>`
        + templatePages.map(tpl => `<div data-value="${tpl.id}" data-label="${tpl.title}" onclick="selectTemplateOption('${tpl.id}', '${tpl.slug}', '${escapeJs(tpl.title)}')" class="${dropCls} flex items-center justify-between"><span class="truncate">${tpl.title}</span><span class="text-[10px] font-mono text-stone-400">(${tpl.slug})</span></div>`).join('');

    const tagChipsHtml = existingTags.map(tag =>
        `<span class="inline-flex items-center space-x-1 bg-[var(--admin-accent-soft)] text-[var(--admin-accent-text)] border border-[var(--admin-accent-border)] px-2 py-0.5 rounded-md text-xs font-bold"><span>#${tag}</span><button type="button" onclick="removeTagChip('${tag}')" class="hover:text-red-600 ml-1">×</button></span>`
    ).join('');

    const schemaDropdownOptionsHtml = `<div data-value="default" data-label="${schemaLabelMap['default']}" onclick="selectSchemaOption('default', '${escapeJs(schemaLabelMap['default'])}')" class="${dropCls}">${schemaLabelMap['default']}</div>`
        + schemaNodes.map(s =>
            `<div id="schema-item-${s.id}" data-value="${s.slug}" data-label="${s.title}" onclick="selectSchemaOption('${s.slug}', '${escapeJs(s.title)} (${s.slug})')" class="${dropCls} flex items-center justify-between gap-2"><span class="truncate font-medium">${s.title}</span><span class="text-[10px] text-[var(--admin-accent-text)] font-mono shrink-0">${s.slug}</span></div>`
        ).join('');

    const builtinSchemaHtml = renderTemplate(schemaBuiltinTemplate, {
        class_default: metaSchemaType === 'default' || !schemaLabelMap[metaSchemaType] ? '' : 'hidden',
        desc_default: i18n.editor.schema_standard_desc
    });

    const inputCls = 'w-full h-7 bg-[var(--admin-canvas)] border border-[var(--admin-border)] rounded-md px-2 text-xs text-[var(--admin-text)] outline-none focus:border-[var(--admin-accent)]';
    const customSchemasHtml = schemaNodes.map(s => {
        const sMeta = parseJson<Record<string, any>>(s.metadata, {});
        const fields = Array.isArray(sMeta.fields) ? sMeta.fields : [];
        const isSelected = metaSchemaType === s.slug;
        const safeSlug = s.slug.replace(/[^a-zA-Z0-9_-]/g, '_');
        const fieldsHtml = fields.length === 0
            ? `<div class="text-[11px] text-stone-400 italic">${i18n.editor.no_schema_fields}</div>`
            : fields.map((f: any) => `<div><label class="block text-[10px] font-bold text-stone-600 dark:text-stone-300 mb-0.5">${f.label || f.name} ${f.name ? `<span class="font-mono text-stone-400 font-normal">(${f.name})</span>` : ''}</label><input type="${f.type === 'url' ? 'url' : (f.type === 'number' ? 'number' : 'text')}" name="meta_${f.name}" value="${metaObj[f.name] || ''}" placeholder="${f.label || f.name}" class="${inputCls}" /></div>`).join('');

        const isCustomSchema = Boolean(s.metadata?.is_custom || s.metadata?.source === 'custom');
        return renderTemplate(schemaCustomGroupTemplate, {
            safe_slug: safeSlug,
            id: s.id,
            title: s.title,
            slug: s.slug,
            selected_class: isSelected ? '' : 'hidden',
            delete_btn_class: isCustomSchema ? 'inline-flex' : 'hidden',
            btn_delete_schema: i18n.editor.btn_delete_schema,
            fields_html: fieldsHtml
        });
    }).join('');

    const schemaFieldsHtml = builtinSchemaHtml + customSchemasHtml;

    const transGroupsOptionsHtml = translationGroups.map(g => `<div id="trans-group-item-${g.id}" onclick="selectTransGroup('${g.id}', '${g.name}')" class="px-2.5 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-700 cursor-pointer flex justify-between items-center"><span class="truncate font-semibold">${g.name}</span><button type="button" onclick="event.stopPropagation(); deleteTransGroup('${g.id}')" class="text-stone-400 hover:text-red-500 ml-2" title="${i18n.editor.delete_trans_group}"><span class="material-symbols-outlined text-[14px]">delete</span></button></div>`).join('');

    const peerTranslationsHtml = peerTranslations.length > 0 ? `<div class="space-y-1 pt-1"><div class="text-[10px] text-[var(--admin-text-muted)] font-bold uppercase tracking-wider">${i18n.editor.related_languages}</div><div class="space-y-1">${peerTranslations.map(p => `<a href="/admin/articles/edit/${p.id}" class="flex items-center justify-between p-1.5 rounded-lg bg-[var(--admin-surface)] hover:bg-[var(--admin-surface-hover)] border border-[var(--admin-border)] text-[11px] text-[var(--admin-text)] transition"><span class="truncate">${p.title}</span><span class="font-mono text-[10px] bg-[var(--admin-accent-soft)] text-[var(--admin-accent-text)] px-1 rounded ml-1 shrink-0">${p.locale}</span></a>`).join('')}</div></div>` : '';

    const backlinksListHtml = backlinks.length === 0
        ? `<span class="text-stone-400 text-[11px]">${i18n.editor.no_backlinks}</span>`
        : backlinks.map(b => `<a href="/admin/articles/edit/${b.id}" class="block text-stone-700 dark:text-stone-300 hover:text-amber-600 hover:bg-stone-100 dark:hover:bg-stone-800 p-1.5 rounded-lg truncate" title="/${b.slug}">← ${b.title}</a>`).join('');

    const validSiteNodes = siteNodes.filter(sn => (sn.slug || '').trim() || (sn.title || '').trim());
    const siteNodesHtml = validSiteNodes.length === 0
        ? `<div class="text-stone-400 text-[11px] p-2 text-center">${i18n.editor.no_other_nodes}</div>`
        : validSiteNodes.map(sn => renderTemplate(siteNodeItemTemplate, {
            slug: sn.slug || sn.title,
            title: (sn.title || '').trim() || sn.slug,
            quick_insert: i18n.editor.quick_insert_wiki
        })).join('');

    const pastVersionsHtml = renderPastVersionsHtml(pastVersions, versionItemTemplate, locale, timezone, i18n.editor, i18n.common.delete);

    const isMicro = initialType === 'micro';
    const backHref = isMicro ? '/admin/micros' : '/admin/articles';
    const nodeFolder = metaObj.folder !== undefined ? metaObj.folder : '';

    const sidebarMicroTemplate = await fetchAsset('/admin/snippets/editor-sidebar-micro.html');
    const sidebarArticleTemplate = await fetchAsset('/admin/snippets/editor-sidebar-article.html');

    const cleanArticleSummary = String(node.summary || '').trim();
    const rawPubAt = String((node as any).published_at || '').trim();
    const publishedAtTs = rawPubAt ? Date.parse(rawPubAt) : NaN;
    const publishedAtInput = Number.isNaN(publishedAtTs) ? '' : new Date(publishedAtTs).toISOString().slice(0, 16);
    const metaAliasesText = Array.isArray(metaObj.aliases) ? metaObj.aliases.join('\n') : '';

    const canUseCommercialApi = props.canUseFeature ? props.canUseFeature('cms:api_token_bridge') : false;
    const visTemplateData = { vis_api_only_selected: nodeVisibility === 'api_only' ? 'selected' : '' };
    const slotArticleApiOnly = canUseCommercialApi
        ? (() => { const tpl = getCommercialSnippet('editor-article-api-only.html'); return tpl ? renderTemplate(tpl, visTemplateData, i18n) : ''; })()
        : '';
    const slotMicroApiOnly = canUseCommercialApi
        ? (() => { const tpl = getCommercialSnippet('editor-micro-api-only.html'); return tpl ? renderTemplate(tpl, visTemplateData, i18n) : ''; })()
        : '';

    const inspectorSidebarHtml = isMicro
        ? renderTemplate(sidebarMicroTemplate, {
            node_id: node.id || '',
            convert_article_class: props.isEdit && node.id ? '' : 'hidden',
            node_status: node.status || 'published',
            status_published_selected: (node.status || 'published') === 'published' ? 'selected' : '',
            status_draft_selected: node.status === 'draft' ? 'selected' : '',
            node_visibility: nodeVisibility,
            vis_public_selected: nodeVisibility === 'public' ? 'selected' : '',
            slot_micro_api_only_option: slotMicroApiOnly,
            vis_private_selected: nodeVisibility === 'private' ? 'selected' : '',
            current_locale: currentLocale,
            locale_options_html: renderLocaleOptions(currentLocale),
            published_at_input: publishedAtInput,
            node_folder: nodeFolder,
            existing_tags_string: existingTags.join(','),
            current_progress: currentProgress,
            current_maturity: currentMaturity,
            field_progress: i18n.articles?.field_progress || i18n.field_progress || '',
            progress_badge: i18n.articles?.progress_badge || i18n.progress_badge || '',
            progress_placeholder: i18n.articles?.progress_placeholder || i18n.progress_placeholder || '',
            versions_count: i18n.t('editor.versions_count', { count: pastVersions.length }),
            past_versions_html: pastVersionsHtml,
            soft_delete_btn_class: (props.isEdit && node.id) ? '' : 'hidden',
            btn_trash_item: i18n.common?.btn_move_to_trash || i18n.editor.btn_trash_article
        }, i18n)
        : renderTemplate(sidebarArticleTemplate, {
            source_url: sourceUrl,
            current_template_label: currentTemplateLabel,
            template_options_html: templateOptionsHtml,
            current_locale_label: localeLabelMap[currentLocale] || currentLocale,
            custom_locale_class: isCustomLocale ? '' : 'hidden',
            node_slug: node.slug || '',
            published_at_input: publishedAtInput,
            meta_aliases_text: metaAliasesText,
            status_published_selected: (node.status || 'published') === 'published' ? 'selected' : '',
            status_draft_selected: node.status === 'draft' ? 'selected' : '',
            node_visibility: nodeVisibility,
            vis_public_selected: nodeVisibility === 'public' ? 'selected' : '',
            slot_article_api_only_option: slotArticleApiOnly,
            vis_password_selected: nodeVisibility === 'password' ? 'selected' : '',
            vis_private_selected: nodeVisibility === 'private' ? 'selected' : '',
            password_box_class: nodeVisibility === 'password' ? '' : 'hidden',
            access_password: String(metaObj.access_password || ''),
            domain,
            node_slug_preview: node.slug || 'slug',
            tag_chips_html: tagChipsHtml,
            node_summary: cleanArticleSummary,
            keywords,
            og_image: ogImage,
            og_image_preview_class: ogImage ? '' : 'hidden',
            og_use_first_image_checked: (metaObj.og_use_first_image === true || metaObj.og_use_first_image === '1') ? 'checked' : '',
            current_schema_label: schemaLabelMap[metaSchemaType] || metaSchemaType,
            schema_dropdown_options_html: schemaDropdownOptionsHtml,
            schema_fields_html: schemaFieldsHtml,
            current_trans_group_name: currentTransGroup ? currentTransGroup.name : i18n.editor.trans_group_not_joined,
            leave_trans_group_class: node.translation_group_id ? '' : 'hidden',
            trans_groups_options_html: transGroupsOptionsHtml,
            peer_translations_html: peerTranslationsHtml,
            outgoing_count_tag: i18n.t('editor.outgoing_count_tag', { count: 0 }),
            backlinks_count_tag: i18n.t('editor.backlinks_count_tag', { count: backlinks.length }),
            backlinks_count: backlinks.length,
            backlinks_list_html: backlinksListHtml,
            site_nodes_html: siteNodesHtml,
            topology_link_class: isFeatureEnabled('topology') ? '' : 'hidden',
            soft_delete_btn_class: (props.isEdit && node.id) ? '' : 'hidden',
            versions_count: i18n.t('editor.versions_count', { count: pastVersions.length }),
            past_versions_html: pastVersionsHtml,
            current_locale: currentLocale,
            current_progress: currentProgress,
            current_maturity: currentMaturity
        }, i18n);

    const modalNewSchemaHtml = isMicro
        ? ''
        : await renderNewSchemaModalHtml(locale, props.canUseFeature, i18n.common?.cancel || '');

    const previewLabel = i18n.articles?.preview || i18n.common?.preview || '';
    const previewTopBtnHtml = isMicro
        ? ''
        : `<button type="button" id="article-preview-top-btn" onclick="const s = document.getElementById('slug-input')?.value || ''; const t = document.getElementById('article-title-input')?.value || ''; window.openSandboxedPreview('/' + s, t);" class="h-8 bg-[var(--admin-surface)] hover:bg-[var(--admin-surface-hover)] text-[var(--admin-text)] font-semibold text-[13px] px-2.5 md:px-3 rounded-lg border border-[var(--admin-border)] transition-colors duration-75 flex items-center space-x-1.5 cursor-pointer" title="${previewLabel}"><span class="material-symbols-outlined text-[16px]">visibility</span><span class="hidden sm:inline">${previewLabel}</span></button>`;

    const pageHtml = renderTemplate(contentEditorTemplate, {
        back_href: backHref,
        nav_module_label: initialType === 'micro' ? (i18n.nav?.micros || i18n.nav?.micro || '') : (i18n.nav?.articles || ''),
        preview_top_btn_html: previewTopBtnHtml,
        inspector_sidebar_html: inspectorSidebarHtml,
        modal_new_schema: modalNewSchemaHtml,
        node_id: node.id || '',
        site_id: props.currentSiteId,
        is_edit: props.isEdit ? 'true' : 'false',
        initial_type: initialType,
        current_locale: currentLocale,
        current_progress: currentProgress,
        current_maturity: currentMaturity,
        selected_template_id: selectedTemplateId,
        selected_template_slug: selectedTemplateSlug,
        meta_schema_type: metaSchemaType,
        node_status: node.status || 'published',
        status_published_selected: (node.status || 'published') === 'published' ? 'selected' : '',
        status_draft_selected: node.status === 'draft' ? 'selected' : '',
        node_visibility: nodeVisibility,
        existing_tags_string: existingTags.join(','),
        translation_group_id: node.translation_group_id || '',
        node_title: node.title || '',
        latest_content_raw: latestVersion.content_raw || '',
        preview: i18n.articles?.preview || i18n.common?.preview || '',
        preview_label: i18n.t('editor.preview_label', { version: 1 }),
        vcs_versions_json: safeJsonStringify(vcsVersionsMap),
        article_tags_json: safeJsonStringify(existingTags)
    }, i18n).replace('WALNUT_MD_COMPONENTS_JSON_PLACEHOLDER', () => safeJsonStringify(props.mdComponents || {}));

    return (
        <AdminLayout
            title={props.isEdit ? `${isMicro ? (i18n.editor.title_edit_micro || '') : i18n.editor.title_edit}: ${node.title || ''}` : `${isMicro ? (i18n.editor.title_new_micro || '') : i18n.editor.title_new}`}
            {...props}
            clientI18nSections={['editor', 'articles', 'micro', 'schemas', 'media']}
            locale={locale}
        >
            {raw(pageHtml)}
        </AdminLayout>
    );
};
