(function() {
    'use strict';

    const rt = (window.__WALNUT_RUNTIME__ = window.__WALNUT_RUNTIME__ || {});
    if (rt.quickActionInitialized) return;
    rt.quickActionInitialized = true;

    const t = (k, params) => {
        const i18n = window.__WALNUT_I18N__;
        return i18n && typeof i18n.t === 'function' ? i18n.t(k, params) : k;
    };

    if (typeof window.showToast !== 'function') {
        window.showToast = function(message, type = 'info') {
            let container = document.getElementById('walnut-toast-container');
            if (!container) {
                container = document.createElement('div');
                container.id = 'walnut-toast-container';
                container.className = 'fixed bottom-5 left-1/2 -translate-x-1/2 z-[99999] flex flex-col items-center space-y-2 pointer-events-none';
                document.body.appendChild(container);
            }

            const toast = document.createElement('div');
            const bgClass = type === 'success'
                ? 'bg-emerald-600 text-white'
                : (type === 'error'
                    ? 'bg-rose-600 text-white'
                    : (type === 'warning' ? 'bg-amber-500 text-white' : 'bg-slate-900 text-white'));

            toast.className = `pointer-events-auto px-4 py-2.5 rounded-2xl text-xs font-semibold shadow-2xl backdrop-blur-md flex items-center space-x-2 transition-all transform duration-200 translate-y-2 opacity-0 ${bgClass}`;
            toast.innerHTML = `<span>${message}</span>`;
            container.appendChild(toast);

            requestAnimationFrame(() => {
                toast.classList.remove('translate-y-2', 'opacity-0');
            });

            setTimeout(() => {
                toast.classList.add('opacity-0', 'translate-y-2');
                setTimeout(() => toast.remove(), 250);
            }, 3200);
        };
    }

    class WalnutQuickActionEngine {
        constructor() {
            this.state = null;
            this.activeModal = null;
            this.paletteActiveIndex = 0;
            this.availableCommands = [];
            this.init();
        }

        async init() {
            try {
                // Disable admin probing and UI injection inside preview iframes or preview query mode to prevent leaking admin state.
                const isPreviewSandboxed = (function() {
                    try {
                        if (window.self !== window.top) return true;
                        const params = new URLSearchParams(window.location.search);
                        if (params.has('walnut_preview') || params.has('preview')) return true;
                        if (rt.previewMode) return true;
                    } catch (e) {
                        return true;
                    }
                    return false;
                })();

                if (isPreviewSandboxed) {
                    return;
                }

                const res = await fetch('/api/quick-actions/state', {
                    headers: { 'Accept': 'application/json' }
                });
                if (!res.ok) return;

                const data = await res.json();
                if (!data || !data.authenticated) {
                    try { localStorage.removeItem('walnut_admin_hint'); } catch {}
                    return;
                }

                this.state = data;
                rt.isAdmin = true;

                if (data.i18n && typeof data.i18n === 'object') {
                    const i18nStore = (window.__WALNUT_I18N__ = window.__WALNUT_I18N__ || {});
                    i18nStore.dict = i18nStore.dict || {};
                    for (const ns of Object.keys(data.i18n)) {
                        i18nStore.dict[ns] = Object.assign({}, i18nStore.dict[ns] || {}, data.i18n[ns]);
                    }
                    i18nStore.adminDict = i18nStore.dict;
                }

                // Load icon font stylesheet only for authenticated admins so anonymous visitors incur zero font-CSS overhead.
                if (document.head && !document.querySelector('link[href*="/shared/material-symbols.css"]')) {
                    const iconLink = document.createElement('link');
                    iconLink.rel = 'stylesheet';
                    iconLink.href = '/shared/material-symbols.css';
                    document.head.appendChild(iconLink);
                }

                this.buildAvailableCommands();

                this.mountFloatingActionButton();

                this.bindShortcutListener();

                this.bindComponentVisualHover();

            } catch (err) {
                console.debug('[QuickAction] Guest access, skipping engine activation.', err);
            }
        }

        buildAvailableCommands() {
            const catCreate = t('quick_actions.cat_creation') || 'Creation';
            const catNav = t('quick_actions.cat_navigation') || 'Navigation';
            const catOps = t('quick_actions.cat_operations') || 'Operations';
            const catComm = t('quick_actions.cat_commercial') || 'Commercial';
            const go = (url) => { window.location.href = url; };
            const purgeCacheReq = async (targetPath) => {
                try {
                    await fetch('/api/quick-actions/purge-cache', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Admin-CSRF-Token': 'walnut-admin-csrf-valid-token'
                        },
                        body: JSON.stringify({ path: targetPath || undefined, siteId: this.state?.siteId })
                    });
                    if (window.caches && caches.keys) {
                        const keys = await caches.keys();
                        await Promise.all(keys.map(k => caches.delete(k)));
                    }
                } catch {}
                window.showToast(t('quick_actions.cache_purged'), 'success');
                setTimeout(() => window.location.reload(), 400);
            };
            const triggerR2Backup = async () => {
                try {
                    const res = await fetch('/admin/settings/api/backup', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Admin-CSRF-Token': 'walnut-admin-csrf-valid-token'
                        },
                        body: JSON.stringify({ siteId: this.state?.siteId })
                    });
                    if (!res.ok) {
                        const errJson = await res.json().catch(() => ({}));
                        window.showToast((t('quick_actions.backup_failed') || '').replace('{{error}}', errJson.error || res.status), 'error');
                        return;
                    }
                    window.showToast(t('quick_actions.backup_triggered'), 'success');
                } catch {
                    window.showToast(t('quick_actions.req_error'), 'error');
                }
            };

            this.availableCommands = [];

            const pageMeta = window.__WALNUT__;
            if (pageMeta?.route?.targetId) {
                const targetId = pageMeta.route.targetId;
                const rType = pageMeta.route.type || 'single';
                const editUrl = (rType === 'article' || rType === 'note')
                    ? `/admin/articles/edit/${encodeURIComponent(targetId)}`
                    : `/admin/pages/edit/${encodeURIComponent(targetId)}`;

                this.availableCommands.push(
                    {
                        cmd: '/edit',
                        label: (t('quick_actions.jump_edit') || '').replace('{{type}}', rType === 'article' ? t('nav.articles') : t('nav.pages')),
                        description: (t('quick_actions.jump_edit_desc') || '').replace('{{path}}', pageMeta.route.path || '/').replace('{{id}}', targetId),
                        category: catNav,
                        icon: 'edit',
                        handler: () => go(editUrl)
                    },
                    {
                        cmd: '/purge-current-cache',
                        label: t('quick_actions.cmd_purge_current_label'),
                        description: t('quick_actions.cmd_purge_current_desc'),
                        category: catOps,
                        icon: 'cached',
                        handler: () => purgeCacheReq(window.location.pathname)
                    },
                    {
                        cmd: '/copy-link',
                        label: t('quick_actions.cmd_copy_link_label'),
                        description: t('quick_actions.cmd_copy_link_desc'),
                        category: catOps,
                        icon: 'content_copy',
                        handler: async () => {
                            try {
                                await navigator.clipboard.writeText(window.location.href);
                                window.showToast(t('quick_actions.link_copied'), 'success');
                            } catch {
                                window.showToast(t('quick_actions.req_error'), 'error');
                            }
                        }
                    }
                );
            }

            this.availableCommands.push(
                {
                    cmd: '/micro',
                    label: t('quick_actions.record_micro'),
                    description: t('quick_actions.record_micro_desc'),
                    category: catCreate,
                    icon: 'eco',
                    handler: () => this.openMicroContentCard()
                },
                {
                    cmd: '/new-article',
                    label: t('quick_actions.cmd_new_article_label'),
                    description: t('quick_actions.cmd_new_article_desc'),
                    category: catCreate,
                    icon: 'edit_document',
                    handler: () => go('/admin/articles/new/article')
                },
                {
                    cmd: '/new-page',
                    label: t('quick_actions.cmd_new_page_label'),
                    description: t('quick_actions.cmd_new_page_desc'),
                    category: catCreate,
                    icon: 'note_add',
                    handler: () => go('/admin/pages/new')
                },
                {
                    cmd: '/upload',
                    label: t('quick_actions.cmd_upload_label'),
                    description: t('quick_actions.cmd_upload_desc'),
                    category: catCreate,
                    icon: 'cloud_upload',
                    handler: () => go('/admin/media')
                }
            );

            if (this.state?.isCommercial) {
                if (Array.isArray(this.state.commercial_commands)) {
                    for (const comm of this.state.commercial_commands) {
                        if (!this.availableCommands.some(c => c.cmd === comm.cmd)) {
                            const commLabel = comm.labelKey ? t(comm.labelKey) : (comm.label || comm.cmd);
                            const commDesc = comm.descriptionKey ? t(comm.descriptionKey) : (comm.description || '');
                            this.availableCommands.push({
                                cmd: comm.cmd,
                                label: commLabel,
                                description: `${t('quick_actions.commercial_ext')} ${commDesc}`,
                                category: catComm,
                                icon: 'workspace_premium',
                                handler: () => comm.action === 'D1_SNAPSHOT_EXPORT' ? triggerR2Backup() : this.dispatchCommercialAction(comm)
                            });
                        }
                    }
                }
                const extraCommercial = [
                    ['/bulk-landing', 'quick_actions.cmd_bulk_landing_label', 'quick_actions.cmd_bulk_landing_desc', 'auto_awesome', () => go('/admin/pages')],
                    ['/backup', 'quick_actions.cmd_d1_export_label', 'quick_actions.cmd_d1_export_desc', 'backup', triggerR2Backup],
                    ['/audit', 'quick_actions.cmd_audit_label', 'quick_actions.cmd_audit_desc', 'policy', () => go('/admin/audit')]
                ];
                for (const [cmd, lblKey, descKey, icon, handler] of extraCommercial) {
                    if (!this.availableCommands.some(c => c.cmd === cmd)) {
                        this.availableCommands.push({
                            cmd,
                            label: t(lblKey),
                            description: t(descKey),
                            category: catComm,
                            icon,
                            handler
                        });
                    }
                }
            }

            const navItems = [
                ['/admin', 'quick_actions.nav_admin', 'quick_actions.nav_admin_desc', 'dashboard', '/admin'],
                ['/topology', 'quick_actions.cmd_topology_label', 'quick_actions.cmd_topology_desc', 'hub', '/admin/graph'],
                ['/articles', 'quick_actions.nav_articles', 'quick_actions.nav_articles_desc', 'article', '/admin/articles'],
                ['/pages', 'quick_actions.cmd_pages_label', 'quick_actions.cmd_pages_desc', 'layers', '/admin/pages'],
                ['/datasets', 'quick_actions.cmd_datasets_label', 'quick_actions.cmd_datasets_desc', 'database', '/admin/datasets'],
                ['/themes', 'quick_actions.cmd_themes_label', 'quick_actions.cmd_themes_desc', 'palette', '/admin/themes'],
                ['/tasks', 'quick_actions.cmd_tasks_label', 'quick_actions.cmd_tasks_desc', 'schedule', '/admin/tasks'],
                ['/webhooks', 'quick_actions.cmd_webhooks_label', 'quick_actions.cmd_webhooks_desc', 'webhook', '/admin/webhooks'],
                ['/settings', 'quick_actions.nav_settings', 'quick_actions.nav_settings_desc', 'settings', '/admin/settings'],
                ['/profile', 'quick_actions.nav_users', 'quick_actions.nav_users_desc', 'person', '/admin/profile']
            ];
            for (const [cmd, lblKey, descKey, icon, url] of navItems) {
                this.availableCommands.push({
                    cmd,
                    label: t(lblKey),
                    description: t(descKey),
                    category: catNav,
                    icon,
                    handler: () => go(url)
                });
            }

            this.availableCommands.push(
                {
                    cmd: '/purge-cache',
                    label: t('quick_actions.cmd_purge_cache_label'),
                    description: t('quick_actions.cmd_purge_cache_desc'),
                    category: catOps,
                    icon: 'cleaning_services',
                    handler: () => purgeCacheReq()
                },
                {
                    cmd: '/export',
                    label: t('quick_actions.cmd_export_label'),
                    description: t('quick_actions.cmd_export_desc'),
                    category: catOps,
                    icon: 'download',
                    handler: () => go('/admin/articles')
                },
                {
                    cmd: '/theme',
                    label: t('quick_actions.cmd_theme_toggle_label'),
                    description: t('quick_actions.cmd_theme_toggle_desc'),
                    category: catOps,
                    icon: 'contrast',
                    handler: () => {
                        const isDark = document.documentElement.classList.contains('dark');
                        const nextMode = isDark ? 'light' : 'dark';
                        localStorage.setItem('walnut_theme_mode', nextMode);
                        document.documentElement.setAttribute('data-theme-mode', nextMode);
                        document.documentElement.classList.toggle('dark', nextMode === 'dark');
                        const modeLabel = t(nextMode === 'dark' ? 'quick_actions.theme_dark' : 'quick_actions.theme_light');
                        window.showToast((t('quick_actions.theme_switched') || '').replace('{{mode}}', modeLabel), 'success');
                    }
                }
            );
        }

        mountFloatingActionButton() {
            if (document.getElementById('walnut-quick-action-fab')) return;

            const fab = document.createElement('div');
            fab.id = 'walnut-quick-action-fab';
            fab.className = 'fixed bottom-6 right-6 z-[9999] select-none flex items-center space-x-2 transition-transform duration-200 hover:scale-105';
            fab.innerHTML = `
                <button
                    type="button"
                    id="walnut-fab-trigger-btn"
                    title="${t('quick_actions.fab_title')} (${this.getDisplayShortcut()})"
                    class="w-12 h-12 rounded-full bg-slate-900/90 dark:bg-emerald-600/90 hover:bg-black dark:hover:bg-emerald-500 text-white shadow-2xl backdrop-blur-md border border-slate-700/60 dark:border-emerald-400/30 flex items-center justify-center cursor-pointer transition"
                >
                    <span class="material-symbols-outlined text-[22px]">bolt</span>
                </button>
            `;

            document.body.appendChild(fab);

            document.getElementById('walnut-fab-trigger-btn')?.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.toggleCommandPalette();
            });
        }

        getDisplayShortcut() {
            const raw = this.state?.shortcut || 'alt+k,cmd+k';
            const first = raw.split(',')[0].trim().toUpperCase();
            return first || 'ALT+K';
        }

        updateShortcut(newShortcut) {
            if (!this.state) this.state = {};
            this.state.shortcut = (newShortcut || '').trim() || 'alt+k,cmd+k';
            const fabBtn = document.getElementById('walnut-fab-trigger-btn');
            if (fabBtn) {
                fabBtn.setAttribute('title', `${t('quick_actions.fab_title')} (${this.getDisplayShortcut()})`);
            }
        }

        // Normalize via e.code to avoid macOS Option+letter producing special characters.
        normalizeEventKey(e) {
            const code = e.code || '';
            if (/^Key([A-Z])$/.test(code)) return code.slice(3).toLowerCase();
            if (/^Digit([0-9])$/.test(code)) return code.slice(5);
            if (/^Numpad([0-9])$/.test(code)) return code.slice(6);
            if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
            const codeMap = {
                Space: 'space',
                Slash: '/',
                Backslash: '\\',
                Period: '.',
                Comma: ',',
                Semicolon: ';',
                Quote: "'",
                Backquote: '`',
                Minus: '-',
                Equal: '=',
                BracketLeft: '[',
                BracketRight: ']',
                Enter: 'enter',
                Tab: 'tab',
                Backspace: 'backspace',
                Delete: 'delete',
                ArrowUp: 'up',
                ArrowDown: 'down',
                ArrowLeft: 'left',
                ArrowRight: 'right'
            };
            if (codeMap[code]) return codeMap[code];
            const rawKey = (e.key || '').toLowerCase();
            if (rawKey === ' ') return 'space';
            return rawKey;
        }

        bindShortcutListener() {
            const MODIFIER_NAMES = ['ctrl', 'control', 'alt', 'option', 'shift', 'cmd', 'meta', 'command', 'super'];

            window.addEventListener('keydown', (e) => {
                // Yield keydown events while the settings page shortcut recorder is active.
                if (rt.recordingShortcut) return;

                if (e.key === 'Escape' && this.activeModal) {
                    this.closeActiveModal();
                    return;
                }

                const configuredShortcuts = (this.state?.shortcut || 'alt+k,cmd+k')
                    .split(',')
                    .map(s => s.trim().toLowerCase())
                    .filter(Boolean);

                const pressedKey = this.normalizeEventKey(e);
                const rawKey = (e.key || '').toLowerCase();

                for (const rule of configuredShortcuts) {
                    const parts = rule.split('+').map(p => p.trim()).filter(Boolean);
                    if (parts.length === 0) continue;

                    const needsCtrl = parts.includes('ctrl') || parts.includes('control');
                    const needsAlt = parts.includes('alt') || parts.includes('option');
                    const needsShift = parts.includes('shift');
                    const needsCmd = parts.includes('cmd') || parts.includes('meta') || parts.includes('command') || parts.includes('super');

                    const nonModParts = parts.filter(p => !MODIFIER_NAMES.includes(p));
                    const targetKey = nonModParts[nonModParts.length - 1] || '';
                    if (!targetKey) continue;

                    const matchCtrl = Boolean(e.ctrlKey) === needsCtrl;
                    const matchAlt = Boolean(e.altKey) === needsAlt;
                    const matchShift = Boolean(e.shiftKey) === needsShift;
                    const matchCmd = Boolean(e.metaKey) === needsCmd;
                    const matchKey = pressedKey === targetKey || rawKey === targetKey;

                    const isFunctionKey = /^f([1-9]|1[0-2])$/.test(targetKey);
                    const hasModifier = needsCtrl || needsAlt || needsShift || needsCmd;

                    if (matchCtrl && matchAlt && matchShift && matchCmd && matchKey && (hasModifier || isFunctionKey)) {
                        e.preventDefault();
                        this.toggleCommandPalette();
                        return;
                    }
                }
            });
        }

        toggleCommandPalette() {
            if (this.activeModal) {
                this.closeActiveModal();
                return;
            }

            this.buildAvailableCommands();

            const modal = document.createElement('div');
            modal.id = 'walnut-command-palette-modal';
            modal.className = 'fixed inset-0 z-[100000] bg-black/60 backdrop-blur-sm flex items-start justify-center pt-20 px-4 select-none';

            modal.innerHTML = `
                <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl max-w-xl w-full overflow-hidden flex flex-col max-h-[75vh] animate-in fade-in zoom-in-95 duration-150">
                    <div class="p-3.5 border-b border-slate-100 dark:border-slate-800 flex items-center space-x-3 bg-slate-50/50 dark:bg-slate-900/50">
                        <span class="material-symbols-outlined text-[18px] text-slate-400">search</span>
                        <input
                            type="text"
                            id="walnut-palette-input"
                            placeholder="${t('quick_actions.search_ph')}"
                            class="flex-1 bg-transparent border-0 outline-none text-sm font-medium text-slate-800 dark:text-slate-100 placeholder-slate-400"
                            autocomplete="off"
                        />
                        <span class="text-[10px] font-mono text-slate-400 dark:text-slate-500 bg-slate-200 dark:bg-slate-800 px-2 py-0.5 rounded-md">${t('quick_actions.esc_close')}</span>
                    </div>

                    <div id="walnut-palette-results" class="overflow-y-auto p-2 space-y-1 divide-y divide-slate-100/50 dark:divide-slate-800/50">
                    </div>

                    <div class="px-4 py-2 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/50 flex items-center justify-between text-[11px] text-slate-400 dark:text-slate-500">
                        <span>${t('quick_actions.footer_hint')}</span>
                        <span class="font-mono text-emerald-600 dark:text-emerald-400 font-bold">Admin Active</span>
                    </div>
                </div>
            `;

            modal.addEventListener('click', (e) => {
                if (e.target === modal) this.closeActiveModal();
            });

            document.body.appendChild(modal);
            this.activeModal = modal;
            this.searchResults = [];
            this.isSearching = false;
            if (this.searchTimer) {
                clearTimeout(this.searchTimer);
                this.searchTimer = null;
            }

            const input = document.getElementById('walnut-palette-input');
            input?.focus();

            this.renderPaletteResults('');

            input?.addEventListener('input', (e) => {
                const trimmed = (e.target.value || '').trim();
                if (this.searchTimer) {
                    clearTimeout(this.searchTimer);
                    this.searchTimer = null;
                }

                if (!trimmed || trimmed.startsWith('/')) {
                    this.searchResults = [];
                    this.isSearching = false;
                    this.renderPaletteResults(trimmed);
                    return;
                }

                this.isSearching = true;
                this.renderPaletteResults(trimmed);
                this.searchTimer = setTimeout(async () => {
                    try {
                        const res = await fetch(`/api/quick-actions/search?q=${encodeURIComponent(trimmed)}`);
                        const data = res.ok ? await res.json() : null;
                        if ((input.value || '').trim() !== trimmed) return;
                        this.searchResults = Array.isArray(data?.items) ? data.items : [];
                    } catch {
                        if ((input.value || '').trim() !== trimmed) return;
                        this.searchResults = [];
                    } finally {
                        if ((input.value || '').trim() === trimmed) {
                            this.isSearching = false;
                            this.renderPaletteResults(trimmed);
                        }
                    }
                }, 180);
            });

            input?.addEventListener('keydown', (e) => {
                const resultsContainer = document.getElementById('walnut-palette-results');
                const items = resultsContainer?.querySelectorAll('.walnut-palette-item') || [];

                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    this.paletteActiveIndex = (this.paletteActiveIndex + 1) % Math.max(1, items.length);
                    this.updatePaletteActiveItem(items);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    this.paletteActiveIndex = (this.paletteActiveIndex - 1 + items.length) % Math.max(1, items.length);
                    this.updatePaletteActiveItem(items);
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    const activeElem = items[this.paletteActiveIndex];
                    if (activeElem) {
                        activeElem.click();
                    }
                }
            });
        }

        escapeHtml(str) {
            return String(str || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        async publishInlineMicro(contentRaw) {
            try {
                const res = await fetch('/api/quick-actions/micro', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-CSRF-Token': 'walnut-admin-csrf-valid-token'
                    },
                    body: JSON.stringify({
                        contentRaw,
                        status: 'published',
                        type: 'micro',
                        siteId: this.state?.siteId
                    })
                });
                const json = await res.json();
                if (!res.ok || json.error) {
                    window.showToast((t('quick_actions.save_failed') || '').replace('{{error}}', json.error || 'Unknown error'), 'error');
                    return;
                }
                window.showToast(t('quick_actions.save_success'), 'success');
            } catch {
                window.showToast(t('quick_actions.req_error'), 'error');
            }
        }

        renderPaletteResults(query) {
            const container = document.getElementById('walnut-palette-results');
            if (!container) return;

            const trimmed = (query || '').trim();
            const lower = trimmed.toLowerCase();
            let entries = [];

            if (lower.startsWith('/micro ') && trimmed.slice(7).trim()) {
                const microText = trimmed.slice(7).trim();
                const preview = this.escapeHtml(microText.length > 60 ? `${microText.slice(0, 60)}...` : microText);
                entries = [{
                    cmd: '/micro',
                    label: (t('quick_actions.micro_inline_hint') || '').replace('{{preview}}', preview),
                    description: t('quick_actions.record_micro'),
                    category: t('quick_actions.cat_creation') || 'Creation',
                    icon: 'eco',
                    handler: () => this.publishInlineMicro(microText)
                }];
            } else {
                const staticMatches = this.availableCommands.filter(item => {
                    if (!lower) return true;
                    const alias = (this.state?.bilingual_aliases?.[item.cmd] || '').toLowerCase();
                    return item.cmd.toLowerCase().includes(lower) ||
                           item.label.toLowerCase().includes(lower) ||
                           (item.description && item.description.toLowerCase().includes(lower)) ||
                           (alias && alias.includes(lower));
                });

                const searchCat = t('quick_actions.cat_search') || 'Search';
                const searchMatches = (!trimmed.startsWith('/') && Array.isArray(this.searchResults))
                    ? this.searchResults.map(item => ({
                        cmd: t(`quick_actions.search_type_${item.type}`) || item.type,
                        label: this.escapeHtml(item.title || item.slug || item.id),
                        description: this.escapeHtml(item.slug || ''),
                        category: searchCat,
                        icon: item.type === 'article' ? 'article' : item.type === 'page' ? 'layers' : 'database',
                        handler: () => { window.location.href = item.editUrl; }
                    }))
                    : [];

                entries = [...staticMatches, ...searchMatches];
            }

            if (entries.length === 0) {
                const emptyText = this.isSearching
                    ? t('quick_actions.searching')
                    : `${t('quick_actions.no_match')} "${this.escapeHtml(trimmed)}". /micro`;
                container.innerHTML = `
                    <div class="py-8 text-center text-xs text-slate-400 dark:text-slate-500">
                        ${emptyText}
                    </div>
                `;
                return;
            }

            this.paletteActiveIndex = 0;
            container.innerHTML = entries.map((cmd, i) => `
                <div
                    class="walnut-palette-item px-3 py-2.5 rounded-xl cursor-pointer flex items-center justify-between text-xs transition ${i === 0 ? 'bg-slate-100 dark:bg-slate-800 font-semibold' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'}"
                    data-index="${i}"
                >
                    <div class="flex items-center space-x-3 min-w-0">
                        <span class="material-symbols-outlined text-[18px] text-slate-500 dark:text-slate-400 shrink-0">${cmd.icon || 'terminal'}</span>
                        <div class="min-w-0">
                            <div class="text-slate-800 dark:text-slate-100 font-medium flex items-center space-x-2">
                                <span class="font-mono text-emerald-600 dark:text-emerald-400 font-bold shrink-0">${cmd.cmd}</span>
                                <span class="truncate">${cmd.label}</span>
                            </div>
                            ${cmd.description ? `<div class="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 truncate">${cmd.description}</div>` : ''}
                        </div>
                    </div>
                    <span class="text-[10px] text-slate-400 font-mono shrink-0 ml-2">${t('quick_actions.enter_exec')}</span>
                </div>
            `).join('');

            const items = container.querySelectorAll('.walnut-palette-item');
            items.forEach((elem, index) => {
                elem.addEventListener('click', () => {
                    const matched = entries[index];
                    this.closeActiveModal();
                    if (matched && typeof matched.handler === 'function') {
                        matched.handler();
                    }
                });
            });
        }

        updatePaletteActiveItem(items) {
            items.forEach((item, idx) => {
                if (idx === this.paletteActiveIndex) {
                    item.classList.add('bg-slate-100', 'dark:bg-slate-800', 'font-semibold');
                    item.scrollIntoView({ block: 'nearest' });
                } else {
                    item.classList.remove('bg-slate-100', 'dark:bg-slate-800', 'font-semibold');
                }
            });
        }

        closeActiveModal() {
            if (this.searchTimer) {
                clearTimeout(this.searchTimer);
                this.searchTimer = null;
            }
            if (this.activeModal) {
                this.activeModal.remove();
                this.activeModal = null;
            }
        }

        openMicroContentCard() {
            this.closeActiveModal();

            const cardModal = document.createElement('div');
            cardModal.id = 'walnut-micro-modal';
            cardModal.className = 'fixed inset-0 z-[100000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 select-none';

            cardModal.innerHTML = `
                <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl shadow-2xl max-w-lg w-full p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150">
                    <div class="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
                        <div class="flex items-center space-x-2">
                            <span class="material-symbols-outlined text-[20px] text-emerald-500">eco</span>
                            <h3 class="text-sm font-bold text-slate-900 dark:text-white">${t('quick_actions.record_micro')}</h3>
                        </div>
                        <button type="button" id="micro-modal-close" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-lg cursor-pointer">&times;</button>
                    </div>

                    <div class="space-y-3">
                        <div>
                            <input
                                type="text"
                                id="micro-title-input"
                                placeholder="${t('quick_actions.title_ph')}"
                                class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3.5 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 outline-none focus:border-emerald-500"
                            />
                        </div>

                        <div>
                            <textarea
                                id="micro-raw-input"
                                placeholder="${t('quick_actions.body_ph')}"
                                rows="5"
                                class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 text-xs text-slate-800 dark:text-slate-100 outline-none focus:border-emerald-500 resize-none leading-relaxed"
                            ></textarea>
                        </div>

                        <div class="flex items-center justify-between pt-1">
                            <div class="flex items-center space-x-2 text-xs">
                                <span class="text-slate-500 text-[11px]">${t('editor.field_progress') || 'Progress'}:</span>
                                <input
                                    type="text"
                                    id="micro-progress-input"
                                    name="micro-progress"
                                    placeholder="${t('editor.progress_placeholder') || ''}"
                                    class="w-36 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-800 dark:text-slate-200 outline-none"
                                />
                            </div>

                            <div class="flex items-center space-x-2">
                                <button type="button" id="micro-cancel-btn" class="px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer">${t('common.cancel')}</button>
                                <button type="button" id="micro-save-btn" class="px-4 py-1.5 rounded-xl text-xs font-bold bg-slate-900 hover:bg-black dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white shadow-md transition cursor-pointer flex items-center space-x-1">
                                    <span>${t('quick_actions.save_thought')}</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            document.body.appendChild(cardModal);
            this.activeModal = cardModal;

            const textarea = document.getElementById('micro-raw-input');
            textarea?.focus();

            document.getElementById('micro-modal-close')?.addEventListener('click', () => this.closeActiveModal());
            document.getElementById('micro-cancel-btn')?.addEventListener('click', () => this.closeActiveModal());

            const doSave = async () => {
                const title = (document.getElementById('micro-title-input')?.value || '').trim();
                const content = (textarea?.value || '').trim();
                const progress = (document.getElementById('micro-progress-input')?.value || '').trim();
                const maturity = progress;

                if (!content) {
                    window.showToast(t('quick_actions.content_required'), 'warning');
                    textarea?.focus();
                    return;
                }

                const saveBtn = document.getElementById('micro-save-btn');
                if (saveBtn) saveBtn.innerText = t('quick_actions.saving');

                try {
                    const res = await fetch('/api/quick-actions/micro', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Admin-CSRF-Token': 'walnut-admin-csrf-valid-token'
                        },
                        body: JSON.stringify({
                            title,
                            contentRaw: content,
                            progress,
                            maturity,
                            siteId: this.state?.siteId
                        })
                    });

                    const json = await res.json();
                    if (!res.ok || json.error) {
                        window.showToast((t('quick_actions.save_failed') || '').replace('{{error}}', json.error || 'Unknown error'), 'error');
                        if (saveBtn) saveBtn.innerText = t('quick_actions.save_thought');
                        return;
                    }

                    window.showToast(t('quick_actions.save_success'), 'success');
                    this.closeActiveModal();
                } catch (e) {
                    window.showToast(t('quick_actions.req_error'), 'error');
                    if (saveBtn) saveBtn.innerText = t('quick_actions.save_thought');
                }
            };

            document.getElementById('micro-save-btn')?.addEventListener('click', doSave);

            textarea?.addEventListener('keydown', (e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    doSave();
                }
            });
        }

        async dispatchCommercialAction(comm) {
            window.showToast(t('quick_actions.dispatching_cmd', { label: comm.label }), 'info');

            if (comm.action === 'D1_SNAPSHOT_EXPORT') {
                window.location.href = '/admin/settings';
                return;
            }
            if (comm.action === 'TRAFFIC_PULL_METRICS') {
                window.location.href = '/admin';
                return;
            }

            window.showToast(t('quick_actions.cmd_dispatched', { cmd: comm.cmd }), 'success');
        }

        bindComponentVisualHover() {
            const editableWrappers = document.querySelectorAll('[data-walnut-editable="true"]');
            if (editableWrappers.length === 0) return;

            editableWrappers.forEach(wrapper => {
                wrapper.classList.add('relative', 'walnut-editable-boundary');

                let badge = wrapper.querySelector('.walnut-edit-inspect-badge');
                if (!badge) {
                    badge = document.createElement('div');
                    badge.className = 'walnut-edit-inspect-badge hidden absolute top-3 right-3 z-40 bg-slate-900/90 hover:bg-black text-white px-3 py-1.5 rounded-full text-xs font-bold shadow-xl border border-slate-700/80 backdrop-blur-md cursor-pointer flex items-center space-x-1.5 transition select-none';
                    badge.innerHTML = `<span class="material-symbols-outlined text-[14px]">edit</span><span>${t('quick_actions.visual_inspect_badge')}</span>`;
                    wrapper.appendChild(badge);

                    badge.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        this.openComponentEditCard(wrapper);
                    });
                }

                wrapper.addEventListener('mouseenter', () => {
                    badge.classList.remove('hidden');
                    wrapper.classList.add('ring-2', 'ring-emerald-500/40', 'rounded-2xl');
                });

                wrapper.addEventListener('mouseleave', () => {
                    badge.classList.add('hidden');
                    wrapper.classList.remove('ring-2', 'ring-emerald-500/40', 'rounded-2xl');
                });
            });
        }

        async openComponentEditCard(wrapper) {
            this.closeActiveModal();

            const compSlug = wrapper.getAttribute('data-walnut-component') || 'component';
            const schemaSlug = wrapper.getAttribute('data-walnut-schema') || compSlug;
            const entityId = wrapper.getAttribute('data-walnut-entity-id') || '';

            let existingItem = null;
            if (entityId) {
                try {
                    const res = await fetch(`/api/quick-actions/dataset-item/${encodeURIComponent(entityId)}`);
                    if (res.ok) {
                        const json = await res.json();
                        existingItem = json.item;
                    }
                } catch {}
            }

            const defaultFields = ['title', 'summary', 'content'];
            const fields = existingItem?.fields ? Object.keys(existingItem.fields) : defaultFields;

            const modal = document.createElement('div');
            modal.id = 'walnut-visual-edit-modal';
            modal.className = 'fixed inset-0 z-[100000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 select-none';

            const fieldsHtml = fields.map(f => {
                const val = existingItem?.fields?.[f] || '';
                return `
                    <div>
                        <label class="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1 capitalize">${f}</label>
                        <textarea
                            data-field="${f}"
                            rows="2"
                            class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-800 dark:text-slate-100 outline-none focus:border-emerald-500"
                        >${val}</textarea>
                    </div>
                `;
            }).join('');

            modal.innerHTML = `
                <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl shadow-2xl max-w-lg w-full p-6 space-y-4">
                    <div class="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
                        <div class="flex items-center space-x-2">
                            <span class="material-symbols-outlined text-[20px] text-emerald-500">edit_note</span>
                            <h3 class="text-sm font-bold text-slate-900 dark:text-white">${(t('quick_actions.visual_modal_title') || '').replace('{{slug}}', compSlug)}</h3>
                        </div>
                        <button type="button" id="edit-modal-close" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-lg cursor-pointer">&times;</button>
                    </div>

                    <div class="space-y-3">
                        <div>
                            <label class="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">${t('quick_actions.item_title')}</label>
                            <input
                                type="text"
                                id="edit-title-input"
                                value="${existingItem?.title || (t('quick_actions.item_default_title') || '').replace('{{slug}}', compSlug)}"
                                class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3.5 py-2 text-xs text-slate-800 dark:text-slate-100 outline-none focus:border-emerald-500"
                            />
                        </div>
                        ${fieldsHtml}
                    </div>

                    <div class="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
                        <span class="text-[11px] text-slate-400">${t('quick_actions.save_refresh_tip')}</span>
                        <div class="flex space-x-2">
                            <button type="button" id="edit-cancel-btn" class="px-3.5 py-1.5 rounded-xl text-xs font-semibold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">${t('common.cancel')}</button>
                            <button type="button" id="edit-submit-btn" class="px-4 py-1.5 rounded-xl text-xs font-bold bg-slate-900 hover:bg-black dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white shadow-md cursor-pointer">${t('quick_actions.save_sync')}</button>
                        </div>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);
            this.activeModal = modal;

            document.getElementById('edit-modal-close')?.addEventListener('click', () => this.closeActiveModal());
            document.getElementById('edit-cancel-btn')?.addEventListener('click', () => this.closeActiveModal());

            document.getElementById('edit-submit-btn')?.addEventListener('click', async () => {
                const title = (document.getElementById('edit-title-input')?.value || '').trim();
                const payloadData = {};
                modal.querySelectorAll('textarea[data-field]').forEach(el => {
                    const fieldName = el.getAttribute('data-field');
                    if (fieldName) payloadData[fieldName] = el.value.trim();
                });

                const submitBtn = document.getElementById('edit-submit-btn');
                if (submitBtn) submitBtn.innerText = t('quick_actions.saving_sync');

                try {
                    const res = await fetch('/api/quick-actions/dataset-item', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Admin-CSRF-Token': 'walnut-admin-csrf-valid-token'
                        },
                        body: JSON.stringify({
                            id: existingItem?.id || entityId || undefined,
                            schemaSlug,
                            title,
                            data: payloadData,
                            siteId: this.state?.siteId
                        })
                    });

                    const json = await res.json();
                    if (!res.ok || json.error) {
                        window.showToast((t('quick_actions.save_failed') || '').replace('{{error}}', json.error || 'Unknown error'), 'error');
                        if (submitBtn) submitBtn.innerText = t('quick_actions.save_sync');
                        return;
                    }

                    window.showToast(t('quick_actions.sync_success'), 'success');
                    this.closeActiveModal();
                    setTimeout(() => window.location.reload(), 600);
                } catch (e) {
                    window.showToast(t('quick_actions.req_error'), 'error');
                    if (submitBtn) submitBtn.innerText = t('quick_actions.save_sync');
                }
            });
        }

        onPageTransition() {
            if (!this.state || !this.state.authenticated) return;
            this.mountFloatingActionButton();
            this.buildAvailableCommands();
            this.bindComponentVisualHover();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            rt.quickAction = new WalnutQuickActionEngine();
        });
    } else {
        rt.quickAction = new WalnutQuickActionEngine();
    }

    document.addEventListener('htmx:afterSwap', () => {
        rt.quickAction?.onPageTransition();
    });
    document.addEventListener('htmx:load', () => {
        rt.quickAction?.onPageTransition();
    });
    window.addEventListener('popstate', () => {
        rt.quickAction?.onPageTransition();
    });
})();
