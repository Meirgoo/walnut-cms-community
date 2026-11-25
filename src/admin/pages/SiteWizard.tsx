import { raw } from 'hono/html';
import { AdminLayout } from '../layout';
import type { Site, AuthenticatedUser } from '../../engine';
import { renderTemplate, fetchAsset, getAdminI18nSlice, SUPPORTED_LOCALES, getCommercialSnippet } from '../../engine';

export const SiteWizardPage = async (props: {
    sites: Site[];
    currentSiteId: string;
    currentUser?: AuthenticatedUser;
    isSuperAdmin?: boolean;
    canUseFeature?: (feature?: string) => boolean;
    backupSnapshots?: Array<{ key: string; label?: string }>;
    locale?: string;
}) => {
    const locale = props.locale || 'zh-CN';
    const isCommercial = props.canUseFeature ? props.canUseFeature('cms:site_cloner') : false;
    const commonI18n = getAdminI18nSlice(locale, 'common');
    const wizardI18n = getAdminI18nSlice(locale, 'wizard');

    const siteWizardTemplate = await fetchAsset('/admin/pages/site-wizard.html');

    const wizardLocaleOptionsHtml = Object.entries(SUPPORTED_LOCALES).map(([val, label]) =>
        `<div data-value="${val}" data-label="${label}" class="px-3 py-2 hover:bg-stone-50 dark:hover:bg-stone-700 cursor-pointer text-stone-800 dark:text-stone-200">${label}</div>`
    ).join('');

    let slotWizardCloneOptions = '';
    if (isCommercial) {
        const cloneSnippetTpl = getCommercialSnippet('site-wizard-clone-options.html');
        if (cloneSnippetTpl) {
            const sourceSitesOptionsHtml = (props.sites || []).map(s =>
                `<option value="${s.id}">${s.name} (${s.primary_domain})</option>`
            ).join('');
            const backups = props.backupSnapshots || [];
            const backupSnapshotsOptionsHtml = backups.length > 0
                ? backups.map(b => `<option value="${b.key}">${b.label || b.key}</option>`).join('')
                : `<option value="">${wizardI18n.no_backups_found || 'No R2 Snapshots'}</option>`;
            slotWizardCloneOptions = renderTemplate(cloneSnippetTpl, {
                source_sites_options_html: sourceSitesOptionsHtml,
                backup_snapshots_options_html: backupSnapshotsOptionsHtml
            }, { wizard: wizardI18n, ...commonI18n });
        }
    }

    const pageHtml = renderTemplate(siteWizardTemplate, {
        ...commonI18n,
        ...wizardI18n,
        wizard_title: wizardI18n.title,
        wizard_subtitle: wizardI18n.subtitle,
        default_locale_display: SUPPORTED_LOCALES[locale] || locale,
        wizard_locale_options_html: wizardLocaleOptionsHtml,
        slot_wizard_clone_options: slotWizardCloneOptions
    }, { wizard: wizardI18n, ...commonI18n });

    return (
        <AdminLayout
            title={wizardI18n.title}
            {...props}
            locale={locale}
        >
            {raw(pageHtml)}
        </AdminLayout>
    );
};
