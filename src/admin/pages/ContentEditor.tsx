import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser, Article, ArticleVersion } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, formatSiteDateTime, getUserTimezone, DEFAULT_DEV_HOST, SUPPORTED_LOCALES, renderLocaleOptions, t, parseJson, isFeatureEnabled } from '../../engine';
import { safeJsonStringify } from '../../engine/render/markdown-parser';

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
    const i18n = getAdminI18nSlice(locale, ['editor', 'common', nodeType]);

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

    const typeLabelMap: Record<string, { label: string; icon: string; badge: string }> = {
        article: { label: i18n.editor.type_article, icon: 'article', badge: 'Article' },
        micro: { label: i18n.editor.type_micro || 'Micro', icon: 'lightbulb', badge: 'Micro' }
    };

    const currentTypeConfig = typeLabelMap[initialType] || typeLabelMap.article;

    const localeLabelMap: Record<string, string> = {
        ...SUPPORTED_LOCALES,
        '__custom__': i18n.editor.custom_locale_option
    };

    const schemaNodes = props.schemaNodes || [];
    const schemaLabelMap: Record<string, string> = {
        'default': i18n.editor.schema_standard,
        'game': i18n.editor.schema_game,
        'book': i18n.editor.schema_book
    };
    schemaNodes.forEach(s => {
        schemaLabelMap[s.slug] = `${s.title} (${s.slug})`;
    });

    const dropCls = 'px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-700 cursor-pointer';
    const dropItem = (val: string, label: string, fn: string, sub = '', subClass = 'text-slate-400') =>
        `<div data-value="${val}" data-label="${label}" onclick="${fn}('${val}', '${label}')" class="${dropCls} flex items-center justify-between"><span class="truncate">${label}</span>${sub ? `<span class="text-[10px] font-mono ${subClass}">(${sub})</span>` : ''}</div>`;

    const escapeJs = (s: string) => (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const templateOptionsHtml = `<div data-value="" data-label="${i18n.editor.default_site_template}" onclick="selectTemplateOption('', '', '${escapeJs(i18n.editor.default_site_template)}')" class="${dropCls} font-bold text-emerald-700 dark:text-emerald-400">${i18n.editor.default_site_template}</div>`
        + templatePages.map(tpl => `<div data-value="${tpl.id}" data-label="${tpl.title}" onclick="selectTemplateOption('${tpl.id}', '${tpl.slug}', '${escapeJs(tpl.title)}')" class="${dropCls} flex items-center justify-between"><span class="truncate">${tpl.title}</span><span class="text-[10px] font-mono text-slate-400">(${tpl.slug})</span></div>`).join('');

    const tagChipsHtml = existingTags.map(tag =>
        `<span class="inline-flex items-center space-x-1 bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 px-2 py-0.5 rounded-lg text-xs font-bold"><span>#${tag}</span><button type="button" onclick="removeTagChip('${tag}')" class="hover:text-red-600 ml-1">×</button></span>`
    ).join('');

    const schemaDropdownOptionsHtml = ['default', 'game', 'book']
        .map(k => `<div data-value="${k}" data-label="${schemaLabelMap[k]}" onclick="selectSchemaOption('${k}', '${schemaLabelMap[k]}')" class="${dropCls}">${schemaLabelMap[k]}</div>`)
        .join('') + schemaNodes.map(s =>
            `<div id="schema-item-${s.id}" data-value="${s.slug}" data-label="${s.title}" class="px-3 py-2 hover:bg-emerald-50/50 dark:hover:bg-slate-700 flex items-center justify-between group"><div onclick="selectSchemaOption('${s.slug}', '${s.title} (${s.slug})')" class="flex-1 cursor-pointer flex items-center justify-between mr-2"><span class="truncate font-medium">${s.title}</span><span class="text-[10px] text-purple-600 dark:text-purple-400 font-mono font-bold">${s.slug}</span></div><button type="button" onclick="event.stopPropagation(); deleteSchemaModel('${s.id}', '${s.title}')" class="text-slate-400 hover:text-red-500 p-1" title="${i18n.editor.btn_delete_schema}"><span class="material-symbols-outlined text-[15px]">delete</span></button></div>`
        ).join('');

    const builtinSchemaHtml = renderTemplate(schemaBuiltinTemplate, {
        ...metaObj,
        class_default: metaSchemaType === 'default' ? '' : 'hidden',
        class_game: metaSchemaType === 'game' ? '' : 'hidden',
        class_book: metaSchemaType === 'book' ? '' : 'hidden',
        desc_default: i18n.editor.schema_standard_desc,
        placeholder_developer: i18n.editor.schema_developer,
        placeholder_platform: i18n.editor.schema_platform,
        placeholder_release_date: i18n.editor.schema_release_date,
        placeholder_author: i18n.editor.schema_author,
        placeholder_publisher: i18n.editor.schema_publisher,
        placeholder_isbn: i18n.editor.schema_isbn
    });

    const inputCls = 'w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg p-1.5 text-xs text-slate-800 dark:text-slate-100';
    const customSchemasHtml = schemaNodes.map(s => {
        const sMeta = parseJson<Record<string, any>>(s.metadata, {});
        const fields = Array.isArray(sMeta.fields) ? sMeta.fields : [];
        const isSelected = metaSchemaType === s.slug;
        const safeSlug = s.slug.replace(/[^a-zA-Z0-9_-]/g, '_');
        const fieldsHtml = fields.length === 0
            ? `<div class="text-[11px] text-slate-400 italic">${i18n.editor.no_schema_fields}</div>`
            : fields.map((f: any) => `<div><label class="block text-[10px] font-bold text-slate-600 dark:text-slate-300 mb-0.5">${f.label || f.name} ${f.name ? `<span class="font-mono text-slate-400 font-normal">(${f.name})</span>` : ''}</label><input type="${f.type === 'url' ? 'url' : (f.type === 'number' ? 'number' : 'text')}" name="meta_${f.name}" value="${metaObj[f.name] || ''}" placeholder="${f.label || f.name}" class="${inputCls}" /></div>`).join('');

        return renderTemplate(schemaCustomGroupTemplate, {
            safe_slug: safeSlug,
            id: s.id,
            title: s.title,
            slug: s.slug,
            selected_class: isSelected ? '' : 'hidden',
            btn_delete_schema: i18n.editor.btn_delete_schema,
            fields_html: fieldsHtml
        });
    }).join('');

    const schemaFieldsHtml = builtinSchemaHtml + customSchemasHtml;

    const transGroupsOptionsHtml = translationGroups.map(g => `<div id="trans-group-item-${g.id}" onclick="selectTransGroup('${g.id}', '${g.name}')" class="px-2.5 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-700 cursor-pointer flex justify-between items-center"><span class="truncate font-semibold">${g.name}</span><button type="button" onclick="event.stopPropagation(); deleteTransGroup('${g.id}')" class="text-slate-400 hover:text-red-500 ml-2" title="${i18n.editor.delete_trans_group}"><span class="material-symbols-outlined text-[14px]">delete</span></button></div>`).join('');

    const peerTranslationsHtml = peerTranslations.length > 0 ? `<div class="space-y-1 pt-1"><div class="text-[10px] text-slate-400 font-bold uppercase tracking-wider">${i18n.editor.related_languages}</div><div class="space-y-1">${peerTranslations.map(p => `<a href="/admin/articles/edit/${p.id}" class="flex items-center justify-between p-1.5 rounded-lg bg-slate-50 dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200/60 dark:border-slate-700 text-[11px] text-slate-700 dark:text-slate-300 transition"><span class="truncate">${p.title}</span><span class="font-mono text-[10px] bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 px-1 rounded ml-1 shrink-0">${p.locale}</span></a>`).join('')}</div></div>` : '';

    const backlinksListHtml = backlinks.length === 0
        ? `<span class="text-slate-400 text-[11px]">${i18n.editor.no_backlinks}</span>`
        : backlinks.map(b => `<a href="/admin/articles/edit/${b.id}" class="block text-slate-700 dark:text-slate-300 hover:text-emerald-600 hover:bg-slate-100 dark:hover:bg-slate-800 p-1.5 rounded-lg truncate" title="/${b.slug}">← ${b.title}</a>`).join('');

    const siteNodesHtml = siteNodes.length === 0
        ? `<div class="text-slate-400 text-[11px] p-2 text-center">${i18n.editor.no_other_nodes}</div>`
        : siteNodes.map(sn => renderTemplate(siteNodeItemTemplate, {
            slug: sn.slug || sn.title,
            title: sn.title,
            quick_insert: i18n.editor.quick_insert_wiki
        })).join('');

    const pastVersionsHtml = pastVersions.length === 0
        ? `<div class="text-xs text-slate-400 py-3 text-center bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-100 dark:border-slate-800">${i18n.editor.versions_empty}</div>`
        : pastVersions.map(v => renderTemplate(versionItemTemplate, {
            id: v.id,
            version_number: v.version_number,
            version_tag: t(locale, 'editor.version_tag', { version: v.version_number }),
            created_at: formatSiteDateTime(v.created_at, locale, timezone),
            commit_message: v.commit_message || i18n.editor.default_commit,
            btn_inspect: i18n.editor.btn_inspect_snapshot,
            btn_rollback: i18n.editor.btn_rollback_snapshot,
            delete_label: i18n.common.delete
        })).join('');

    const isMicro = initialType === 'micro';
    const backHref = isMicro ? '/admin/micros' : '/admin/articles';
    const nodeFolder = metaObj.folder !== undefined ? metaObj.folder : '';

    const sidebarMicroTemplate = await fetchAsset('/admin/snippets/editor-sidebar-micro.html');
    const sidebarArticleTemplate = await fetchAsset('/admin/snippets/editor-sidebar-article.html');

    const cleanArticleSummary = String(node.summary || '').trim();

    const inspectorSidebarHtml = isMicro
        ? renderTemplate(sidebarMicroTemplate, {
            node_id: node.id || '',
            convert_article_class: props.isEdit && node.id ? '' : 'hidden',
            node_status: node.status || 'published',
            status_published_selected: (node.status || 'published') === 'published' ? 'selected' : '',
            status_draft_selected: node.status === 'draft' ? 'selected' : '',
            node_visibility: nodeVisibility,
            vis_public_selected: isPublicVis ? 'selected' : '',
            vis_private_selected: !isPublicVis ? 'selected' : '',
            current_locale: currentLocale,
            locale_options_html: renderLocaleOptions(currentLocale),
            node_folder: nodeFolder,
            existing_tags_string: existingTags.join(','),
            current_progress: currentProgress,
            current_maturity: currentMaturity,
            field_progress: i18n.articles?.field_progress || i18n.field_progress || '',
            progress_badge: i18n.articles?.progress_badge || i18n.progress_badge || '',
            progress_placeholder: i18n.articles?.progress_placeholder || i18n.progress_placeholder || ''
        }, i18n)
        : renderTemplate(sidebarArticleTemplate, {
            type_badge: currentTypeConfig.badge,
            type_icon: currentTypeConfig.icon,
            type_label: currentTypeConfig.label,
            clip_box_class: 'hidden',
            source_url: sourceUrl,
            current_template_label: currentTemplateLabel,
            template_options_html: templateOptionsHtml,
            current_locale_label: localeLabelMap[currentLocale] || currentLocale,
            custom_locale_class: isCustomLocale ? '' : 'hidden',
            node_slug: node.slug || '',
            domain,
            node_slug_preview: node.slug || 'slug',
            tag_chips_html: tagChipsHtml,
            node_summary: cleanArticleSummary,
            keywords,
            og_image: ogImage,
            og_image_preview_class: ogImage ? '' : 'hidden',
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

    const pageHtml = renderTemplate(contentEditorTemplate, {
        back_href: backHref,
        inspector_sidebar_html: inspectorSidebarHtml,
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
