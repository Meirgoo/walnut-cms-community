import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, formatSiteDateTime, getUserTimezone, SUPPORTED_TIMEZONES, normalizeTimezoneOptionValue, parseJson, t } from '../../engine';

export const UserProfilePage = async (props: {
    user?: AuthenticatedUser;
    cfAccessEmail?: string;
    userMeta?: Record<string, any>;
    recentLogs?: Array<{ id: string; action: string; status: string; ip_address?: string; created_at: string }>;
    sites: Site[];
    currentSiteId: string;
    isSuperAdmin?: boolean;
    canUseFeature?: (feature?: string) => boolean;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const isCommercial = props.canUseFeature ? props.canUseFeature('cms:*') : false;
    const i18n = getAdminI18nSlice(locale, ['profile', 'users', 'common', 'logs', 'settings']);

    const userProfileTemplate = await fetchAsset('/admin/pages/user-profile.html');
    const user = props.user || ({} as AuthenticatedUser);
    const isSuperAdmin = props.isSuperAdmin || user.global_role === 'superadmin';
    const cfAccessEmail = props.cfAccessEmail || '';
    const userMeta = props.userMeta || {};
    const prefTz = userMeta.timezone && userMeta.timezone !== 'auto'
        ? normalizeTimezoneOptionValue(userMeta.timezone)
        : 'auto';
    const prefSplit = userMeta.editor_split_mode || 'split';
    const prefPageSize = String(userMeta.list_page_size || 20);
    const activeSite = (props.sites || []).find(s => s.id === props.currentSiteId) || (props.sites || [])[0];
    const activeSiteSettings = parseJson<Record<string, any>>(activeSite?.settings, {});
    const quickActionShortcut = userMeta.quick_action_shortcut || activeSiteSettings.quick_action_shortcut || 'alt+k,cmd+k';
    const displayTz = getUserTimezone({ ...user, metadata: userMeta } as any, activeSite);

    const recentLogs = props.recentLogs || [];
    const recentLogsHtml = recentLogs.length === 0
        ? `<div class="h-11 px-3 flex items-center justify-center text-xs text-stone-400 italic">${i18n.profile.recent_activity_empty}</div>`
        : recentLogs.map(l => {
            const actionKey = 'logs.action_' + (l.action || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
            const locAct = t(locale, actionKey);
            const label = locAct !== actionKey ? locAct : l.action;
            const dotCls = l.status === 'success' ? 'bg-amber-500' : 'bg-red-500';
            return `<div class="h-11 px-3 flex items-center justify-between gap-3 border-b border-stone-100 dark:border-stone-700/60 last:border-b-0 text-xs">
                <div class="flex items-center space-x-2.5 min-w-0">
                    <span class="w-2 h-2 rounded-full ${dotCls} shrink-0"></span>
                    <span class="font-semibold text-stone-800 dark:text-stone-200 truncate">${label}</span>
                    <span class="text-[11px] font-mono text-stone-400 shrink-0 hidden sm:inline">${l.ip_address || '-'}</span>
                </div>
                <span class="text-[11px] font-mono text-stone-400 shrink-0">${formatSiteDateTime(l.created_at, locale, displayTz)}</span>
            </div>`;
        }).join('');

    const roleBadgeClass = isSuperAdmin
        ? 'list-pill list-pill-locale-active'
        : 'list-pill list-pill-draft';
    const roleBadgeText = isSuperAdmin
        ? (i18n.role_superadmin || 'Super Admin')
        : (user.site_role === 'admin' ? (i18n.role_admin || 'Site Admin') : (i18n.role_visitor || 'Visitor'));

    const pageHtml = renderTemplate(userProfileTemplate, {
        page_title: i18n.user_settings,
        page_subtitle: i18n.user_settings_desc,
        user_id: user.id || '',
        avatar_initial: (user.username || user.email || 'A').slice(0, 1).toUpperCase(),
        username: user.username || user.email || 'Admin',
        role_badge_class: roleBadgeClass,
        role_badge_text: roleBadgeText,
        email: user.email || '',
        account_profile_title: i18n.profile.account_title,
        field_global_role: i18n.field_user_role,
        global_role: user.global_role || 'user',
        field_site_role: i18n.field_user_site_role,
        site_role: user.site_role || 'admin',
        cf_access_email: cfAccessEmail || i18n.cf_not_detected,
        cf_access_display: cfAccessEmail || i18n.cf_not_linked,
        cf_quick_auth_class: (isSuperAdmin && Boolean(cfAccessEmail) && user.auth_provider === 'cf_access') ? '' : 'hidden',
        auth_mode_selector_class: (isSuperAdmin && Boolean(cfAccessEmail) && user.auth_provider === 'cf_access') ? '' : 'hidden',
        pref_tz_options_html: [
            ['auto', i18n.profile.pref_tz_auto],
            ...SUPPORTED_TIMEZONES.map(tz => [tz.value, locale === 'en-US' ? tz.labelEn : tz.labelZh] as [string, string])
        ].map(([v, l]) => `<option value="${v}"${prefTz === v ? ' selected' : ''}>${l}</option>`).join(''),
        pref_split_options_html: [
            ['split', i18n.profile.pref_editor_split],
            ['source', i18n.profile.pref_editor_source],
            ['preview', i18n.profile.pref_editor_preview]
        ].map(([v, l]) => `<option value="${v}"${prefSplit === v ? ' selected' : ''}>${l}</option>`).join(''),
        pref_size_options_html: ['20', '50', '100']
            .map(v => `<option value="${v}"${prefPageSize === v ? ' selected' : ''}>${v}</option>`).join(''),
        pref_palette_options_html: [
            ['walnut', i18n.profile.palette_walnut],
            ['monochrome', i18n.profile.palette_monochrome],
            ['cosmic', i18n.profile.palette_cosmic]
        ].map(([v, l]) => `<option value="${v}">${l}</option>`).join(''),
        quick_action_shortcut: quickActionShortcut,
        recent_activity_card_class: isCommercial ? '' : 'hidden',
        recent_logs_html: recentLogsHtml
    }, i18n);

    return (
        <AdminLayout
            title={i18n.user_settings}
            {...props}
            currentUser={user}
            isSuperAdmin={isSuperAdmin}
            locale={locale}
            clientI18nSections={['profile', 'common', 'settings']}
        >
            {raw(pageHtml)}
        </AdminLayout>
    );
};
