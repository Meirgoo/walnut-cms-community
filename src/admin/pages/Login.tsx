import { html, raw } from 'hono/html';
import { renderTemplate, fetchAsset, getAdminI18nSlice, getInlineI18nScript, SUPPORTED_LOCALES, renderLocaleOptions } from '../../engine';

export const LoginPage = async (props: { error?: string; cfEmail?: string; cfEnabled?: boolean; locale?: string; systemTitle?: string; providerName?: string }) => {
    const locale = props.locale || 'zh-CN';
    const i18n = getAdminI18nSlice(locale, ['login', 'common']);
    const systemTitle = props.systemTitle || i18n.system_title || i18n.powered_by_brand || 'Walnut Edge CMS';
    const providerName = props.providerName || i18n.provider_name || i18n.powered_by_brand || 'Walnut Edge CMS';

    const loginTemplate = await fetchAsset('/auth/pages/login.html');

    const brandReplacement = props.systemTitle && props.systemTitle !== 'Walnut Edge CMS' && props.systemTitle !== 'Walnut CMS'
        ? props.systemTitle
        : (providerName && providerName !== 'Walnut Edge CMS' && providerName !== 'Walnut CMS' ? providerName : undefined);
    const inlineI18nScript = getInlineI18nScript(locale, { login: i18n.login || {}, common: i18n.common || {} }, brandReplacement);

    let pageHtml = renderTemplate(loginTemplate, {
        locale,
        login_locale_options_html: renderLocaleOptions(locale),
        system_title: systemTitle,
        provider_name: providerName,
        cf_block_class: (props.cfEnabled || props.cfEmail) ? '' : 'hidden',
        cf_email: props.cfEmail || '',
        cf_email_class: props.cfEmail ? '' : 'hidden',
        error: props.error || '',
        locale_zh_selected: locale === 'zh-CN' ? 'selected' : '',
        locale_en_selected: locale === 'en-US' ? 'selected' : '',
        locale_zh_label: SUPPORTED_LOCALES['zh-CN'] || '',
        locale_en_label: SUPPORTED_LOCALES['en-US'] || 'English',
        inline_i18n_script: 'WALNUT_INLINE_I18N_PLACEHOLDER'
    }, i18n);

    pageHtml = pageHtml.replace('WALNUT_INLINE_I18N_PLACEHOLDER', () => inlineI18nScript);

    return html`${raw(pageHtml)}`;
};
