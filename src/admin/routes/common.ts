import type { Context } from 'hono';
import type { AppHonoEnv, SaveNodeResult } from '../../engine';
import {
    createHookContext,
    findActiveSites,
    getAdminLocale,
    isSystemInstalled,
    getSharedPluginEngine,
    fetchAsset,
    renderTemplate,
    getAdminI18nSlice,
    getCommercialSnippet,
    formatSiteDateTime,
    t,
    DEFAULT_DEV_HOST,
    normalizeRoutePath,
    escapeHtml,
    escapeHtmlAttr,
    parseJson
} from '../../engine';

export { escapeHtml, escapeHtmlAttr, parseJson };

let isSystemInstalledCached = false;

export { getSharedPluginEngine };

export async function checkSystemInstalledCached(db: any): Promise<boolean> {
    if (isSystemInstalledCached) return true;
    if (!db) return false;
    const installed = await isSystemInstalled(db);
    if (installed) {
        isSystemInstalledCached = true;
    }
    return installed;
}

export function hasCommercialFeature(c: Context<AppHonoEnv>, feature: string = 'cms:*'): boolean {
    const isBuildCommunity = typeof __BUILD_EDITION__ !== 'undefined' && __BUILD_EDITION__ === 'community';
    if (isBuildCommunity) return false;

    const pluginEngine = c.get('pluginEngine') || getSharedPluginEngine();
    if (!pluginEngine.hasCommercialPlugins()) return false;

    const licenseResult = c.get('licenseResult' as any);
    if (!licenseResult || !licenseResult.valid) {
        return false;
    }

    const features: string[] = Array.isArray(licenseResult.features) && licenseResult.features.length > 0
        ? licenseResult.features
        : (licenseResult.isCommercial ? ['cms:*'] : []);

    if (features.includes('*')) return true;
    if (!feature || feature === 'cms:*') {
        return features.includes('cms:*') || features.some(f => f.startsWith('cms:'));
    }
    const [domain] = feature.split(':');
    return features.includes(feature) || Boolean(domain && features.includes(`${domain}:*`));
}

export function initAdminPluginEngine(c: Context<AppHonoEnv>) {
    const pluginEngine = c.get('pluginEngine') || getSharedPluginEngine();
    c.set('pluginEngine', pluginEngine);
    return pluginEngine;
}

export async function getAdminRouteContext(c: Context<AppHonoEnv>, preloadedSites?: any[]) {
    const db = c.env.DB;
    const user = c.get('user');
    const isSuperAdmin = c.get('isSuperAdmin');
    const siteId = c.get('siteId');
    const locale = getAdminLocale(c);
    const canUseFeature = (feature: string = 'cms:*') => hasCommercialFeature(c, feature);

    const tDbStart = performance.now();
    const sites = preloadedSites || await findActiveSites(db);
    if (!preloadedSites) {
        const timing = c.get('serverTiming' as any) as any;
        if (timing?.add) timing.add('db_sites', performance.now() - tDbStart);
    }
    const activeSite = (siteId ? sites.find(s => s.id === siteId) : sites[0]) || sites[0];
    const activeSiteId = activeSite?.id || '';
    const currentDomain = activeSite?.primary_domain || DEFAULT_DEV_HOST;

    return {
        db,
        user,
        currentUser: user,
        isSuperAdmin: Boolean(isSuperAdmin),
        siteId,
        locale,
        canUseFeature,
        sites,
        activeSite,
        activeSiteId,
        currentSiteId: activeSiteId,
        currentDomain
    };
}

export const parseNodeMetadata = (metadata: unknown): Record<string, any> => parseJson<Record<string, any>>(metadata, {});

export function extractNodeFolder(metaObj: Record<string, any>, slug = '', fallback = ''): string {
    if (metaObj && typeof metaObj.folder === 'string') {
        return metaObj.folder;
    }
    return (slug && slug.includes('/')) ? slug.split('/')[0] : fallback;
}

export const renderEmptyTableRow = (colspan: string | number, message: string) =>
    `<tr class="table-empty-row"><td colspan="${colspan}" class="px-6 py-16 text-center text-stone-400">${message}</td></tr>`;

export const renderTrashBadgeHtml = (count?: number) => {
    const n = Number(count || 0);
    return n > 0
        ? `<span class="bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-400 px-1.5 py-0.2 rounded-full text-[10px] font-mono font-bold">${n}</span>`
        : '';
};

export const renderFolderChips = (folders: string[], tableId: string, chipsId: string) =>
    folders.map(f => {
        const safeF = escapeHtmlAttr(f);
        const jsF = safeF.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `<button type="button" class="folder-chip folder-chip-inactive" data-folder="${safeF}" onclick="window.filterByFolder('${tableId}', '${jsF}', '${chipsId}')"><span class="material-symbols-outlined text-[13px] opacity-75">folder</span><span>${safeF}</span></button>`;
    }).join('');

const STATUS_CLASSES: Record<string, string> = {
    success: 'text-green-600',
    error: 'text-red-600',
    warning: 'text-amber-600'
};

export function renderStatusMessage(
    c: Context,
    message: string,
    type: 'error' | 'success' | 'warning' = 'success',
    status: number = (type === 'error' ? 400 : 200)
) {
    const cls = STATUS_CLASSES[type] || 'text-stone-600';
    return c.html(`<span class="${cls} font-bold">${escapeHtml(message)}</span>`, status as any);
}

export function renderStatusBadge(message: string, statusClass: string): string {
    return `<span class="${statusClass} font-bold">${escapeHtml(message)}</span>`;
}

export function formatTagsHtml(tags?: string[]): string {
    if (!tags || tags.length === 0) return `<span class="text-stone-300 dark:text-stone-600 text-xs">-</span>`;
    const allSafe = escapeHtmlAttr(tags.join(', '));
    const visible = tags.slice(0, 2).map(tag => `<span class="bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-400 border border-amber-100 dark:border-amber-800 px-1.5 py-0.5 rounded text-[10px] font-bold">#${escapeHtmlAttr(tag)}</span>`).join('');
    const extra = tags.length > 2
        ? `<span class="bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 border border-stone-200 dark:border-stone-700 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold" title="${allSafe}">+${tags.length - 2}</span>`
        : '';
    return `<div class="inline-flex items-center gap-1.5 flex-nowrap whitespace-nowrap justify-center" title="${allSafe}">${visible}${extra}</div>`;
}

export function formatProgressBadgeHtml(progress: string | undefined, _i18n?: any): string {
    const val = (progress || '').trim();
    if (!val || val === 'none') {
        return `<span class="text-stone-400 text-xs font-mono">-</span>`;
    }
    const safeVal = escapeHtml(val);
    return `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300 border border-stone-200 dark:border-stone-700">${safeVal}</span>`;
}

export function renderPastVersionsHtml(
    pastVersions: any[],
    versionItemTemplate: string,
    locale: string,
    timezone: string,
    editorI18n: any,
    deleteLabel: string
): string {
    if (!pastVersions.length) {
        return `<div class="text-xs text-stone-400 py-3 text-center bg-stone-50 dark:bg-stone-950 rounded-xl border border-stone-100 dark:border-stone-800">${editorI18n.versions_empty}</div>`;
    }
    return pastVersions.map((v: any) => renderTemplate(versionItemTemplate, {
        id: v.id,
        version_number: v.version_number,
        version_tag: t(locale, 'editor.version_tag', { version: v.version_number }),
        created_at: formatSiteDateTime(v.created_at, locale, timezone),
        commit_message: v.commit_message || editorI18n.default_commit,
        btn_inspect: editorI18n.btn_inspect_snapshot,
        btn_rollback: editorI18n.btn_rollback_snapshot,
        delete_label: deleteLabel
    })).join('');
}

export async function renderNewSchemaModalHtml(
    locale: string,
    canUseFeature?: (feature?: string) => boolean,
    cancelLabel = ''
): Promise<string> {
    const newSchemaModalTpl = await fetchAsset('/admin/modals/new-schema-modal.html');
    const schemasI18n = getAdminI18nSlice(locale, 'schemas');
    const canUseCommercialApi = canUseFeature ? canUseFeature('cms:api_token_bridge') : false;
    const schemaApiOnlyTpl = canUseCommercialApi ? getCommercialSnippet('schema-api-only.html') : null;
    const slotSchemaApiOnly = schemaApiOnlyTpl ? renderTemplate(schemaApiOnlyTpl, {}, schemasI18n) : '';
    return renderTemplate(newSchemaModalTpl, {
        cancel: cancelLabel,
        slot_schema_api_only_option: slotSchemaApiOnly
    }, schemasI18n);
}

export function formatStatusBadgeInfo(status: string, i18n: any): { badgeClass: string; badgeText: string } {
    const isScheduled = status.startsWith('scheduled:');
    const isPub = status === 'published';
    const isArchived = status === 'archived';
    const badgeClass = isScheduled
        ? 'list-pill list-pill-scheduled'
        : isPub
            ? 'list-pill list-pill-published'
            : isArchived
                ? 'list-pill list-pill-archived'
                : 'list-pill list-pill-draft';
    const badgeText = isScheduled ? (i18n.scheduled_publish || 'Scheduled') : (isPub ? (i18n.status_published || 'Published') : (isArchived ? (i18n.status_archived || 'Archived') : (i18n.status_draft || 'Draft')));
    return { badgeClass, badgeText };
}

export function parseNodeIds(input: unknown): string[] {
    if (Array.isArray(input)) return input;
    if (typeof input === 'string') {
        try {
            const parsed = JSON.parse(input);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}

export async function extractReqNodeIds(c: Context<any>): Promise<string[]> {
    const isJson = Boolean(c.req.header('content-type')?.includes('application/json'));
    const body = isJson ? await c.req.json().catch(() => ({})) : await c.req.parseBody().catch(() => ({}));
    return parseNodeIds((body as any).node_ids || (body as any).ids);
}

export async function runAdminPipeline<TData = any, TResult = any>(
    c: Context<AppHonoEnv>,
    action: string,
    data: TData,
    siteId?: string
): Promise<TResult> {
    const pluginEngine = c.get('pluginEngine') || getSharedPluginEngine();
    const txContext = createHookContext<TData, TResult>({ action, data, c, siteId });
    return pluginEngine.runPipeline(txContext);
}

export async function handleSaveNode(c: Context<AppHonoEnv>) {
    const formData = await c.req.parseBody();
    const locale = getAdminLocale(c);
    const ctx = await getAdminRouteContext(c);

    const id = formData.id as string;
    const isEdit = formData.is_edit === 'true';
    const siteId = (formData.site_id as string) || ctx.activeSiteId || c.get('siteId') || 'site_default';

    const type = (formData.type as any) || 'article';
    const title = (formData.title as string) || '';
    const rawSlug = (formData.slug as string || '').trim();
    let cleanSlug: string;
    if (rawSlug === '/' || rawSlug.toLowerCase() === 'index') {
        cleanSlug = '/';
    } else {
        const norm = normalizeRoutePath(rawSlug).toLowerCase();
        cleanSlug = norm.startsWith('/') ? norm.slice(1) : norm;
    }

    const parentId = (formData.parent_id as string) || null;
    const nodeLocale = (formData.locale as string) || 'zh-CN';
    const rawProgress = formData.progress !== undefined ? formData.progress : formData.maturity;
    const maturity = rawProgress !== undefined && rawProgress !== null ? String(rawProgress).trim() : '';
    const status = (formData.status as any) || 'published';
    const summary = ((formData.summary as string) || '').trim();
    const contentRaw = (formData.content_raw as string) || '';
    const commitMessage = (formData.commit_message as string || '').trim();

    const metadata: Record<string, any> = {};
    metadata.folder = (formData.meta_folder !== undefined ? String(formData.meta_folder) : (formData.folder !== undefined ? String(formData.folder) : '')).trim();
    const srcUrl = formData.meta_source_url || formData.link || formData.source_url;
    if (srcUrl && type !== 'micro') metadata.source_url = String(srcUrl).trim();
    if (formData.meta_page_type) metadata.page_type = formData.meta_page_type;
    if (formData.meta_template_page_id !== undefined) {
        metadata.template_page_id = formData.meta_template_page_id;
        metadata.template_id = formData.meta_template_page_id;
    }
    const metaDirectFields = ['redirect_url', 'redirect_code', 'canonical_url', 'robots', 'og_image', 'access_permission', 'scheduled_at', 'template_id', 'template_slug'];
    for (const f of metaDirectFields) {
        if (formData[`meta_${f}`] !== undefined) metadata[f] = formData[`meta_${f}`];
    }
    if (formData.meta_og_use_first_image === '1' || formData.meta_og_use_first_image === 'true') {
        metadata.og_use_first_image = true;
    } else if (type === 'article') {
        delete metadata.og_use_first_image;
    }

    if (type === 'page') {
        try {
            const parsedBlocks = JSON.parse(contentRaw || '[]');
            if (Array.isArray(parsedBlocks)) {
                metadata.blocks = parsedBlocks;
            } else if (parsedBlocks && Array.isArray(parsedBlocks.blocks)) {
                metadata.blocks = parsedBlocks.blocks;
            }
        } catch {
            metadata.blocks = [];
        }
    }
    const rawTags = (formData.meta_tags || formData.meta_keywords) as string | undefined;
    if (rawTags) {
        metadata.tags = metadata.keywords = rawTags.split(',').map(t => t.trim()).filter(Boolean);
    }
    if (formData.meta_aliases !== undefined) {
        const rawAliases = String(formData.meta_aliases || '').trim();
        if (rawAliases) {
            metadata.aliases = rawAliases.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
        } else {
            delete metadata.aliases;
        }
    }
    if (formData.meta_schema_type) metadata.schema_type = formData.meta_schema_type;
    if (formData.metadata_fields_json) {
        try {
            metadata.fields = typeof formData.metadata_fields_json === 'string'
                ? JSON.parse(formData.metadata_fields_json)
                : formData.metadata_fields_json;
        } catch {}
    }
    Object.keys(formData).forEach(key => {
        if (key.startsWith('meta_') && !metadata[key.replace('meta_', '')]) {
            metadata[key.replace('meta_', '')] = formData[key];
        }
    });

    let finalTitle = title;
    let finalSlug = cleanSlug;
    let finalMaturity = maturity;
    let finalType = type;

    if (type === 'micro') {
        finalType = 'micro';
        finalMaturity = maturity;
        if (!contentRaw.trim() && !finalTitle.trim()) {
            const isHtmx = Boolean(c.req.header('HX-Request'));
            const acceptsJson = !isHtmx || Boolean(c.req.header('accept')?.includes('application/json'));
            const valMsg = t(locale, 'editor.at_least_one_field');
            if (acceptsJson) {
                return c.json({ success: false, error: valMsg }, 400);
            }
            return c.html(await renderStatusBadge(valMsg, 'text-red-500'), 400);
        }
        if (!finalTitle.trim()) {
            if (contentRaw.trim()) {
                const stripMdChars = (str: string) => Array.from(str).filter(ch => !'\r\n#*`'.includes(ch)).join('').trim();
                finalTitle = stripMdChars(contentRaw.slice(0, 24)) || t(locale, 'micro.title');
            } else {
                finalTitle = t(locale, 'micro.title');
            }
        }
        if (!finalSlug) {
            finalSlug = `micro-${Date.now().toString(36)}`;
        }
    } else if (type === 'page' && !finalSlug) {
        finalSlug = `page-${Date.now().toString(36)}`;
    }

    const pipelineAction =
        type === 'page'
            ? 'PAGE_SAVE'
            : type === 'micro'
              ? 'MICRO_SAVE'
              : 'ARTICLE_SAVE';

    const acceptsJson = !c.req.header('HX-Request') || Boolean(c.req.header('accept')?.includes('application/json'));
    const cardCls = 'px-4 py-2 rounded-xl shadow-lg border block ';
    const okCls = 'text-amber-700 bg-amber-50 border-amber-200';
    const respond = async (jsonObj: any, badgeMsg: string, badgeClass: string, status = 200) =>
        acceptsJson ? c.json(jsonObj, status as any) : c.html(await renderStatusBadge(badgeMsg, cardCls + badgeClass), status as any);

    try {
        const result = await runAdminPipeline<any, SaveNodeResult>(c, pipelineAction, {
            id,
            siteId,
            slug: finalSlug,
            type: finalType,
            parentId,
            translationGroupId: formData.translation_group_id !== undefined ? (((formData.translation_group_id as string)?.trim()) || null) : undefined,
            locale: nodeLocale,
            title: finalTitle,
            summary,
            contentRaw,
            progress: finalMaturity,
            maturity: finalMaturity,
            status,
            visibility: (formData.visibility as string) || 'public',
            publishedAt: formData.published_at !== undefined ? String(formData.published_at) : (formData.meta_published_at !== undefined ? String(formData.meta_published_at) : undefined),
            commitMessage,
            metadata,
            isEdit
        }, siteId);

        if (isEdit) {
            if (result.unchanged) {
                const msg = t(locale, 'editor.no_changes_detected');
                return respond({ success: true, unchanged: true, message: msg, versionNumber: result.versionNumber, slug: result.slug, rawSlug: finalSlug, nodeId: result.id }, `ℹ️ ${msg}`, 'text-amber-600 bg-amber-50 border-amber-200');
            }
            const msg = t(locale, 'articles.save_success_version', { version: result.versionNumber });
            return respond({ success: true, unchanged: false, message: msg, versionNumber: result.versionNumber, slug: result.slug, rawSlug: finalSlug, nodeId: result.id }, msg, okCls);
        } else {
            const redirectTarget = type === 'page' ? '/admin/pages' : (type === 'micro' ? '/admin/micros' : '/admin/articles');
            c.header('HX-Redirect', redirectTarget);
            const msg = t(locale, 'articles.save_success_redirect');
            return respond({ success: true, isNew: true, redirectUrl: redirectTarget, message: msg, slug: result.slug, rawSlug: finalSlug, nodeId: result.nodeId }, msg, okCls);
        }
    } catch (err: any) {
        console.error('Save node action error:', err);
        const errMsg = t(locale, 'articles.save_rejected', { reason: err.message || t(locale, 'common.error') });
        return respond({ success: false, error: err.message || t(locale, 'articles.save_failed') }, errMsg, 'text-red-600 bg-red-50 border-red-200', 400);
    }
}

export const createDeleteRouteHandler = (action: string) => async (c: Context<AppHonoEnv>) => {
    try {
        await runAdminPipeline(c, action, { id: c.req.param('id') });
        return c.body(null, 200);
    } catch (err: any) {
        console.error(`${action} execution error:`, err);
        return c.body(null, 500);
    }
};

export const createBatchSoftDeleteHandler = () => async (c: Context<AppHonoEnv>) => {
    const nodeIds = await extractReqNodeIds(c);
    if (!nodeIds.length) {
        return c.json({ success: false, error: t(getAdminLocale(c), 'common.no_nodes_selected') }, 400);
    }
    if (nodeIds.length > 15) {
        return c.json({ success: false, code: 'BATCH_LIMIT_EXCEEDED', error: 'Maximum 15 items per batch' }, 422);
    }
    try {
        await runAdminPipeline(c, 'NODE_BATCH_SOFT_DELETE', { nodeIds });
        return c.json({ success: true, count: nodeIds.length });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
};

export const createBatchFolderHandler = () => async (c: Context<AppHonoEnv>) => {
    const formData = await c.req.parseBody();
    const folder = ((formData.folder as string) || '').trim() || '/';
    const nodeIds = parseNodeIds(formData.node_ids);
    if (!nodeIds.length) {
        return c.json({ success: false, error: t(getAdminLocale(c), 'common.no_nodes_selected') }, 400);
    }
    if (nodeIds.length > 15) {
        return c.json({ success: false, code: 'BATCH_LIMIT_EXCEEDED', error: 'Maximum 15 items per batch' }, 422);
    }
    try {
        await runAdminPipeline(c, 'NODE_BATCH_MOVE_FOLDER', { nodeIds, folder });
        return c.json({ success: true, count: nodeIds.length, folder });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
};

export const createExportSelectedHandler = (type: string) => async (c: Context<AppHonoEnv>) => {
    const siteId = c.get('siteId') || 'site_default';
    const ids = (c.req.query('ids') || '').split(',').filter(Boolean);
    if (!ids.length) return c.text(t(getAdminLocale(c), 'common.no_items_selected'), 400);
    try {
        const { items } = await runAdminPipeline<any, { items: any[]; count: number }>(c, 'CONTENT_BATCH_EXPORT', { siteId, ids, type });
        c.header('Content-Type', 'application/json; charset=utf-8');
        c.header('Content-Disposition', `attachment; filename="${type}s-export-${Date.now()}.json"`);
        return c.json(items);
    } catch (err: any) {
        return c.json({ success: false, error: err.message }, err.message?.includes('UNAUTHORIZED_ACCESS_REQUIRED') ? 403 : 500);
    }
};

export function serializePageContractContext(opts: {
    themeComponents?: any[];
    templatePages?: any[];
    datasetCollections?: any[];
    datasetSchemas?: any[];
    siteTaxonomy?: any;
    recentMedia?: Array<{ url: string; filename: string; alt: string }>;
    externalExtensions?: any[];
    slotQuotas?: Record<string, number | null>;
    extIslandEnabled?: boolean;
    includeTemplateHtmlAndPreview?: boolean;
    themeAssetPrefix?: string;
    buildPreviewSrcdoc?: (html: string, prefix: string) => string;
}) {
    const componentsPayload = (opts.themeComponents || []).map((comp: any) => {
        const cMeta = parseJson<Record<string, any>>(comp.metadata, {});
        const tplHtml = String(cMeta.template_html || cMeta.templateHtml || comp.template_html || '');
        const hasArticleSlot = /\{\{\{?\s*(?:content_html|page\.content)\s*\}?\}\}/.test(tplHtml);
        const description = String(cMeta.description || comp.description || comp.summary || cMeta.summary || '').trim();
        const role = cMeta.role || comp.role || (hasArticleSlot ? 'article_content_slot' : undefined);
        const enrichedMeta: Record<string, any> = {
            ...cMeta,
            ...(description ? { description } : {}),
            ...(role ? { role } : {})
        };
        if (opts.includeTemplateHtmlAndPreview && opts.buildPreviewSrcdoc) {
            const defaultProps = cMeta.default_props || cMeta.defaultProps || {};
            const previewHtml = tplHtml ? renderTemplate(tplHtml, defaultProps) : '';
            return {
                ...comp,
                ...(description ? { description } : {}),
                ...(role ? { role } : {}),
                metadata: enrichedMeta,
                preview_srcdoc: previewHtml ? opts.buildPreviewSrcdoc(previewHtml, opts.themeAssetPrefix || '') : ''
            };
        }
        // PagesList only renders contract metadata, so strip raw template_html at SSR.
        const { template_html: _t1, templateHtml: _t2, ...cleanMeta } = enrichedMeta;
        return {
            slug: comp.slug,
            title: comp.title,
            summary: comp.summary || description,
            description,
            ...(role ? { role } : {}),
            metadata: cleanMeta
        };
    });

    const templatesPayload = (opts.templatePages || []).map((tp: any) => {
        const meta = parseJson<Record<string, any>>(tp.metadata, {});
        let blocks: any[] = Array.isArray(tp.blocks) ? tp.blocks : [];
        if (blocks.length === 0) {
            try {
                const raw = tp.content_raw ? JSON.parse(tp.content_raw) : meta.blocks;
                blocks = Array.isArray(raw) ? raw : [];
            } catch {
                blocks = Array.isArray(meta.blocks) ? meta.blocks : [];
            }
        }
        const isContentHole = (b: any) =>
            b && (b.component === '@slot:page_content' || b.component === 'slot:page_content' || b.id === '@slot:page_content');
        const occupiedSlots = Array.from(new Set(
            blocks.filter((b: any) => !isContentHole(b)).map((b: any) => String(b?.target_slot || 'main').trim()).filter(Boolean)
        ));
        return {
            id: tp.id,
            slug: tp.slug,
            title: tp.title,
            occupied_slots: occupiedSlots,
            has_page_content_slot: blocks.some((b: any) => b?.component === '@slot:page_content'),
            ...(opts.includeTemplateHtmlAndPreview ? { blocks } : {})
        };
    });

    const datasetsPayload = {
        collections: opts.datasetCollections || [],
        schemas: opts.datasetSchemas || [],
        ...(opts.siteTaxonomy ? { siteTaxonomy: opts.siteTaxonomy } : {}),
        ...(Array.isArray(opts.recentMedia) ? { recentMedia: opts.recentMedia } : {}),
        externalExtensions: opts.externalExtensions || [],
        extIslandEnabled: Boolean(opts.extIslandEnabled),
        slotQuotas: opts.slotQuotas || {}
    };

    return { componentsPayload, templatesPayload, datasetsPayload };
}

export const createBatchImportHandler = (defaultType: string) => async (c: Context<AppHonoEnv>) => {
    const siteId = c.get('siteId') || 'site_default';
    try {
        const body = await c.req.json();
        const rawItems = Array.isArray(body)
            ? body
            : (Array.isArray(body?.items)
                ? body.items
                : (defaultType === 'page' && body && typeof body === 'object' ? [body] : null));
        if (!Array.isArray(rawItems) || !rawItems.length) {
            return c.json({ success: false, error: t(getAdminLocale(c), 'editor.import_empty') }, 400);
        }
        if (rawItems.length > 15) {
            return c.json({ success: false, code: 'BATCH_LIMIT_EXCEEDED', error: 'Maximum 15 items per batch' }, 422);
        }
        const items = defaultType === 'page'
            ? rawItems.map((it: any) => {
                if (it && Array.isArray(it.page_payload) && !it.content && !it.content_raw && !it.metadata?.blocks) {
                    return { ...it, content_raw: JSON.stringify(it.page_payload), metadata: { ...(it.metadata || {}), blocks: it.page_payload } };
                }
                if (it && Array.isArray(it.blocks) && !it.content && !it.content_raw && !it.metadata?.blocks) {
                    return { ...it, content_raw: JSON.stringify(it.blocks), metadata: { ...(it.metadata || {}), blocks: it.blocks } };
                }
                return it;
            })
            : rawItems;
        const conflictStrategy = body?.conflictStrategy === 'upsert' || body?.conflict_strategy === 'upsert' ? 'upsert' : 'skip';
        const res = await runAdminPipeline<any, { count: number; skippedCount?: number; code?: string; nextCursor?: number }>(c, 'CONTENT_BATCH_IMPORT', { siteId, items, defaultType, conflictStrategy });
        if (res.code === 'SOFT_CPU_LIMIT') {
            return c.json({ success: false, code: 'SOFT_CPU_LIMIT', nextCursor: res.nextCursor, count: res.count, skippedCount: res.skippedCount || 0 }, 422);
        }
        return c.json({ success: true, count: res.count, skippedCount: res.skippedCount || 0 });
    } catch (err: any) {
        return c.json({ success: false, error: err.message }, err.message?.includes('UNAUTHORIZED_ACCESS_REQUIRED') ? 403 : 500);
    }
};
