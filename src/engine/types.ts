import type { Context } from 'hono';
import type { D1Database, R2Bucket, KVNamespace, ExecutionContext } from '@cloudflare/workers-types';
import type { DAL } from './dal';

export interface EngineStorageBindings {
    DB: D1Database;
    BUCKET: R2Bucket;
    BUCKET_BACKUP?: R2Bucket;
    KV?: KVNamespace;
    AI?: any;
}

export type GlobalRole = 'superadmin' | 'user';
export type SiteRole = 'admin' | 'visitor';

export interface User {
    id: string;
    email: string;
    username: string;
    password_hash?: string | null;
    cf_access_sub?: string | null;
    global_role: GlobalRole;
    avatar_url?: string | null;
    created_at: string;
    updated_at: string;
}

export interface AuthenticatedUser {
    id: string;
    email: string;
    username: string;
    global_role: GlobalRole;
    site_role?: SiteRole;
    metadata?: Record<string, any>;
    auth_provider: 'cf_access' | 'password' | 'session' | 'api_token';
    token_site_id?: string;
}

export interface SiteMember {
    id: string;
    site_id: string;
    user_id: string;
    role: SiteRole;
    created_at: string;
}

export interface AppContextVariables {
    locale: string;
    actualPath: string;
    host: string;
    siteId?: string;
    siteDomain?: string;
    user?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    cfAccessEmail?: string;
    pluginEngine: IPluginEngine;
    dal: DAL;
    [key: string]: any;
}

export type AppHonoEnv = {
    Bindings: EngineStorageBindings & {
        ENVIRONMENT?: 'development' | 'production' | 'test';
        CF_ACCESS_TEAM_NAME?: string;
        CF_ACCESS_AUD?: string;
        PUBLIC_ASSETS_DOMAIN?: string;
        LICENSE_KEY?: string;
        SESSION_SECRET?: string;
        [key: string]: any;
    };
    Variables: AppContextVariables;
};

export interface SiteSettings {
    site_name?: string;
    subtitle?: string;
    description?: string;
    copyright?: string;
    timezone?: string;
    license_key?: string;
    whitelabel?: {
        brand_name?: string;
        system_title?: string;
        provider_name?: string;
        logo_url?: string;
        favicon_url?: string;
        login_banner_url?: string;
        copyright?: string;
        copyright_text?: string;
        support_url?: string;
        hide_powered_by?: boolean;
        remove_powered_by?: boolean;
        custom_powered_by?: string;
    };
    favicon_url?: string;
    logo_url?: string;
    title_template?: string;
    theme_name?: string;
    default_template_page_id?: string;
    default_template_slug?: string;
    site_mode?: 'standard' | 'internal';
    internal?: {
        status_code?: 503 | 404 | 301 | 302;
        redirect_url?: string;
        title?: string;
        message?: string;
        retry_after?: number;
    };
    sitemap_domain?: string;
    robots_control?: string;
    google_analytics_id?: string;
    seo?: {
        keywords?: string[];
        og_image?: string;
        og_use_first_image?: boolean;
        google_site_verification?: string;
        ga_id?: string;
        robots?: string;
        custom_header_html?: string;
        footer_scripts?: string;
        description?: string;
        sitemap_domain?: string;
    };
    appearance?: {
        theme_mode?: 'system' | 'dark' | 'light';
        brand_color?: string;
        primary_color?: string;
        primary_color_dark?: string;
        footer_links?: string;
    };
    primary_color?: string;
    primary_color_dark?: string;
    routing?: {
        maintenance_mode?: number;
    };
    security?: {
        anti_hotlink_enabled?: boolean;
        allowed_origins?: string[];
    };
    quick_action_shortcut?: string;
    theme_overrides?: Record<string, any>;
    [key: string]: any;
}

export interface Site {
    id: string;
    name: string;
    primary_domain: string;
    custom_domains?: string[];
    default_locale: string;
    theme_id?: string | null;
    license_key?: string;
    settings?: SiteSettings;
    robots_txt?: string | null;
    status: 'active' | 'suspended';
    created_at: string;
    updated_at: string;
}

export type ArticleStatus = 'draft' | 'published' | 'archived' | 'scheduled';
export type MicroProgress = 'none' | 'draft' | 'in-progress' | 'done' | 'highlight' | 'bookmark' | (string & {});
export type ArticleMaturity = MicroProgress;

export interface Article {
    id: string;
    site_id: string;
    slug: string;
    locale: string;
    translation_group_id?: string | null;
    status: ArticleStatus;
    maturity?: ArticleMaturity;
    password?: string | null;
    title: string;
    summary?: string | null;
    cover_image_url?: string | null;
    metadata?: Record<string, any>;
    current_version_id?: string | null;
    curator_id: string;
    published_at?: string | null;
    created_at: string;
    updated_at: string;
    deleted_at?: string | null;
}

export interface ArticleVersion {
    id: string;
    article_id: string;
    version_number: number;
    title: string;
    summary?: string | null;
    content_raw: string;
    content_rendered?: string | null;
    metadata_snapshot?: Record<string, any> | string | null;
    commit_message?: string | null;
    author_id: string;
    created_at: string;
    deleted_at?: string | null;
}

export interface Page {
    id: string;
    site_id: string;
    slug: string;
    parent_id?: string | null;
    locale: string;
    status: string;
    title: string;
    summary?: string | null;
    cover_image_url?: string | null;
    metadata?: any;
    current_version_id?: string | null;
    curator_id: string;
    published_at?: string | null;
    created_at: string;
    updated_at: string;
    deleted_at?: string | null;
}

export interface PageVersion {
    id: string;
    page_id: string;
    version_number: number;
    title: string;
    summary?: string | null;
    content_raw: string;
    content_rendered?: string | null;
    metadata_snapshot?: any;
    commit_message?: string | null;
    author_id: string;
    created_at: string;
    deleted_at?: string | null;
}

export interface DatasetCollection {
    id: string;
    site_id: string;
    slug: string;
    name: string;
    schema_key: string;
    description?: string | null;
    item_count?: number;
    latest_updated_at?: string;
    created_at: string;
    updated_at: string;
    deleted_at?: string | null;
}

export interface Dataset {
    id: string;
    site_id: string;
    collection_id?: string | null;
    schema_slug: string;
    slug: string;
    title: string;
    summary?: string | null;
    metadata?: Record<string, any> | string;
    status: string;
    sort_order?: number;
    curator_id?: string;
    current_version_id?: string | null;
    created_at: string;
    updated_at: string;
    deleted_at?: string | null;
}

export interface MediaAsset {
    id: string;
    site_id: string;
    file_name: string;
    file_size: number;
    mime_type: string;
    r2_key: string;
    public_url: string;
    metadata?: any;
    is_public: number;
    uploader_id: string;
    created_at: string;
    deleted_at?: string | null;
}

export interface Theme {
    id: string;
    site_id: string;
    slug: string;
    name: string;
    author?: string | null;
    version: string;
    description?: string | null;
    preview_image?: string | null;
    is_active: number;
    status: string;
    metadata?: any;
    current_version_id?: string | null;
    created_at: string;
    updated_at: string;
    deleted_at?: string | null;
}

export type TaskType =
    | 'publish_node'
    | 'scheduled_unpublish'
    | 'purge_deleted'
    | 'archive_analytics'
    | 'vacuum_db'
    | 'calibrate_storage_usage'
    | 'generate_visitor_page_index'
    | 'recompile_dirty_routes'
    | 'update_sitemap'
    | 'cache_warmup'
    | 'traffic_metrics_sync'
    | 'd1_backup'
    | 'r2_scheduled_backup'
    | 'webhook_retry_sweep'
    | 'topology_health_audit'
    | 'external_worker_call';

export type TaskScheduleType = 'once' | 'recurring';
export type TaskIntervalPreset = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

export interface ScheduledTask {
    id: string;
    site_id?: string | null;
    task_type: TaskType;
    schedule_type?: TaskScheduleType;
    interval_preset?: TaskIntervalPreset | string | null;
    payload?: Record<string, any>;
    cron_interval_minutes: number;
    next_run_at: string;
    last_run_at?: string | null;
    last_result?: string | null;
    status: string;
    created_at: string;
}

export interface ThemeComponentDataSlot {
    key: string;
    label?: string;
    required?: boolean;
}

export function normalizeThemeComponentDataSlots(raw: unknown): ThemeComponentDataSlot[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    return raw
        .filter((s: any) => s && typeof s === 'object' && typeof s.key === 'string' && s.key.trim().length > 0)
        .map((s: any) => ({
            key: String(s.key).trim(),
            ...(typeof s.label === 'string' && s.label.trim() ? { label: s.label.trim() } : {}),
            ...(s.required === true ? { required: true } : {})
        }));
}

export interface UiSchemaField {
    key: string;
    label?: string;
    title?: string;
    name?: string;
    type?: 'text' | 'textarea' | 'markdown' | 'number' | 'boolean' | 'switch' | 'select' | 'image' | 'url' | 'list' | 'array' | 'json' | string;
    widget?: string;
    default?: any;
    placeholder?: string;
    group?: string;
    required?: boolean;
    options?: Array<string | { label: string; value: any }>;
    item_fields?: any[];
    item_schema?: any[] | { fields?: any[] };
    [key: string]: any;
}

export interface ThemeComponentManifest {
    slug: string;
    type?: string;
    name: string;
    category?: 'layout' | 'marketing' | 'content' | 'data' | 'custom' | string;
    icon?: string;
    description?: string;
    preview_image?: string;

    /** Allowed slot whitelist; index 0 is the default slot (defaults to ['main']). */
    slots?: string[];

    /** Supports inline {{#each}} loops and @api: data-source prefixes in prop values. */
    template_html: string;
    default_props?: Record<string, any>;

    base_hash?: string;
    local_hash?: string;
    modified_locally?: boolean;
    upstream_conflict?: boolean;
    upstream_template?: string;

    /** Opt-in flag enabling component-scoped custom_js tab & persistence; disabled unless strictly true. */
    allow_custom_js?: boolean;
    template_path?: string;
    schema_binding?: string;
    hydration?: 'none' | 'instant' | 'idle' | 'visible';
    keep_field?: string[];
    /** Optional semantic data slots exposed for PageEditor field_map binding. */
    data_slots?: ThemeComponentDataSlot[];
    field_map?: {
        dataset_type: string;
        mappings: Record<string, string>;
    };
    ui_schema?: UiSchemaField[];
    version?: number;
    itemCardTemplate?: string;
    backlinkItemTemplate?: string;
    schema?: any;
    contenteditable?: boolean;
    [key: string]: any;
}

export const ThemeComponentManifestZod = {
    safeParse: (input: unknown): { success: true; data: ThemeComponentManifest; error: undefined } | { success: false; data: undefined; error: { issues: any[] } } => {
        if (!input || typeof input !== 'object') {
            return { success: false, data: undefined, error: { issues: [{ message: 'Expected object' }] } };
        }
        const obj = input as any;
        const resolvedSlug = typeof obj.slug === 'string' ? obj.slug : (typeof obj.type === 'string' ? obj.type : '');
        if (!resolvedSlug || typeof obj.name !== 'string') {
            return { success: false, data: undefined, error: { issues: [{ message: 'Missing slug/type or name' }] } };
        }
        const resolvedTemplateHtml = typeof obj.template_html === 'string'
            ? obj.template_html
            : (typeof obj.templateHtml === 'string' ? obj.templateHtml : '');
        const allowCustomJs = obj.allow_custom_js === true;
        const resolvedDefaultProps = (typeof obj.default_props === 'object' && obj.default_props !== null)
            ? { ...obj.default_props }
            : {};
        if (!allowCustomJs) {
            delete resolvedDefaultProps.custom_js;
        }
        const resolvedSlots = Array.isArray(obj.slots) && obj.slots.length > 0
            ? obj.slots.map((s: any) => String(s))
            : (typeof obj.slot === 'string' && obj.slot ? [obj.slot] : ['main']);
        const sanitizedObj = { ...obj };
        if (!allowCustomJs) {
            delete sanitizedObj.custom_js;
        }
        const normalizedDataSlots = normalizeThemeComponentDataSlots(obj.data_slots);
        return {
            success: true,
            data: {
                ...sanitizedObj,
                slug: resolvedSlug,
                type: resolvedSlug,
                allow_custom_js: allowCustomJs,
                template_html: resolvedTemplateHtml,
                default_props: resolvedDefaultProps,
                slots: resolvedSlots,
                ...(normalizedDataSlots && normalizedDataSlots.length > 0 ? { data_slots: normalizedDataSlots } : {}),
                category: typeof obj.category === 'string' ? obj.category : 'content',
                icon: typeof obj.icon === 'string' ? obj.icon : 'widgets',
                description: typeof obj.description === 'string' ? obj.description : '',
                hydration: ['none', 'instant', 'idle', 'visible'].includes(obj.hydration) ? obj.hydration : 'idle',
                keep_field: Array.isArray(obj.keep_field) ? obj.keep_field : [],
                ui_schema: Array.isArray(obj.ui_schema) ? obj.ui_schema : [],
                version: typeof obj.version === 'number' ? obj.version : 1,
                contenteditable: Boolean(obj.contenteditable)
            },
            error: undefined
        };
    }
};
export const ThemeComponentManifestSchema = ThemeComponentManifestZod;

export interface ThemeManifest {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    default_locale?: string;
    locales?: string[];
    color_schemes?: Array<'light' | 'dark'>;
    global_assets?: {
        styles?: string[];
        scripts?: string[];
    };
    layouts?: any[];
    presets?: any[];
    components?: any[];
    dataset_templates?: any[];
    [key: string]: any;
}

export const ThemeManifestZod = {
    safeParse: (input: unknown): { success: true; data: ThemeManifest; error: undefined } | { success: false; data: undefined; error: { issues: any[] } } => {
        if (!input || typeof input !== 'object') {
            return { success: false, data: undefined, error: { issues: [{ message: 'Expected object' }] } };
        }
        const obj = input as any;
        if (typeof obj.id !== 'string' || typeof obj.name !== 'string' || typeof obj.version !== 'string') {
            return { success: false, data: undefined, error: { issues: [{ message: 'Missing id, name or version' }] } };
        }
        const rawSchemes = Array.isArray(obj.color_schemes)
            ? obj.color_schemes.filter((s: unknown): s is 'light' | 'dark' => s === 'light' || s === 'dark')
            : [];
        return {
            success: true,
            data: {
                ...obj,
                description: typeof obj.description === 'string' ? obj.description : '',
                author: typeof obj.author === 'string' ? obj.author : '',
                default_locale: typeof obj.default_locale === 'string' ? obj.default_locale : 'zh-CN',
                locales: (obj.locales && typeof obj.locales === 'object' && !Array.isArray(obj.locales))
                    ? obj.locales
                    : (Array.isArray(obj.locales) ? obj.locales : ['zh-CN', 'en-US']),
                color_schemes: Array.from(new Set(rawSchemes.length > 0 ? rawSchemes : ['light', 'dark'])),
                global_assets: {
                    styles: Array.isArray(obj.global_assets?.styles) ? obj.global_assets.styles : [],
                    scripts: Array.isArray(obj.global_assets?.scripts) ? obj.global_assets.scripts : []
                },
                layouts: Array.isArray(obj.layouts) ? obj.layouts : [],
                templates: Array.isArray(obj.templates) ? obj.templates : [],
                presets: Array.isArray(obj.presets) ? obj.presets : [],
                components: Array.isArray(obj.components) ? obj.components : [],
                dataset_templates: Array.isArray(obj.dataset_templates) ? obj.dataset_templates : []
            },
            error: undefined
        };
    }
};
export const ThemeManifestSchema = ThemeManifestZod;

export type ActionType =
    | '*'
    | 'ARTICLE_SAVE'
    | 'ARTICLE_CHUNK_SAVE'
    | 'ARTICLE_BATCH_IMPORT'
    | 'CONTENT_BATCH_EXPORT'
    | 'CONTENT_BATCH_IMPORT'
    | 'API_TOKEN_GENERATE'
    | 'API_TOKEN_VERIFY'
    | 'API_EXTERNAL_DISPATCH'
    | 'API_TOKEN_REVOKE'
    | 'ECOSYSTEM_ENTITY_SYNC'
    | 'ARTICLE_DELETE'
    | 'ARTICLE_RESTORE'
    | 'ARTICLE_PURGE'
    | 'PAGE_SAVE'
    | 'PAGE_DELETE'
    | 'PAGE_RESTORE'
    | 'PAGE_PURGE'
    | 'PAGE_SET_DEFAULT_TEMPLATE'
    | 'MICRO_SAVE'
    | 'MICRO_DELETE'
    | 'MICRO_RESTORE'
    | 'MICRO_PURGE'
    | 'DATASET_SAVE'
    | 'DATASET_DELETE'
    | 'DATASET_RESTORE'
    | 'DATASET_PURGE'
    | 'DATASET_BATCH_IMPORT'
    | 'CONTENT_DELETE'
    | 'CONTENT_RESTORE'
    | 'CONTENT_PURGE'
    | 'CONTENT_BATCH_RESTORE'
    | 'CONTENT_BATCH_HARD_DELETE'
    | 'NODE_SAVE'
    | 'NODE_CREATE'
    | 'NODE_UPDATE'
    | 'NODE_DELETE'
    | 'NODE_RESTORE'
    | 'NODE_BATCH_SOFT_DELETE'
    | 'NODE_BATCH_MOVE_FOLDER'
    | 'VERSION_RESTORE'
    | 'VERSION_DELETE'
    | 'VERSION_HARD_DELETE'
    | 'TRASH_EMPTY'
    | 'TRANSLATION_GROUP_CREATE'
    | 'TRANSLATION_GROUP_DELETE'
    | 'TRANSLATION_GROUP_JOIN'
    | 'TRANSLATION_GROUP_LEAVE'
    | 'SCHEMA_CREATE'
    | 'SCHEMA_DELETE'
    | 'SITE_CREATE'
    | 'SITE_UPDATE'
    | 'SITE_DELETE'
    | 'SITE_CLONE'
    | 'USER_CREATE'
    | 'USER_UPDATE'
    | 'USER_DELETE'
    | 'SETTINGS_UPDATE'
    | 'SETTINGS_SAVE'
    | 'TASK_CREATE'
    | 'TASK_TRIGGER'
    | 'MEDIA_DELETE'
    | 'MEDIA_RESTORE'
    | 'MEDIA_PURGE'
    | 'MEDIA_BATCH_DELETE'
    | 'MEDIA_BATCH_MOVE_FOLDER'
    | 'SYSTEM_BACKUP_TRIGGER'
    | 'THEME_IMPORT'
    | 'THEME_CHUNK_INIT'
    | 'THEME_CHUNK_ASSET'
    | 'THEME_CHUNK_BLOCKS'
    | 'THEME_CHUNK_FINISH'
    | 'THEME_ACTIVATE'
    | 'THEME_SWITCH'
    | 'THEME_REPO_IMPORT'
    | 'THEME_UPDATE'
    | 'THEME_ROLLBACK'
    | 'THEME_DELETE'
    | 'THEME_RESTORE'
    | 'THEME_PURGE'
    | 'FORM_CAPTURE_SUBMIT'
    | 'WEBHOOK_SUBMIT'
    | 'WEBHOOK_CONFIG_SAVE'
    | 'WEBHOOK_CONFIG_DELETE'
    | 'WEBHOOK_LOGS_QUERY'
    | 'WEBHOOK_TEST_TRIGGER'
    | 'WORKER_BRIDGE_LIST'
    | 'WORKER_BRIDGE_SAVE'
    | 'WORKER_BRIDGE_DELETE'
    | 'WORKER_BRIDGE_PROXY'
    | 'WORKER_BRIDGE_RESOLVE_PUBLIC'
    | (string & {});

export type WalnutEnvBindings = EngineStorageBindings & {
    ENVIRONMENT?: 'development' | 'production' | 'test';
    CF_ACCESS_TEAM_NAME?: string;
    CF_ACCESS_AUD?: string;
    ALLOW_INSECURE_DEV_CF_ACCESS?: string;
    DEV_CF_ACCESS_EMAIL?: string;
    PUBLIC_ASSETS_DOMAIN?: string;
    LICENSE_KEY?: string;
    SESSION_SECRET?: string;
    AUTHER_KEY_PUBLIC?: string;
    AGENCY_KEY_PUBLIC?: string;
    CF_ACCOUNT_ID?: string;
    [key: string]: any;
};

export interface HookContext<TData = any, TResult = any> {
    action: ActionType;
    data: TData;
    result?: TResult;
    env: WalnutEnvBindings;
    executionCtx?: ExecutionContext;
    dal: DAL;
    user?: AuthenticatedUser | null;
    siteId?: string;
    clientIp: string;
    host: string;
    locale: string;
    meta: Record<string, any>;
    c?: Context<AppHonoEnv>;
    metadata?: Record<string, any>;
    [key: string]: any;
}

export interface CreateHookContextOptions<TData = any> {
    action: ActionType;
    data: TData;
    c?: Context<AppHonoEnv>;
    env?: WalnutEnvBindings;
    executionCtx?: ExecutionContext;
    dal?: DAL;
    user?: AuthenticatedUser | null;
    siteId?: string;
    clientIp?: string;
    host?: string;
    locale?: string;
    meta?: Record<string, any>;
    metadata?: Record<string, any>;
}

export type BeforeHookHandler<TData = any> = (
    ctx: HookContext<TData>
) => Promise<void> | void;

export type ServiceHandler<TData = any, TResult = any> = (
    ctx: HookContext<TData, TResult>
) => Promise<TResult> | TResult;

export type AfterHookHandler<TData = any, TResult = any> = (
    ctx: HookContext<TData, TResult>
) => Promise<void> | void;

export interface QuickActionItem {
    cmd: string;
    label: string;
    action: string;
    labelKey?: string;
    descriptionKey?: string;
    tier?: 'community' | 'personal' | 'agency';
    description?: string;
    id?: string;
    title?: string;
    subtitle?: string;
    category?: string;
    handlerUrl?: string;
    icon?: string;
    shortcut?: string;
    [key: string]: any;
}

export interface IPluginEngine {
    tapBefore<TData = any>(action: ActionType, handler: BeforeHookHandler<TData>): this;
    registerService<TData = any, TResult = any>(action: ActionType, handler: ServiceHandler<TData, TResult>): this;
    tapAfter<TData = any, TResult = any>(action: ActionType, handler: AfterHookHandler<TData, TResult>): this;
    runPipeline<TData = any, TResult = any>(ctx: HookContext<TData, TResult>): Promise<TResult>;
    hasService(action: ActionType): boolean;
    setFirewallHandler?(handler: (ip: string, isWrite: boolean, reqUrl: URL, env: any, reqHeaders?: Headers) => Promise<{ allowed: boolean; status?: number; reason?: string }> | { allowed: boolean; status?: number; reason?: string }): void;
    checkFirewall?(ip: string, isWrite: boolean, reqUrl: URL, env: any, reqHeaders?: Headers): Promise<{ allowed: boolean; status?: number; reason?: string }>;
    registerPlugin(plugin: WalnutPlugin): this;
    registerPlugins(plugins: WalnutPlugin[]): this;
    registerQuickAction(action: QuickActionItem): this;
    getQuickActions(licenseTier?: string): QuickActionItem[];
    hasCommercialPlugins(): boolean;
}

export interface WalnutPlugin {
    name: string;
    version?: string;
    tier?: 'community' | 'personal' | 'agency';
    description?: string;
    setup(engine: IPluginEngine): void | Promise<void>;
}
