import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, SUPPORTED_TIMEZONES, SUPPORTED_LOCALES, normalizeTimezoneOptionValue, DEFAULT_DEV_HOST, buildAbsoluteUrl, resolveSiteBrandInfo, parseJson, getCommercialSnippet, getCommercialManifest, isFeatureEnabled, sanitizeHexColor } from '../../engine';

export const SettingsPage = async (props: {
    site: Site;
    sites: Site[];
    currentSiteId: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    canUseFeature?: (feature?: string) => boolean;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const site = props.site;
    const i18n = getAdminI18nSlice(locale, ['settings', 'common']);

    const settings = parseJson<Record<string, any>>(site.settings, {});

    const seo = settings.seo || {};
    const appearance = settings.appearance || {};
    const routing = settings.routing || {};
    const isCommercial = props.canUseFeature ? props.canUseFeature('cms:*') : false;
    const canWhitelabel = props.canUseFeature ? props.canUseFeature('cms:whitelabel') : isCommercial;
    const currentBrandColor = appearance.brand_color || '#10b981';
    const currentPrimaryColor = sanitizeHexColor(settings.primary_color ?? appearance.primary_color);
    const currentPrimaryColorDark = sanitizeHexColor(settings.primary_color_dark ?? appearance.primary_color_dark);

    const currentSiteMode = (settings.site_mode === 'internal' || settings.site_mode === 'maintenance' || routing.maintenance_mode === 1)
        ? 'internal'
        : 'standard';
    const internalCfg = settings.internal || {};
    const currentInternalStatus = Number(internalCfg.status_code || 503);
    const currentThemeMode = appearance.theme_mode || 'system';
    const currentRobots = seo.robots || 'index, follow';

    const siteModeLabels: Record<string, string> = {
        standard: i18n.mode_standard,
        internal: i18n.mode_internal
    };
    const internalStatusLabels: Record<string, string> = {
        '503': i18n.internal_status_503,
        '404': i18n.internal_status_404,
        '301': i18n.internal_status_301,
        '302': i18n.internal_status_302
    };

    const robotsLabels: Record<string, string> = {
        'index, follow': i18n.robots_index_follow,
        'noindex, follow': i18n.robots_noindex_follow,
        'noindex, nofollow': i18n.robots_noindex_nofollow
    };

    const themeModeLabels: Record<string, string> = {
        system: i18n.theme_system,
        dark: i18n.theme_dark,
        light: i18n.theme_light
    };

    const settingsTemplate = await fetchAsset('/admin/pages/settings.html');
    const webColorPickerTemplate = await fetchAsset('/admin/modals/web-color-picker-modal.html');

    const brandInfo = resolveSiteBrandInfo(site);
    const whitelabel = brandInfo.effectiveWhitelabel || settings.whitelabel || {};
    const licenseKey = (site as any).license_key || settings.license_key || '';
    const hasLicense = Boolean(licenseKey) || isCommercial;
    const isOemEnforced = brandInfo.oemMode === 'enforced';
    const hideLicenseDetail = brandInfo.hideLicenseDetail;
    const showWhitelabelSection = canWhitelabel || brandInfo.hasStickyWhitelabel;

    const licenseBadgeClass = hasLicense
        ? 'bg-[var(--admin-accent-soft)] text-[var(--admin-accent-text)] border border-[var(--admin-accent-border)]'
        : 'bg-[var(--admin-chrome)] text-[var(--admin-text-muted)] border border-[var(--admin-border)]';
    const licenseStatusText = hideLicenseDetail
        ? (i18n.settings?.agency_notice || '✨ Managed by Agency')
        : (hasLicense ? i18n.license_status_active : i18n.license_status_community);

    const webColorPickerModalHtml = renderTemplate(webColorPickerTemplate, {
        brand_color: currentBrandColor,
    }, i18n);

    const currentTimezone = normalizeTimezoneOptionValue(settings.timezone || '+08:00');
    const activeTz = SUPPORTED_TIMEZONES.find(t => t.value === currentTimezone) || SUPPORTED_TIMEZONES.find(t => t.value === '+08:00') || SUPPORTED_TIMEZONES[0];
    const tzDisplayLabel = locale === 'en-US' ? activeTz.labelEn : activeTz.labelZh;
    const timezoneOptionsHtml = SUPPORTED_TIMEZONES.map(tz => {
        const label = locale === 'en-US' ? tz.labelEn : tz.labelZh;
        return `<div data-value="${tz.value}" data-label="${label}" class="px-3 py-2 hover:bg-[var(--admin-surface-hover)] cursor-pointer text-[var(--admin-text)]">${label}</div>`;
    }).join('');

    let commercialEdgeServicesHtml = '';
    let commercialSnapshotCloneHtml = '';
    let commercialApiTokensHtml = '';

    if (isCommercial) {
        if (isFeatureEnabled('trafficAnalytics')) {
            const edgeServicesTpl = getCommercialSnippet('settings-edge-services.html');
            if (edgeServicesTpl) {
                commercialEdgeServicesHtml = renderTemplate(edgeServicesTpl, {
                    form_webhook_url: settings.form_webhook_url || '',
                    cf_zone_id: settings.cf_zone_id || '',
                    cf_api_token: settings.cf_api_token ? '••••••••' : ''
                }, i18n);
            }
        }

        const snapshotCloneTpl = getCommercialSnippet('settings-snapshot-clone-card.html');
        if (snapshotCloneTpl) {
            commercialSnapshotCloneHtml = renderTemplate(snapshotCloneTpl, {}, i18n);
        }

        const apiTokensTpl = getCommercialSnippet('settings-api-tokens-card.html');
        if (apiTokensTpl) {
            const patI18nMap = getCommercialManifest<Record<string, any>>('apiTokensProI18n') || {};
            const patLocaleDict = patI18nMap[locale] || patI18nMap['zh-CN'] || {};
            commercialApiTokensHtml = renderTemplate(apiTokensTpl, {
                ...patLocaleDict,
                pat_i18n_json: JSON.stringify(patLocaleDict).replace(/</g, '\\u003c')
            }, i18n);
        }
    }

    const pageHtml = renderTemplate(settingsTemplate, {
        slot_commercial_edge_services: commercialEdgeServicesHtml,
        slot_commercial_snapshot_clone_card: commercialSnapshotCloneHtml,
        slot_commercial_api_tokens_card: commercialApiTokensHtml,
        backup_tab_class: commercialSnapshotCloneHtml ? '' : 'hidden',
        primary_domain: site.primary_domain || DEFAULT_DEV_HOST,
        site_id: site.id || '',
        license_key: hideLicenseDetail ? '' : licenseKey,
        license_detail_editor_class: hideLicenseDetail ? 'hidden' : '',
        license_managed_notice_class: hideLicenseDetail ? '' : 'hidden',
        license_status_badge_class: licenseBadgeClass,
        license_status_text: licenseStatusText,
        whitelabel_section_class: showWhitelabelSection ? '' : 'hidden',
        wl_readonly_attr: isOemEnforced ? 'readonly' : '',
        wl_enforced_badge_class: isOemEnforced ? '' : 'hidden',
        wl_brand_name: whitelabel.brand_name || whitelabel.system_title || '',
        wl_system_title: whitelabel.system_title || whitelabel.brand_name || '',
        wl_provider_name: whitelabel.provider_name || whitelabel.brand_name || site.name || '',
        wl_logo_url: whitelabel.logo_url || '',
        wl_favicon_url: whitelabel.favicon_url || '',
        wl_login_banner_url: whitelabel.login_banner_url || '',
        wl_support_url: whitelabel.support_url || '',
        wl_copyright: whitelabel.copyright_text || whitelabel.copyright || settings.copyright || '',
        site_name: site.name || '',
        site_subtitle: settings.subtitle || '',
        default_locale: site.default_locale || 'zh-CN',
        locale_display_label: SUPPORTED_LOCALES[site.default_locale] || site.default_locale,
        locale_zh_label: SUPPORTED_LOCALES['zh-CN'],
        locale_en_label: SUPPORTED_LOCALES['en-US'],
        current_timezone: currentTimezone,
        timezone_display_label: tzDisplayLabel,
        timezone_options_html: timezoneOptionsHtml,
        logo_url: settings.logo_url || '',
        favicon_url: settings.favicon_url || '',
        copyright: settings.copyright || '',
        site_mode: currentSiteMode,
        site_mode_label: siteModeLabels[currentSiteMode] || siteModeLabels.standard,
        internal_panel_class: currentSiteMode === 'internal' ? '' : 'hidden',
        internal_status: String(currentInternalStatus),
        internal_status_label: internalStatusLabels[String(currentInternalStatus)] || internalStatusLabels['503'],
        internal_redirect_class: (currentInternalStatus === 301 || currentInternalStatus === 302) ? '' : 'hidden',
        internal_page_class: (currentInternalStatus === 503 || currentInternalStatus === 404) ? '' : 'hidden',
        internal_redirect_url: internalCfg.redirect_url || '',
        internal_page_title: internalCfg.title || '',
        internal_page_message: internalCfg.message || '',
        sitemap_domain: settings.sitemap_domain || seo.sitemap_domain || site.primary_domain || '',
        title_template: settings.title_template || `%s - ${site.name || 'Site'}`,
        current_robots: currentRobots,
        robots_label: robotsLabels[currentRobots] || currentRobots,
        robots_txt: site.robots_txt
            ? String(site.robots_txt).replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n')
            : `User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /api/\n\nSitemap: ${buildAbsoluteUrl('/sitemap.xml', site.primary_domain || DEFAULT_DEV_HOST)}`,
        description: settings.description || '',
        og_image: seo.og_image || '',
        og_use_first_image_checked: seo.og_use_first_image ? 'checked' : '',
        current_theme_mode: currentThemeMode,
        theme_mode_label: themeModeLabels[currentThemeMode] || themeModeLabels.system,
        current_brand_color: currentBrandColor,
        current_primary_color: currentPrimaryColor,
        current_primary_color_swatch: currentPrimaryColor || '#2563eb',
        current_primary_color_dark: currentPrimaryColorDark,
        current_primary_color_dark_swatch: currentPrimaryColorDark || currentPrimaryColor || '#2563eb',
        footer_links: appearance.footer_links || '',
        pro_script_badge_class: 'hidden',
        google_analytics_id: seo.ga_id || seo.google_site_verification || '',
        footer_scripts_class: '',
        footer_scripts: seo.footer_scripts || '',
        form_webhook_url: settings.form_webhook_url || '',
        cf_zone_id: settings.cf_zone_id || '',
        cf_api_token: settings.cf_api_token ? '••••••••' : '',
        web_color_picker_modal: webColorPickerModalHtml
    }, i18n);

    return (
        <AdminLayout
            title={i18n.title}
            {...props}
            clientI18nSections={['settings']}
            locale={locale}
        >
            {raw(pageHtml)}
        </AdminLayout>
    );
};
