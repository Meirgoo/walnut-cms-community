import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { type Theme, normalizeThemeComponentDataSlots } from '../../types';
import { parseJson } from '../utils';
import { buildInsertEntityVersionStatement, findEntityVersions, findEntityVersionByIdOrNumber } from './versions.dal';

function unwrapComponentItem(c: any): any {
    if (!c || typeof c !== 'object') return c;
    const { metadata: nestedMeta, ...rest } = c;
    if (nestedMeta && typeof nestedMeta === 'object' && !Array.isArray(nestedMeta)) {
        const merged = { ...rest, ...nestedMeta };
        delete merged.metadata;
        return merged;
    }
    return rest;
}

export function sanitizeThemeMetadataJson(raw: unknown): string {
    const obj = typeof raw === 'string'
        ? parseJson<Record<string, any>>(raw, {})
        : (raw && typeof raw === 'object' ? { ...(raw as Record<string, any>) } : {});
    if (!obj || typeof obj !== 'object') return '{}';

    if (Array.isArray(obj.componentNodes) && !Array.isArray(obj.components)) {
        obj.components = obj.componentNodes.map(unwrapComponentItem);
    } else if (Array.isArray(obj.components)) {
        obj.components = obj.components.map(unwrapComponentItem);
    }
    if (!Array.isArray(obj.templates) && Array.isArray(obj.templateNodes)) {
        obj.templates = obj.templateNodes;
    }
    if (!Array.isArray(obj.schemas) && Array.isArray(obj.schemaNodes)) {
        obj.schemas = obj.schemaNodes;
    }

    delete obj.componentNodes;
    delete obj.templateNodes;
    delete obj.schemaNodes;
    return JSON.stringify(obj);
}

export function normalizeThemeMetadata(meta: any): any {
    if (!meta || typeof meta !== 'object') return meta;
    if (Array.isArray(meta.componentNodes) && !meta.components) {
        meta.components = meta.componentNodes.map((c: any) => {
            const m = (c.metadata && typeof c.metadata === 'object') ? c.metadata : {};
            const clean = {
                ...c,
                ...m,
                slug: c.slug || m.slug,
                name: m.name || c.name || c.title,
                template_html: m.template_html || c.template_html,
                default_props: m.default_props || c.default_props,
                ui_schema: m.ui_schema || c.ui_schema,
                ...(m.data_slots || c.data_slots ? { data_slots: m.data_slots || c.data_slots } : {}),
                slots: m.slots || c.slots || ['main']
            };
            delete clean.metadata;
            return clean;
        });
    }
    if (!meta.templates && meta.templateNodes) meta.templates = meta.templateNodes;
    if (!meta.schemas && meta.schemaNodes) meta.schemas = meta.schemaNodes;

    delete meta.componentNodes;
    delete meta.templateNodes;
    delete meta.schemaNodes;

    // Expose legacy *Nodes getters as non-enumerable aliases so JSON.stringify never re-persists derived bloat to D1.
    const defineAlias = (prop: string, targetKey: 'components' | 'templates' | 'schemas', mapper?: (list: any[]) => any[]) => {
        Object.defineProperty(meta, prop, {
            get() {
                const list = Array.isArray(meta[targetKey]) ? meta[targetKey] : [];
                return mapper ? mapper(list) : list;
            },
            set(v: any) {
                meta[targetKey] = prop === 'componentNodes' && Array.isArray(v) ? v.map(unwrapComponentItem) : v;
            },
            enumerable: false,
            configurable: true
        });
    };
    defineAlias('componentNodes', 'components', (list) => list.map((c: any) => ({ ...c, metadata: c.metadata || c })));
    defineAlias('templateNodes', 'templates');
    defineAlias('schemaNodes', 'schemas');
    return meta;
}

export async function findPublishedTheme(db: D1Database, siteId: string): Promise<Theme | null> {
    const row = await db.prepare(`
        SELECT t.*,
               CASE
                   WHEN s.theme_id IS NOT NULL THEN (CASE WHEN t.id = s.theme_id OR t.slug = s.theme_id THEN 1 ELSE 0 END)
                   ELSE t.is_active
               END as is_active
        FROM themes t
        LEFT JOIN sites s ON s.id = ?
        WHERE t.deleted_at IS NULL
        ORDER BY
          CASE
            WHEN t.id = s.theme_id OR t.slug = s.theme_id THEN 1
            WHEN t.site_id = ? AND t.is_active = 1 THEN 2
            WHEN t.is_active = 1 THEN 3
            ELSE 4
          END ASC,
          t.updated_at DESC
        LIMIT 1
    `).bind(siteId, siteId).first<any>();

    if (!row) return null;
    return {
        ...row,
        metadata: normalizeThemeMetadata(parseJson(row.metadata, {}))
    };
}

export async function findLatestThemeBySite(db: D1Database, _siteId: string): Promise<{ id: string; metadata?: any } | null> {
    try {
        const row = await db.prepare(
            `SELECT id, metadata FROM themes WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1`
        ).first<{ id: string; metadata?: string }>();
        return row || null;
    } catch {
        return null;
    }
}

export async function findPublishedThemeNode(db: D1Database, siteId: string): Promise<any | null> {
    const theme = await findPublishedTheme(db, siteId);
    if (!theme) return null;
    return {
        id: theme.id,
        site_id: theme.site_id,
        slug: theme.slug,
        type: 'theme',
        title: theme.name,
        name: theme.name,
        summary: theme.description,
        metadata: theme.metadata || {},
        status: theme.status
    };
}

export function normalizeThemeComponentItem(rawComp: any, siteId: string): any {
    let current: any = rawComp;
    const chain: any[] = [];
    while (current && typeof current === 'object' && chain.length < 5) {
        chain.push(current);
        if (current.metadata) current = parseJson(current.metadata, null);
        else break;
    }

    const merged = Object.assign({}, ...chain);
    const slug = merged.slug || merged.type || merged.name || merged.id || `comp_${Math.random().toString(36).slice(2, 8)}`;
    const name = merged.title || merged.name || slug;
    const summary = merged.description || merged.summary || '';
    const category = merged.category || 'General';
    const icon = merged.icon || 'widgets';
    const isContainer = Boolean(merged.isContainer);
    const slots = Array.isArray(merged.slots) && merged.slots.length > 0 ? merged.slots : (isContainer ? ['children'] : []);
    const templateHtml = merged.template_html || merged.templateHtml || merged.template || '';
    const templatePath = merged.template_path || '';
    const allowCustomJs = merged.allow_custom_js === true;
    const defaultProps = typeof merged.default_props === 'object' && merged.default_props ? { ...merged.default_props } : {};
    if (!allowCustomJs) {
        delete defaultProps.custom_js;
    }
    const schemaFields = (merged.schema && Array.isArray(merged.schema.fields)) ? merged.schema.fields : (Array.isArray(merged.fields) ? merged.fields : []);
    const uiSchemaList = Array.isArray(merged.ui_schema) ? merged.ui_schema : [];

    const RESERVED_PROPS_BLACKLIST = new Set([
        'powered_by',
        'powered_by_html',
        'powered_by_bar',
        'whitelabel',
        'whitelabel_html',
        'custom_js',
        'content',
        'content_html',
        'content_raw',
        'translations',
        'translations_json',
        'i18n',
        '_i18n',
        'site',
        'page'
    ]);

    const fieldMap = new Map<string, any>();
    for (const f of [...schemaFields, ...uiSchemaList]) {
        const k = f.key || f.name || f.id;
        // Permit explicit markdown fields named 'content' for standalone page prose blocks while keeping article globals guarded.
        const isExplicitMarkdownContent = k === 'content' && (f.type === 'markdown' || f.widget === 'markdown');
        if (!k || (RESERVED_PROPS_BLACKLIST.has(k) && !isExplicitMarkdownContent)) continue;
        const prev = fieldMap.get(k) || {};
        const widget = f.widget || prev.widget || (f.type === 'boolean' || prev.type === 'boolean' ? 'switch' : (f.type || prev.type || 'text'));
        const def = f.default !== undefined ? f.default : (prev.default !== undefined ? prev.default : (defaultProps[k] !== undefined ? defaultProps[k] : (widget === 'switch' ? false : '')));
        fieldMap.set(k, {
            ...prev,
            ...f,
            key: k,
            label: f.label || prev.label || f.title || prev.title || f.name || prev.name || k,
            type: f.type || prev.type || (widget === 'switch' ? 'boolean' : 'text'),
            widget,
            default: def,
            placeholder: f.placeholder || prev.placeholder || (def !== undefined && typeof def !== 'boolean' ? String(def) : ''),
            group: f.group || prev.group || 'General',
            options: f.options || prev.options,
            required: f.required ?? prev.required ?? false
        });
    }
    const mergedFields = Array.from(fieldMap.values());
    const dataSlots = normalizeThemeComponentDataSlots(merged.data_slots);

    return {
        id: rawComp.id || `comp_${slug}`,
        site_id: siteId,
        slug,
        type: slug,
        componentType: slug,
        title: name,
        name,
        summary,
        description: summary,
        category,
        icon,
        template_html: templateHtml,
        template_path: templatePath,
        schema_binding: merged.schema_binding || '',
        hydration: merged.hydration || 'idle',
        default_props: defaultProps,
        keep_field: Array.isArray(merged.keep_field) ? merged.keep_field : [],
        field_map: merged.field_map,
        ...(dataSlots && dataSlots.length > 0 ? { data_slots: dataSlots } : {}),
        contenteditable: Boolean(merged.contenteditable),
        ui_schema: mergedFields,
        fields: mergedFields,
        schema: { fields: mergedFields },
        isContainer,
        slots,
        allow_custom_js: allowCustomJs,
        metadata: {
            ...(chain[chain.length - 1] || {}),
            slug, type: slug, name, title: name, description: summary, category, icon,
            allow_custom_js: allowCustomJs,
            ...(dataSlots && dataSlots.length > 0 ? { data_slots: dataSlots } : {}),
            template_html: templateHtml, template_path: templatePath, default_props: defaultProps,
            ui_schema: mergedFields, fields: mergedFields, schema: { fields: mergedFields }
        },
        status: 'published'
    };
}

export function extractThemeComponentsFromTheme(theme: Theme | null, siteId: string): any[] {
    if (!theme || !theme.metadata) return [];
    const comps: any[] = theme.metadata.components || theme.metadata.componentNodes || [];
    const seen = new Set<string>();
    const result: any[] = [];
    for (const c of comps) {
        const normalized = normalizeThemeComponentItem(c, siteId);
        if (normalized && normalized.slug && !seen.has(normalized.slug)) {
            seen.add(normalized.slug);
            result.push(normalized);
        }
    }
    return result;
}

export function extractThemeTemplatesFromTheme(theme: Theme | null, siteId: string): any[] {
    if (!theme || !theme.metadata) return [];
    const tpls: any[] = theme.metadata.templates || theme.metadata.templateNodes || [];
    return tpls.map((t: any) => {
        const tMeta = parseJson<Record<string, any>>(t.metadata, {});
        const slug = t.slug || t.key || tMeta.slug || tMeta.key || '';
        const name = t.name || t.title || tMeta.name || tMeta.title || slug;
        const summary = t.summary || t.description || tMeta.summary || tMeta.description || '';
        const layout = t.layout || tMeta.layout || 'default';
        const rawBlocks = t.blocks || tMeta.blocks || (t.content && t.content.blocks) || (tMeta.content && tMeta.content.blocks) || [];
        const blocks = Array.isArray(rawBlocks) ? rawBlocks : [];

        return {
            id: t.id || tMeta.id || slug || `tpl_${slug}`,
            site_id: siteId,
            slug,
            type: 'template',
            title: name,
            name,
            summary,
            layout,
            blocks,
            metadata: {
                ...tMeta,
                ...t,
                slug,
                layout,
                blocks
            },
            status: 'published'
        };
    });
}

export async function findPublishedThemeBundle(db: D1Database, siteId: string): Promise<{
    themeNode: any | null;
    templates: any[];
    components: any[];
}> {
    const theme = await findPublishedTheme(db, siteId);
    if (!theme) return { themeNode: null, templates: [], components: [] };
    return {
        themeNode: {
            id: theme.id,
            site_id: theme.site_id,
            slug: theme.slug,
            type: 'theme',
            title: theme.name,
            name: theme.name,
            summary: theme.description,
            metadata: theme.metadata,
            status: theme.status
        },
        templates: extractThemeTemplatesFromTheme(theme, siteId),
        components: extractThemeComponentsFromTheme(theme, siteId)
    };
}

export async function findPublishedComponents(db: D1Database, siteId: string): Promise<any[]> {
    return extractThemeComponentsFromTheme(await findPublishedTheme(db, siteId), siteId);
}

export async function findPublishedTemplates(db: D1Database, siteId: string): Promise<any[]> {
    return extractThemeTemplatesFromTheme(await findPublishedTheme(db, siteId), siteId);
}

export function buildUpdateThemeMetadataStatement(
    db: D1Database,
    themeId: string,
    metadataJson: string
): D1PreparedStatement {
    return db.prepare(`
        UPDATE themes 
        SET metadata = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
    `).bind(sanitizeThemeMetadataJson(metadataJson), themeId);
}

export function buildActivateThemeStatements(
    db: D1Database,
    siteId: string,
    themeId: string
): D1PreparedStatement[] {
    return [
        db.prepare(`UPDATE sites SET theme_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(themeId, siteId),
        db.prepare(`UPDATE themes SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE site_id = ?`).bind(themeId, siteId)
    ];
}

export function buildActivateThemeBySlugStatements(
    db: D1Database,
    siteId: string,
    themeSlug: string,
    themeNodeId: string
): D1PreparedStatement[] {
    return [
        db.prepare(`UPDATE sites SET theme_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(themeNodeId, siteId),
        db.prepare(`UPDATE themes SET is_active = CASE WHEN slug = ? THEN 1 ELSE 0 END WHERE site_id = ?`).bind(themeSlug, siteId)
    ];
}

export function buildUpsertThemeStatement(
    db: D1Database,
    theme: {
        id: string;
        siteId: string;
        slug: string;
        name: string;
        author?: string;
        version?: string;
        description?: string;
        previewImage?: string;
        metadataJson: string;
        currentVersionId: string;
    }
): D1PreparedStatement {
    return db.prepare(`
        INSERT INTO themes (
            id, site_id, slug, name, author, version, description, preview_image, is_active, status, metadata, current_version_id
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, 0, 'published', ?, ?
        )
        ON CONFLICT(site_id, slug) DO UPDATE SET
            name = excluded.name,
            version = excluded.version,
            description = excluded.description,
            metadata = excluded.metadata,
            updated_at = CURRENT_TIMESTAMP
    `).bind(
        theme.id,
        'site_default',
        theme.slug,
        theme.name,
        theme.author || 'Admin',
        theme.version || '1.0.0',
        theme.description || '',
        theme.previewImage || '',
        sanitizeThemeMetadataJson(theme.metadataJson),
        theme.currentVersionId
    );
}

export function buildCreateThemeStatement(
    db: D1Database,
    theme: {
        id: string;
        siteId: string;
        slug: string;
        name: string;
        author?: string;
        version?: string;
        description?: string;
        previewImage?: string;
        metadataJson: string;
        currentVersionId: string;
    }
): D1PreparedStatement {
    return db.prepare(`
        INSERT INTO themes (
            id, site_id, slug, name, author, version, description, preview_image, is_active, status, metadata, current_version_id
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, 0, 'published', ?, ?
        )
    `).bind(
        theme.id,
        'site_default',
        theme.slug,
        theme.name,
        theme.author || 'Admin',
        theme.version || '1.0.0',
        theme.description || '',
        theme.previewImage || '',
        sanitizeThemeMetadataJson(theme.metadataJson),
        theme.currentVersionId
    );
}

export function buildUpdateThemeInfoStatement(
    db: D1Database,
    params: {
        id: string;
        siteId?: string;
        name?: string;
        slug?: string;
        author?: string;
        description?: string;
        metadataJson?: string;
    }
): D1PreparedStatement {
    return db.prepare(`
        UPDATE themes
        SET name = COALESCE(?, name),
            slug = COALESCE(?, slug),
            author = COALESCE(?, author),
            description = COALESCE(?, description),
            metadata = COALESCE(?, metadata),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).bind(
        params.name ?? null,
        params.slug ?? null,
        params.author ?? null,
        params.description ?? null,
        params.metadataJson !== undefined ? sanitizeThemeMetadataJson(params.metadataJson) : null,
        params.id
    );
}

export function buildUpdateThemeMetadataOnlyStatement(
    db: D1Database,
    themeId: string,
    metadataJson: string
): D1PreparedStatement {
    return buildUpdateThemeMetadataStatement(db, themeId, metadataJson);
}

export function buildInsertThemeVersionStatement(
    db: D1Database,
    version: {
        id: string;
        siteId?: string;
        themeId: string;
        versionNumber?: number;
        versionTag?: string;
        metadataSnapshot: string;
        commitMessage?: string;
        authorId?: string | null;
    }
): D1PreparedStatement {
    return buildInsertEntityVersionStatement(db, {
        id: version.id,
        siteId: version.siteId || 'site_default',
        entityType: 'theme',
        entityId: version.themeId,
        versionNumber: version.versionNumber || 1,
        versionTag: version.versionTag || '1.0.0',
        metadataSnapshot: sanitizeThemeMetadataJson(version.metadataSnapshot),
        commitMessage: version.commitMessage || 'Theme import snapshot',
        authorId: version.authorId || null,
        ignoreConflict: true
    });
}

export async function findThemeById(
    db: D1Database,
    themeId: string,
    siteId?: string
): Promise<Theme | null> {
    const query = siteId
        ? `SELECT t.*,
                  CASE
                      WHEN s.theme_id IS NOT NULL THEN (CASE WHEN t.id = s.theme_id OR t.slug = s.theme_id THEN 1 ELSE 0 END)
                      ELSE t.is_active
                  END as is_active
           FROM themes t
           LEFT JOIN sites s ON s.id = ?
           WHERE t.id = ? LIMIT 1`
        : `SELECT * FROM themes WHERE id = ? LIMIT 1`;
    const params = siteId ? [siteId, themeId] : [themeId];
    const row = await db.prepare(query).bind(...params).first<any>();
    if (!row) return null;
    return {
        ...row,
        metadata: normalizeThemeMetadata(parseJson(row.metadata, {}))
    };
}

export async function findThemesBySite(
    db: D1Database,
    siteId: string,
    includeDeleted = false
): Promise<Theme[]> {
    const query = includeDeleted
        ? `SELECT t.*,
                  CASE
                      WHEN s.theme_id IS NOT NULL THEN (CASE WHEN t.id = s.theme_id OR t.slug = s.theme_id THEN 1 ELSE 0 END)
                      ELSE t.is_active
                  END as is_active
           FROM themes t
           LEFT JOIN sites s ON s.id = ?
           ORDER BY is_active DESC, t.updated_at DESC`
        : `SELECT t.*,
                  CASE
                      WHEN s.theme_id IS NOT NULL THEN (CASE WHEN t.id = s.theme_id OR t.slug = s.theme_id THEN 1 ELSE 0 END)
                      ELSE t.is_active
                  END as is_active
           FROM themes t
           LEFT JOIN sites s ON s.id = ?
           WHERE t.deleted_at IS NULL
           ORDER BY is_active DESC, t.updated_at DESC`;
    const { results } = await db.prepare(query).bind(siteId).all<any>();
    return (results || []).map((row: any) => ({
        ...row,
        metadata: normalizeThemeMetadata(parseJson(row.metadata, {}))
    }));
}

export async function findThemeVersions(
    db: D1Database,
    themeId: string
): Promise<any[]> {
    return await findEntityVersions(db, 'theme', themeId);
}

export async function countActiveThemesBySite(
    db: D1Database,
    _siteId?: string
): Promise<number> {
    const row = await db.prepare(
        `SELECT COUNT(*) as count FROM themes WHERE deleted_at IS NULL`
    ).first<{ count: number }>();
    return row?.count || 0;
}

export async function isThemeActiveOnAnySite(
    db: D1Database,
    themeId: string,
    themeSlug?: string
): Promise<boolean> {
    const row = await db.prepare(
        `SELECT id FROM sites WHERE status = 'active' AND (theme_id = ? OR theme_id = ?) LIMIT 1`
    ).bind(themeId, themeSlug || themeId).first<{ id: string }>();
    return Boolean(row);
}

export async function findSiteIdsUsingTheme(
    db: D1Database,
    themeId: string,
    themeSlug?: string
): Promise<string[]> {
    const { results } = await db.prepare(
        `SELECT id FROM sites WHERE status = 'active' AND (theme_id = ? OR theme_id = ?)`
    ).bind(themeId, themeSlug || themeId).all<{ id: string }>();
    return (results || []).map(r => r.id);
}

export function buildSoftDeleteThemeStatement(
    db: D1Database,
    themeId: string,
    _siteId?: string
): D1PreparedStatement {
    return db.prepare(
        `UPDATE themes SET deleted_at = CURRENT_TIMESTAMP, is_active = 0 WHERE id = ?`
    ).bind(themeId);
}

export function buildRestoreThemeStatement(
    db: D1Database,
    themeId: string,
    _siteId?: string
): D1PreparedStatement {
    return db.prepare(
        `UPDATE themes SET deleted_at = NULL WHERE id = ?`
    ).bind(themeId);
}

export function buildPurgeThemeStatements(
    db: D1Database,
    themeId: string,
    _siteId?: string
): D1PreparedStatement[] {
    return [
        db.prepare(`DELETE FROM entity_versions WHERE entity_type = 'theme' AND entity_id = ?`).bind(themeId),
        db.prepare(`DELETE FROM themes WHERE id = ?`).bind(themeId)
    ];
}

export function buildRollbackThemeStatement(
    db: D1Database,
    themeId: string,
    metadataSnapshot: string,
    versionTag: string,
    versionId: string
): D1PreparedStatement {
    return db.prepare(`
        UPDATE themes
        SET version = ?, metadata = ?, current_version_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).bind(versionTag, sanitizeThemeMetadataJson(metadataSnapshot), versionId, themeId);
}

export async function findThemeVersionByIdOrNumber(
    db: D1Database,
    themeId: string,
    versionId?: string,
    versionNumber?: number
): Promise<any> {
    return await findEntityVersionByIdOrNumber(db, 'theme', themeId, versionId, versionNumber);
}

export async function findThemeRawById(
    db: D1Database,
    themeId: string,
    _siteId?: string
): Promise<{ id: string; deleted_at: string | null } | null> {
    return await db.prepare(
        `SELECT id, deleted_at FROM themes WHERE id = ? LIMIT 1`
    ).bind(themeId).first<{ id: string; deleted_at: string | null }>();
}

export async function checkThemeSlugExists(
    db: D1Database,
    _siteId: string,
    slug: string
): Promise<boolean> {
    const row = await db.prepare(
        `SELECT id FROM themes WHERE slug = ? AND deleted_at IS NULL LIMIT 1`
    ).bind(slug).first<{ id: string }>();
    return Boolean(row);
}

