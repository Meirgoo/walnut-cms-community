import { html, raw } from 'hono/html';
import type { AuthenticatedUser, Site } from '../engine';
import { fetchAsset, renderTemplate, getAdminI18nSlice, getClientJsI18nSlice, resolveSiteBrandInfo, SUPPORTED_LOCALES, t, getInlineI18nScript, getUserTimezone, formatTimezoneOffsetLabel, parseJson, getCommercialSnippet, buildAbsoluteUrl, normalizeHostKey } from '../engine';
import { ENGINE_CORE_VERSION, isFeatureEnabled } from '../engine';

export interface AdminLayoutProps {
    title: string;
    children: any;
    sites?: Site[];
    currentSiteId?: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    canUseFeature?: (feature?: string) => boolean;
    locale?: string;
    clientI18nSections?: string[];
}

export const AdminLayout = async (props: AdminLayoutProps) => {
    const locale = props.locale || 'zh-CN';
    const sites = props.sites || [];
    const currentSite = sites.find(s => s.id === props.currentSiteId) || sites[0];
    const isCommercial = props.canUseFeature ? props.canUseFeature('cms:*') : false;
    const i18n = getAdminI18nSlice(locale, 'nav');

    const adminLayoutTemplate = await fetchAsset('/admin/layouts/admin-layout.html');
    const adminSidebarTemplate = await fetchAsset('/admin/navigation/admin-sidebar.html');
    const siteSwitcherTemplate = await fetchAsset('/admin/navigation/site-switcher.html');
    const siteOptionTemplate = await fetchAsset('/admin/snippets/site-option-item.html');

    const siteOptionsHtml = sites.map(s => renderTemplate(siteOptionTemplate, {
        site_id: s.id,
        site_name: s.name,
        primary_domain: s.primary_domain,
        active_class: s.id === currentSite?.id ? 'text-amber-400 font-bold bg-stone-800/40' : '',
    })).join('');

    const activeSiteBlock = renderTemplate(siteSwitcherTemplate, {
        current_site_id: currentSite?.id || '',
        current_site_name: currentSite?.name || i18n.default_site,
        dropdown_arrow_class: (props.isSuperAdmin || sites.length > 1) ? '' : 'hidden',
        site_options_html: siteOptionsHtml,
        new_site_wizard_class: props.isSuperAdmin ? '' : 'hidden',
    }, i18n);

    let commercialSidebarMenuHtml = '';
    if (isCommercial) {
        const commercialSidebarTpl = getCommercialSnippet('sidebar-menu-item.html');
        if (commercialSidebarTpl) {
            commercialSidebarMenuHtml = renderTemplate(commercialSidebarTpl, {
                wiki_nav_class: '',
                logs_nav_class: '',
                webhooks_nav_class: '',
            }, i18n);
        }
    }

    const brandInfo = resolveSiteBrandInfo(currentSite);
    const systemTitle = brandInfo.hasStickyWhitelabel
        ? brandInfo.systemTitle
        : (currentSite?.name ? `${currentSite.name} Admin` : (i18n.nav_title || 'Content Management System'));
    const providerName = brandInfo.providerName;
    const customFavicon = brandInfo.faviconUrl || '/favicon.ico';
    const brandLogoHtml = brandInfo.logoUrl
        ? `<img src="${brandInfo.logoUrl}" class="h-6 w-6 object-contain rounded shrink-0 mr-1.5" alt="Logo" />`
        : '';
    const supportLabel = t(locale, 'common.contact_support') || 'Contact Support';
    const supportLinkHtml = brandInfo.supportUrl
        ? `<a href="${brandInfo.supportUrl}" target="_blank" rel="noopener noreferrer" class="sidebar-item flex items-center px-2.5 py-1.5 rounded-lg text-xs font-semibold text-amber-400 hover:text-amber-300 hover:bg-stone-800 transition group whitespace-nowrap" title="${supportLabel}"><span class="icon material-symbols-outlined text-[19px] mr-2.5 text-amber-400 shrink-0">support_agent</span><span class="sidebar-text truncate">${supportLabel}</span></a>`
        : '';

    const sidebarBrandTitle = brandInfo.hasStickyWhitelabel
        ? (brandInfo.effectiveWhitelabel?.brand_name || brandInfo.effectiveWhitelabel?.system_title || 'CMS')
        : 'Walnut Edge';
    const SIDEBAR_SHORT_LOCALE_LABELS: Record<string, string> = {
        'zh-CN': t(locale, 'nav.locale_short_zh'),
        'en-US': t(locale, 'nav.locale_short_en')
    };
    const sidebarLocaleOptionsHtml = Object.entries(SUPPORTED_LOCALES).map(([val, label]) =>
        `<option value="${val}" ${val === locale ? 'selected' : ''}>${SIDEBAR_SHORT_LOCALE_LABELS[val] || label}</option>`
    ).join('');

    const userMetaObj = parseJson<Record<string, any>>((props.currentUser as any)?.metadata, {});
    const userHasExplicitTz = Boolean(userMetaObj && userMetaObj.timezone);
    const userTimezone = getUserTimezone(props.currentUser, currentSite);
    const userTzOffset = formatTimezoneOffsetLabel(userTimezone);

    const currentDomain = currentSite?.primary_domain || '';
    const hasCustomDomain = Boolean(currentDomain && currentDomain !== '*' && normalizeHostKey(currentDomain) !== 'localhost' && !normalizeHostKey(currentDomain).startsWith('localhost:'));
    const previewSiteUrl = hasCustomDomain ? buildAbsoluteUrl('/?preview=1', currentDomain) : '/?preview=1';

    const sidebarHtml = renderTemplate(adminSidebarTemplate, {
        system_title: systemTitle,
        nav_title: systemTitle,
        preview_site_url: previewSiteUrl,
        sidebar_brand_title: sidebarBrandTitle,
        sidebar_brand_initial: sidebarBrandTitle.slice(0, 1).toUpperCase(),
        active_site_initial: (currentSite?.name || 'S').slice(0, 1).toUpperCase(),
        active_site_name: currentSite?.name || '',
        topology_nav_class: isFeatureEnabled('topology') ? '' : 'hidden',
        brand_logo_html: brandLogoHtml,
        support_link_html: supportLinkHtml,
        superadmin_badge_class: props.isSuperAdmin ? '' : 'hidden',
        active_site_block: activeSiteBlock,
        slot_commercial_sidebar_menu: commercialSidebarMenuHtml,
        audit_nav_class: '',
        tasks_nav_class: '',
        engine_version: ENGINE_CORE_VERSION,
        user_timezone: userTimezone,
        user_tz_offset: userTzOffset,
        user_has_explicit_tz: userHasExplicitTz ? 'true' : 'false',
        sidebar_locale_options_html: sidebarLocaleOptionsHtml,
        locale_zh_label: SUPPORTED_LOCALES['zh-CN'] || '',
        locale_en_label: SUPPORTED_LOCALES['en-US'] || 'English',
        locale_zh_selected: locale === 'zh-CN' ? 'selected' : '',
        locale_en_selected: locale === 'en-US' ? 'selected' : '',
        user_email: props.currentUser?.email || props.currentUser?.username || '',
        username: props.currentUser?.username || 'Admin',
        user_initial: (props.currentUser?.username || props.currentUser?.email || 'A').slice(0, 1).toUpperCase(),
    }, i18n);

    const brandReplacement = brandInfo.hasStickyWhitelabel
        ? (brandInfo.systemTitle || brandInfo.effectiveWhitelabel?.brand_name || 'CMS')
        : undefined;
    const clientSections = props.clientI18nSections || [];
    const clientSlice = getClientJsI18nSlice(locale, clientSections);
    if (!isCommercial && clientSlice.pages && typeof clientSlice.pages === 'object') {
        // Keep commercial bulk-landing strings out of Community client i18n JSON.
        clientSlice.pages = Object.fromEntries(
            Object.entries(clientSlice.pages).filter(([k]) => !k.startsWith('bl_') && !k.startsWith('bulk_landing_'))
        );
    }
    const inlineI18nScript = getInlineI18nScript(locale, clientSlice, brandReplacement);

    let layoutHtml = renderTemplate(adminLayoutTemplate, {
        locale,
        title: props.title,
        system_title: systemTitle,
        provider_name: providerName,
        favicon_url: customFavicon,
        nav_title: systemTitle,
        sidebar: 'WALNUT_SIDEBAR_PLACEHOLDER',
        children: 'WALNUT_CHILDREN_PLACEHOLDER',
        engine_version: ENGINE_CORE_VERSION,
        inline_i18n_script: 'WALNUT_INLINE_I18N_PLACEHOLDER',
        slot_commercial_scripts: isCommercial ? `<script src="/admin/commercial-assets/commercial-admin.js?v=${ENGINE_CORE_VERSION}" defer></script>` : '',
    }, i18n);

    layoutHtml = layoutHtml
        .replace('WALNUT_INLINE_I18N_PLACEHOLDER', () => inlineI18nScript)
        .replace('WALNUT_SIDEBAR_PLACEHOLDER', () => sidebarHtml)
        .replace('WALNUT_CHILDREN_PLACEHOLDER', () => String(props.children));

    return html`${raw(layoutHtml)}`;
};
