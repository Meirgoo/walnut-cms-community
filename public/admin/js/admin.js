(function() {
    'use strict';

    const t = function(k, params) {
        const fn = window.__EDGE_I18N__ && window.__EDGE_I18N__.t;
        return typeof fn === 'function' ? fn(k, params) : k;
    };

    try {
        if (window.location.pathname === '/admin/login') {
            localStorage.removeItem('edge_admin_hint');
        }
    } catch {}

    document.addEventListener('htmx:afterRequest', function(evt) {
        try {
            const detail = evt && evt.detail;
            const path = detail && detail.pathInfo && detail.pathInfo.requestPath;
            if (path && path.endsWith('/admin/api/login') && detail.xhr && detail.xhr.status >= 200 && detail.xhr.status < 400) {
                localStorage.setItem('edge_admin_hint', '1');
            }
        } catch {}
    });

    document.addEventListener('click', function(evt) {
        const logoutLink = evt.target && evt.target.closest ? evt.target.closest('a[href^="/admin/logout"]') : null;
        if (logoutLink) {
            try { localStorage.removeItem('edge_admin_hint'); } catch {}
        }
    }, true);

    window.$ = function(selector) { return document.querySelector(selector); };
    window.$$ = function(selector) { return document.querySelectorAll(selector); };
    window.alert = function(msg) { if (window.showToast) window.showToast(msg, 'info'); };

    window.showToast = function(msg, type) {
        type = type || 'success';
        const container = document.getElementById('global-toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        let colorClasses = 'bg-stone-900 text-white border-stone-700';
        let iconName = 'check_circle';

        if (type === 'error') {
            colorClasses = 'bg-red-600 text-white border-red-500';
            iconName = 'error';
        } else if (type === 'warning' || type === 'info') {
            colorClasses = 'bg-amber-600 text-white border-amber-500';
            iconName = 'info';
        }

        toast.className = 'toast-animate px-4 py-2.5 rounded-xl shadow-2xl border text-xs font-bold flex items-center space-x-2 pointer-events-auto backdrop-blur-md ' + colorClasses;
        toast.innerHTML = '<span class="material-symbols-outlined text-[18px]">' + iconName + '</span><span>' + msg + '</span>';

        container.appendChild(toast);

        setTimeout(function() {
            toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(15px)';
            setTimeout(function() { toast.remove(); }, 300);
        }, 3000);
    };

    window.showConfirmDialog = function(opts) {
        opts = opts || {};
        const modal = document.getElementById('global-confirm-modal');
        const titleElem = document.getElementById('confirm-modal-title');
        const msgElem = document.getElementById('confirm-modal-msg');
        const okBtn = document.getElementById('confirm-modal-ok');
        const cancelBtn = document.getElementById('confirm-modal-cancel');
        const iconElem = document.getElementById('confirm-modal-icon');

        if (titleElem) titleElem.innerText = opts.title || t('common.prompt_confirm');
        if (msgElem) msgElem.innerText = opts.message || '';
        if (iconElem && opts.icon) iconElem.innerText = opts.icon;

        if (modal) modal.classList.remove('hidden');

        const cleanup = function() {
            if (modal) modal.classList.add('hidden');
            if (okBtn) okBtn.onclick = null;
            if (cancelBtn) cancelBtn.onclick = null;
            document.removeEventListener('keydown', handleKey);
        };

        var handleKey = function(e) {
            if (e.key === 'Escape') cleanup();
        };

        if (okBtn) {
            okBtn.onclick = function() {
                cleanup();
                if (opts.onConfirm) opts.onConfirm();
            };
        }

        if (cancelBtn) cancelBtn.onclick = cleanup;
        if (modal) {
            modal.onclick = function(e) {
                if (e.target === modal) cleanup();
            };
        }
        document.addEventListener('keydown', handleKey);
    };

    // Zero out HTMX swap delay to eliminate blank-flash frames between swaps.
    if (window.htmx) {
        window.htmx.config.defaultSwapDelay = 0;
    }

    if (document.body && !document.body.hasAttribute('hx-sync')) {
        document.body.setAttribute('hx-sync', 'this:replace');
    }

    document.addEventListener('htmx:confirm', function(evt) {
        if (evt.detail && evt.detail.question) {
            evt.preventDefault();
            window.showConfirmDialog({
                title: t('common.prompt_confirm'),
                message: evt.detail.question,
                icon: 'help',
                onConfirm: function() {
                    evt.detail.issueRequest(true);
                }
            });
        }
    });

    document.addEventListener('showToast', function(evt) {
        if (evt.detail && window.showToast) {
            const msg = typeof evt.detail === 'string' ? evt.detail : (evt.detail.message || evt.detail.msg || '');
            const type = typeof evt.detail === 'object' ? (evt.detail.type || 'success') : 'success';
            if (msg) window.showToast(msg, type);
        }
    });

    // Lazy-load the canvas OG generator + media picker bundle on first user click.
    let ogScriptLoadingPromise = null;
    function loadOgCardGeneratorScript() {
        if (!ogScriptLoadingPromise) {
            ogScriptLoadingPromise = new Promise(function(resolve, reject) {
                const adminScript = document.querySelector('script[src*="/admin/js/admin.js"]');
                const q = adminScript && adminScript.src.includes('?') ? adminScript.src.slice(adminScript.src.indexOf('?')) : '';
                const s = document.createElement('script');
                s.src = '/admin/js/og-card-generator.js' + q;
                s.onload = resolve;
                s.onerror = function() {
                    ogScriptLoadingPromise = null;
                    reject(new Error('Failed to load og-card-generator.js'));
                };
                document.head.appendChild(s);
            });
        }
        return ogScriptLoadingPromise;
    }

    ['openOgCardGeneratorModal', 'openMediaPickerForInput'].forEach(function(fnName) {
        if (typeof window[fnName] !== 'function') {
            const stub = function() {
                const args = arguments;
                return loadOgCardGeneratorScript().then(function() {
                    if (typeof window[fnName] === 'function' && !window[fnName].__isLazyStub) {
                        return window[fnName].apply(window, args);
                    }
                }).catch(function(err) {
                    if (window.showToast) window.showToast(err.message || t('common.error'), 'error');
                });
            };
            stub.__isLazyStub = true;
            window[fnName] = stub;
        }
    });

    window.setSidebarCollapse = function(collapsed) {
        const sidebar = document.getElementById('admin-sidebar');
        const toggleIcon = document.querySelector('#sidebar-toggle-btn .material-symbols-outlined');
        if (collapsed) {
            document.documentElement.classList.add('is-sidebar-collapsed');
            if (sidebar) sidebar.classList.add('sidebar-collapsed');
            if (toggleIcon) toggleIcon.textContent = 'menu';
        } else {
            document.documentElement.classList.remove('is-sidebar-collapsed');
            if (sidebar) sidebar.classList.remove('sidebar-collapsed');
            if (toggleIcon) toggleIcon.textContent = 'menu_open';
        }
    };

    function ensureMobileDrawerBackdrop(hostParent) {
        let backdrop = document.getElementById('mobile-drawer-backdrop');
        if (!backdrop) {
            backdrop = document.createElement('div');
            backdrop.id = 'mobile-drawer-backdrop';
            backdrop.className = 'hidden fixed inset-0 z-50 bg-black/25';
            backdrop.addEventListener('click', function() {
                window.closeMobileDrawers();
            });
        }
        const targetParent = hostParent || document.body;
        if (backdrop.parentElement !== targetParent) {
            targetParent.appendChild(backdrop);
        }
        return backdrop;
    }

    window.closeMobileDrawers = function() {
        const leftSb = document.getElementById('admin-sidebar');
        if (leftSb) leftSb.classList.remove('mobile-drawer-open');
        const rightSb = document.getElementById('editor-inspector-sidebar');
        if (rightSb) rightSb.classList.remove('mobile-inspector-open');
        const backdrop = document.getElementById('mobile-drawer-backdrop');
        if (backdrop) backdrop.classList.add('hidden');
    };

    window.toggleMobileSidebarDrawer = function() {
        const leftSb = document.getElementById('admin-sidebar');
        if (!leftSb) return;
        const willOpen = !leftSb.classList.contains('mobile-drawer-open');
        window.closeMobileDrawers();
        if (willOpen) {
            leftSb.classList.add('mobile-drawer-open');
            ensureMobileDrawerBackdrop(document.body).classList.remove('hidden');
        }
    };

    window.toggleAdminSidebar = function() {
        if (window.innerWidth < 768) {
            window.toggleMobileSidebarDrawer();
            return;
        }
        // Lock left sidebar in collapsed icon-rail mode between 768px and 1279px.
        if (window.innerWidth < 1280) {
            return;
        }
        const sidebar = document.getElementById('admin-sidebar');
        if (!sidebar) return;
        const isNowCollapsed = !sidebar.classList.contains('sidebar-collapsed');
        window.setSidebarCollapse(isNowCollapsed);
        try {
            localStorage.setItem('walnut_sidebar_collapsed', isNowCollapsed ? 'true' : 'false');
        } catch {}
    };

    function initSidebar() {
        const sidebar = document.getElementById('admin-sidebar');
        if (!sidebar) return;
        const isEditorRoute = /^\/admin\/(articles|pages|micro)\/(new|edit)(\/|$)/.test(window.location.pathname);
        const cachedCollapsed = localStorage.getItem('walnut_sidebar_collapsed');
        const shouldCollapse = isEditorRoute || window.innerWidth < 1280 ? true : (cachedCollapsed === 'true');
        window.setSidebarCollapse(shouldCollapse);
        if (window.highlightActiveSidebarItem) window.highlightActiveSidebarItem();
    }

    document.addEventListener('htmx:afterSwap', function() {
        if (window.highlightActiveSidebarItem) window.highlightActiveSidebarItem();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSidebar);
    } else {
        initSidebar();
    }

    let resizeTimer;
    let lastWindowWidth = window.innerWidth;
    window.addEventListener('resize', function() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function() {
            const w = window.innerWidth;
            const sidebar = document.getElementById('admin-sidebar');
            if (w >= 1024) {
                window.closeMobileDrawers();
            } else if (w >= 768) {
                const leftSb = document.getElementById('admin-sidebar');
                if (leftSb && leftSb.classList.contains('mobile-drawer-open')) {
                    leftSb.classList.remove('mobile-drawer-open');
                    const rightSb = document.getElementById('editor-inspector-sidebar');
                    if (!rightSb || !rightSb.classList.contains('mobile-inspector-open')) {
                        const bd = document.getElementById('mobile-drawer-backdrop');
                        if (bd) bd.classList.add('hidden');
                    }
                }
            }
            if (w < 1280 && lastWindowWidth >= 1280 && sidebar && !sidebar.classList.contains('sidebar-collapsed')) {
                window.setSidebarCollapse(true);
            }
            lastWindowWidth = w;
        }, 120);
    });

    window.openNewMicroModal = function() {
        const existing = document.getElementById('new-micro-modal');
        if (existing) { existing.classList.remove('hidden'); return; }

        const modal = document.createElement('div');
        modal.id = 'new-micro-modal';
        modal.className = 'fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4';
        modal.innerHTML = `
            <div class="bg-[var(--admin-surface)] rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-[var(--admin-border)] space-y-4">
                <div class="flex justify-between items-center border-b border-[var(--admin-border)] pb-3">
                    <h3 class="text-sm font-bold text-[var(--admin-text)] flex items-center space-x-1.5">
                        <span class="material-symbols-outlined text-[var(--admin-accent-text)] text-[18px]">edit_note</span>
                        <span>${t('micro.btn_new_node')}</span>
                    </h3>
                    <button type="button" onclick="document.getElementById('new-micro-modal').classList.add('hidden')" class="text-[var(--admin-text-muted)] hover:text-[var(--admin-text)] cursor-pointer">
                        <span class="material-symbols-outlined text-[18px]">close</span>
                    </button>
                </div>
                <div class="space-y-3 text-xs">
                    <div class="bg-[var(--admin-accent-soft)] p-2.5 rounded-xl border border-[var(--admin-accent-border)] text-[11px] text-[var(--admin-accent-text)]">
                        ${t('micro.modal_tip')}
                    </div>
                    <div>
                        <label class="block font-bold text-[var(--admin-text-muted)] mb-1">${t('micro.field_title_opt')}</label>
                        <input type="text" id="micro-title-input" placeholder="${t('micro.placeholder_title')}" class="w-full h-8 bg-[var(--admin-canvas)] border border-[var(--admin-border)] rounded-lg px-3 text-xs text-[var(--admin-text)] outline-none focus:border-[var(--admin-accent)]" />
                    </div>
                    <div>
                        <label class="block font-bold text-[var(--admin-text-muted)] mb-1">${t('micro.field_content_opt')}</label>
                        <textarea id="micro-raw-input" rows="4" placeholder="${t('micro.placeholder_content')}" class="w-full bg-[var(--admin-canvas)] border border-[var(--admin-border)] rounded-lg p-3 text-xs text-[var(--admin-text)] outline-none focus:border-[var(--admin-accent)] resize-none"></textarea>
                    </div>
                    <div>
                        <label class="block font-bold text-[var(--admin-text-muted)] mb-1">${t('micro.field_link_opt')}</label>
                        <input type="url" id="micro-link-input" placeholder="https://..." class="w-full h-8 bg-[var(--admin-canvas)] border border-[var(--admin-border)] rounded-lg px-3 text-xs font-mono text-[var(--admin-text)] outline-none focus:border-[var(--admin-accent)]" />
                    </div>
                </div>
                <div class="flex justify-end space-x-2 pt-3 border-t border-[var(--admin-border)]">
                    <button type="button" onclick="document.getElementById('new-micro-modal').classList.add('hidden')" class="h-8 px-3.5 rounded-lg text-xs font-semibold text-[var(--admin-text-muted)] hover:bg-[var(--admin-surface-hover)] cursor-pointer">${t('common.cancel')}</button>
                    <button type="button" id="confirm-save-micro-btn" class="h-8 px-4 rounded-lg text-[13px] font-semibold bg-[var(--admin-accent)] hover:bg-[var(--admin-accent-hover)] text-[var(--admin-accent-on)] shadow-sm cursor-pointer">${t('micro.btn_save_micro')}</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        document.getElementById('confirm-save-micro-btn').onclick = async function() {
            const title = (document.getElementById('micro-title-input').value || '').trim();
            const content = (document.getElementById('micro-raw-input').value || '').trim();
            const link = (document.getElementById('micro-link-input').value || '').trim();

            if (!title && !content && !link) {
                if (window.showToast) window.showToast(t('editor.at_least_one_field'), 'warning');
                return;
            }

            const fd = new FormData();
            const siteSwitcherEl = document.getElementById('site-switcher-input');
            const currentSiteId = siteSwitcherEl ? (siteSwitcherEl.value || '').trim() : '';
            if (currentSiteId) fd.append('site_id', currentSiteId);
            fd.append('type', 'micro');
            fd.append('title', title);
            fd.append('content_raw', content);
            fd.append('link', link);
            fd.append('meta_source_url', link);
            fd.append('maturity', '');
            fd.append('progress', '');
            fd.append('status', 'published');
            fd.append('csrf_token', 'edge-admin-csrf-valid-token');

            try {
                const res = await fetch('/admin/api/save', {
                    method: 'POST',
                    headers: { 'Accept': 'application/json' },
                    body: fd
                });
                const data = await res.json();
                if (data.success) {
                    modal.classList.add('hidden');
                    if (window.showToast) window.showToast(t('micro.save_micro_success'), 'success');
                    setTimeout(function() { window.location.reload(); }, 300);
                } else {
                    if (window.showToast) window.showToast(data.error || t('common.error'), 'error');
                }
            } catch (err) {
                if (window.showToast) window.showToast(err.message || t('common.error'), 'error');
            }
        };
    };

    window.convertMicroToArticle = function(id) {
        if (!id) return;
        if (typeof window.showConfirmDialog === 'function') {
            window.showConfirmDialog({
                title: t('micro.btn_convert_to_article'),
                message: t('micro.confirm_convert_to_article'),
                icon: 'article',
                onConfirm: async function() {
                    try {
                        const res = await fetch('/admin/micros/api/convert-to-article/' + encodeURIComponent(id), {
                            method: 'POST',
                            headers: { 'Accept': 'application/json' }
                        });
                        const data = await res.json();
                        if (data && data.success && data.articleId) {
                            if (window.showToast) window.showToast(t('micro.convert_success'), 'success');
                            setTimeout(function() {
                                window.location.href = '/admin/articles/edit/' + encodeURIComponent(data.articleId);
                            }, 400);
                        } else {
                            if (window.showToast) window.showToast(t('micro.convert_failed', { reason: data.error || 'Unknown error' }), 'error');
                        }
                    } catch (err) {
                        if (window.showToast) window.showToast(t('micro.convert_failed', { reason: err.message }), 'error');
                    }
                }
            });
        }
    };

    window.openSandboxedPreview = function(path, title) {
        if (!path) return;
        const modal = document.getElementById('sandboxed-preview-modal');
        const iframe = document.getElementById('sandboxed-preview-iframe');
        const titleElem = document.getElementById('sandboxed-preview-title');
        const urlElem = document.getElementById('sandboxed-preview-url');
        const extLink = document.getElementById('sandboxed-preview-external-link');

        let normPath = path;
        if (!normPath.startsWith('http://') && !normPath.startsWith('https://')) {
            normPath = normPath.startsWith('/') ? normPath : '/' + normPath;
        }

        const sep = normPath.includes('?') ? '&' : '?';
        const previewUrl = normPath.includes('edge_preview=') ? normPath : (normPath + sep + 'edge_preview=1');

        if (!modal || !iframe) {
            window.open(previewUrl, '_blank', 'noopener,noreferrer');
            return;
        }

        if (titleElem) titleElem.innerText = title || (t('common.preview') || 'Preview');
        if (urlElem) urlElem.innerText = normPath;
        if (extLink) extLink.href = previewUrl;

        window.setPreviewViewport('100%');

        // Neutralize navigation, form submission, and network APIs inside the preview iframe so previews remain read-only.
        iframe.onload = function() {
            try {
                const iDoc = iframe.contentDocument;
                const iWin = iframe.contentWindow;
                if (!iDoc || !iWin) return;

                const curPath = (iWin.location && iWin.location.pathname) || '';
                if (curPath.startsWith('/admin') || curPath.startsWith('/api')) {
                    iframe.src = 'about:blank';
                    if (window.showToast) {
                        window.showToast(t('preview.admin_blocked') || 'Admin access blocked in preview mode', 'error');
                    }
                    return;
                }

                iDoc.addEventListener('click', function(e) {
                    const link = e.target && e.target.closest ? e.target.closest('a') : null;
                    if (link) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (window.showToast) {
                            window.showToast(t('preview.navigation_blocked') || 'Navigation is blocked in preview mode', 'warning');
                        }
                        return false;
                    }
                }, true);

                iDoc.addEventListener('submit', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (window.showToast) {
                        window.showToast(t('preview.requests_blocked') || 'Form submissions and network requests are blocked in preview mode', 'warning');
                    }
                    return false;
                }, true);

                iWin.fetch = function() {
                    console.warn('[Walnut Preview Sandbox] fetch blocked: network is disabled in preview mode.');
                    return Promise.reject(new Error('Network requests disabled in preview mode'));
                };

                const OrigXHR = iWin.XMLHttpRequest;
                iWin.XMLHttpRequest = function() {
                    const xhr = new OrigXHR();
                    xhr.open = function(method, url) {
                        console.warn('[Walnut Preview Sandbox] XHR blocked: ' + method + ' ' + url);
                    };
                    xhr.send = function() {
                        console.warn('[Walnut Preview Sandbox] XHR send blocked');
                    };
                    return xhr;
                };

                if (iWin.navigator) {
                    iWin.navigator.sendBeacon = function() {
                        console.warn('[Walnut Preview Sandbox] sendBeacon blocked');
                        return false;
                    };
                }

                try {
                    iWin.WebSocket = undefined;
                    iWin.EventSource = undefined;
                } catch {}
            } catch (err) {
                console.warn('[Walnut Preview Sandbox] Sandbox attachment notice:', err);
            }
        };

        iframe.src = previewUrl;
        modal.classList.remove('hidden');
    };

    window.closeSandboxedPreview = function() {
        const modal = document.getElementById('sandboxed-preview-modal');
        const iframe = document.getElementById('sandboxed-preview-iframe');
        if (modal) modal.classList.add('hidden');
        if (iframe) {
            iframe.onload = null;
            iframe.src = 'about:blank';
        }
    };

    window.setPreviewViewport = function(width) {
        const iframe = document.getElementById('sandboxed-preview-iframe');
        if (!iframe) return;
        iframe.style.maxWidth = width;

        const btnDesktop = document.getElementById('preview-vp-desktop');
        const btnTablet = document.getElementById('preview-vp-tablet');
        const btnMobile = document.getElementById('preview-vp-mobile');
        [btnDesktop, btnTablet, btnMobile].forEach(function(btn) {
            if (btn) {
                btn.classList.remove('bg-white', 'dark:bg-stone-800', 'shadow-sm');
                btn.classList.add('hover:bg-white/50', 'dark:hover:bg-stone-800/50');
            }
        });

        let activeBtn = btnDesktop;
        if (width === '768px') activeBtn = btnTablet;
        if (width === '375px') activeBtn = btnMobile;
        if (activeBtn) {
            activeBtn.classList.remove('hover:bg-white/50', 'dark:hover:bg-stone-800/50');
            activeBtn.classList.add('bg-white', 'dark:bg-stone-800', 'shadow-sm');
        }
    };

    window.getAdminThemeMode = function() {
        return localStorage.getItem('edge_theme_mode') || 'system';
    };

    window.applyThemeMode = function(mode) {
        mode = mode || window.getAdminThemeMode();
        localStorage.setItem('edge_theme_mode', mode);

        let isDark;
        if (mode === 'dark') {
            isDark = true;
        } else if (mode === 'light') {
            isDark = false;
        } else {
            isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        }

        document.documentElement.classList.toggle('dark', isDark);
        document.documentElement.setAttribute('data-theme-mode', mode);

        if (typeof window.syncThemePreviewsDarkMode === 'function') {
            window.syncThemePreviewsDarkMode(isDark);
        }

        const select = document.getElementById('settings-theme-mode-select');
        if (select && select.value !== mode) {
            select.value = mode;
        }
    };

    window.toggleAdminThemeMode = function() {
        const cur = window.getAdminThemeMode();
        const next = cur === 'system' ? 'light' : (cur === 'light' ? 'dark' : 'system');
        window.applyThemeMode(next);
        const labelMap = {
            system: t('common.theme_system'),
            light: t('common.theme_light'),
            dark: t('common.theme_dark')
        };
        const toastMsg = t('common.theme_switched_toast', { mode: labelMap[next] });
        const finalMsg = (toastMsg && toastMsg !== 'common.theme_switched_toast')
            ? toastMsg
            : t('settings.theme_switched_toast', { mode: labelMap[next] });
        if (window.showToast) window.showToast(finalMsg, 'info');
    };

    function initThemeSystemSync() {
        window.applyThemeMode();

        const paletteSelect = document.getElementById('profile-palette-select');
        if (paletteSelect) {
            const currentPalette = document.documentElement.dataset.palette || localStorage.getItem('edge_admin_palette') || 'walnut';
            if (paletteSelect.value !== currentPalette) {
                paletteSelect.value = currentPalette;
            }
        }

        if (window.matchMedia) {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
                if (window.getAdminThemeMode() === 'system') {
                    window.applyThemeMode('system');
                }
            });
        }

        setInterval(function() {
            if (window.getAdminThemeMode() === 'system') {
                window.applyThemeMode('system');
            }
        }, 15000);

        const select = document.getElementById('settings-theme-mode-select');
        if (select) {
            select.addEventListener('change', function() {
                window.applyThemeMode(this.value);
            });
        }
    }

    window.authorizeEpubReader = async function(btn) {
        if (!btn) return;
        const siteId = btn.dataset.siteId || 'site_default';
        const appName = btn.dataset.app || 'grain';
        const callbackUrl = btn.dataset.callback || '';
        const span = btn.querySelector('span:last-child');
        btn.disabled = true;
        if (span && btn.dataset.labelLoading) span.innerText = btn.dataset.labelLoading;
        try {
            const res = await fetch('/api/ecosystem/pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ siteId: siteId, app: appName })
            });
            const json = await res.json();
            if (!res.ok || !json.code) {
                window.showToast && window.showToast(json.error || 'Pairing failed', 'error');
                return;
            }
            const resBox = document.getElementById('epub-pair-result');
            const codeEl = document.getElementById('epub-pair-code');
            if (codeEl) codeEl.textContent = json.code;
            if (resBox) resBox.classList.remove('hidden');
            if (callbackUrl) {
                const cbMsg = document.getElementById('epub-callback-msg');
                if (cbMsg) cbMsg.classList.remove('hidden');
                const sep = callbackUrl.includes('?') ? '&' : '?';
                setTimeout(function() {
                    window.location.href = callbackUrl + sep + 'code=' + encodeURIComponent(json.code);
                }, 900);
            }
        } catch {
            window.showToast && window.showToast('Network error', 'error');
        } finally {
            btn.disabled = false;
            if (span && btn.dataset.labelDefault) span.innerText = btn.dataset.labelDefault;
        }
    };

    function initFastMemoSubmitListener() {
        const memoTitle = document.getElementById('memo-title');
        const memoContent = document.getElementById('memo-content');
        const autoSlug = document.getElementById('auto-slug');

        if (memoContent && autoSlug) {
            const form = memoContent.closest('form');
            if (form) {
                form.addEventListener('submit', function() {
                    const content = memoContent.value.trim();
                    if (memoTitle && !memoTitle.value.trim() && content) {
                        const firstLine = content.split('\n')[0].replace(/^#+\s*/, '').slice(0, 30);
                        memoTitle.value = firstLine || (t('fast_memo.default_title_prefix') + new Date().toLocaleDateString());
                    }
                    if (!autoSlug.value) {
                        autoSlug.value = 'memo-' + Date.now().toString(36);
                    }
                });
            }
        }
    }

    document.addEventListener('click', function(e) {
        const schemaBox = document.getElementById('dropdown-box-dataset-schema');
        const schemaMenu = document.getElementById('dropdown-menu-dataset-schema');
        if (schemaBox && schemaMenu && !schemaBox.contains(e.target)) {
            schemaMenu.classList.add('hidden');
        }
    });

    const unlockFoucCloak = function(root) {
        const target = root || document;
        target.querySelectorAll?.('[data-cloak], [walnut-cloak], .walnut-cloak').forEach(function(el) {
            el.removeAttribute('data-cloak');
            el.removeAttribute('walnut-cloak');
            el.classList.remove('walnut-cloak');
        });
    };
    window.unlockFoucCloak = unlockFoucCloak;

    window.switchSettingsTab = function(tabKey) {
        const valid = ['basic', 'seo', 'commercial', 'ecosystem', 'backup'];
        const active = valid.includes(tabKey) ? tabKey : 'basic';
        const actionTabs = ['ecosystem', 'backup'];
        valid.forEach(function(key) {
            const panel = document.getElementById('settings-panel-' + key);
            const btn = document.getElementById('settings-tab-btn-' + key);
            if (panel) panel.classList.toggle('hidden', key !== active);
            if (btn) {
                const hiddenCls = btn.classList.contains('hidden') ? ' hidden' : '';
                btn.className = (key === active
                    ? 'settings-tab-btn pb-3 text-xs font-semibold border-b-2 border-[var(--admin-accent)] text-[var(--admin-text)] whitespace-nowrap cursor-pointer transition-colors'
                    : 'settings-tab-btn pb-3 text-xs font-semibold border-b-2 border-transparent text-[var(--admin-text-muted)] hover:text-[var(--admin-text)] whitespace-nowrap cursor-pointer transition-colors') + hiddenCls;
            }
        });
        const saveBtn = document.getElementById('settings-top-save-btn');
        if (saveBtn) saveBtn.classList.toggle('hidden', actionTabs.includes(active));
        try {
            const url = new URL(window.location.href);
            url.searchParams.set('tab', active);
            window.history.replaceState({}, '', url.toString());
        } catch {}
    };

    function initSettingsTabFromQuery() {
        if (!document.getElementById('settings-panel-basic')) return;
        const tab = new URLSearchParams(window.location.search).get('tab');
        if (tab && document.getElementById('settings-panel-' + tab)) {
            const btn = document.getElementById('settings-tab-btn-' + tab);
            if (btn && !btn.classList.contains('hidden')) {
                window.switchSettingsTab(tab);
            }
        }
    }
    document.addEventListener('DOMContentLoaded', initSettingsTabFromQuery);
    document.addEventListener('htmx:afterSettle', initSettingsTabFromQuery);

    window.filterDashboardTimeline = function(filterKey) {
        const target = filterKey || 'all';
        document.querySelectorAll('.timeline-filter-btn').forEach(function(btn) {
            const isActive = btn.getAttribute('data-filter') === target;
            btn.className = isActive
                ? 'timeline-filter-btn h-full px-2.5 rounded-md bg-[var(--admin-accent-soft)] text-[var(--admin-accent-text)] transition-colors cursor-pointer'
                : 'timeline-filter-btn h-full px-2.5 rounded-md text-[var(--admin-text-muted)] hover:text-[var(--admin-text)] transition-colors cursor-pointer';
        });
        const list = document.getElementById('dashboard-timeline-list') || document;
        list.querySelectorAll('.dashboard-timeline-item').forEach(function(row) {
            const cat = row.getAttribute('data-category') || 'content';
            const mod = row.getAttribute('data-feed-module') || 'article';
            const show = target === 'all' || (target === 'system' ? cat === 'system' : mod === target);
            row.style.display = show ? '' : 'none';
        });
    };

    window.rebuildDirtyRoutes = async function(btn) {
        if (btn) {
            btn.disabled = true;
            btn.style.opacity = '0.7';
        }
        try {
            const res = await fetch('/admin/api/rebuild-dirty-routes', { method: 'POST' });
            const data = await res.json();
            if (res.ok && data.success) {
                if (window.showToast) window.showToast(data.message || t('common.success'), 'success');
                setTimeout(function() { window.location.reload(); }, 450);
            } else {
                if (window.showToast) window.showToast(data.error || t('common.error'), 'error');
                if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
            }
        } catch {
            if (window.showToast) window.showToast(t('common.network_error'), 'error');
            if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
        }
    };

    document.addEventListener('DOMContentLoaded', function() {
        if (document.body && !document.body.hasAttribute('hx-sync')) {
            document.body.setAttribute('hx-sync', 'this:replace');
        }
        unlockFoucCloak();
        initFastMemoSubmitListener();
        initThemeSystemSync();
    });

    window.toggleWizardInitMode = function(mode) {
        const cp = document.getElementById('wizard-clone-panel');
        const sp = document.getElementById('wizard-snapshot-panel');
        if (cp) cp.classList.toggle('hidden', mode !== 'clone');
        if (sp) sp.classList.toggle('hidden', mode !== 'snapshot');
    };

    window.toggleSiteDropdown = function(btn, fromCollapsed, event) {
        if (event) event.stopPropagation();
        var menu = document.getElementById('site-dropdown-menu');
        var wrapper = document.getElementById('site-dropdown-wrapper');
        if (!menu || !btn) return;

        var isHidden = menu.classList.contains('hidden');
        if (!isHidden) {
            menu.classList.add('hidden');
            return;
        }

        if (fromCollapsed) {
            if (menu.parentElement !== document.body) {
                document.body.appendChild(menu);
            }
            var rect = btn.getBoundingClientRect();
            menu.style.position = 'fixed';
            menu.style.left = (rect.right + 8) + 'px';
            menu.style.right = 'auto';
            menu.style.top = Math.max(8, Math.min(rect.top, window.innerHeight - 240)) + 'px';
            menu.style.width = '220px';
            menu.style.marginTop = '0';
            menu.style.zIndex = '9999';
        } else {
            if (wrapper && menu.parentElement !== wrapper) {
                wrapper.appendChild(menu);
            }
            menu.style.position = '';
            menu.style.left = '';
            menu.style.right = '';
            menu.style.top = '';
            menu.style.width = '';
            menu.style.marginTop = '';
            menu.style.zIndex = '';
        }

        menu.classList.remove('hidden');
        if (!window.__edgeSiteDropdownBound) {
            window.__edgeSiteDropdownBound = true;
            document.addEventListener('click', function(ev) {
                var m = document.getElementById('site-dropdown-menu');
                if (!m || m.classList.contains('hidden')) return;
                var w = document.getElementById('site-dropdown-wrapper');
                var cBtn = document.getElementById('collapsed-site-switcher-btn');
                if (m.contains(ev.target)) return;
                if (w && w.contains(ev.target)) return;
                if (cBtn && cBtn.contains(ev.target)) return;
                m.classList.add('hidden');
            });
        }
    };

    document.addEventListener('change', function(ev) {
        var target = ev.target;
        if (!target || !target.id) return;
        if (target.id === 'settings-site-mode-input') {
            var panel = document.getElementById('internal-mode-config-panel');
            if (panel) panel.classList.toggle('hidden', target.value !== 'internal');
        } else if (target.id === 'settings-internal-status-input') {
            var isRedirect = target.value === '301' || target.value === '302';
            var redirectGroup = document.getElementById('internal-redirect-group');
            var pageGroup = document.getElementById('internal-page-group');
            if (redirectGroup) redirectGroup.classList.toggle('hidden', !isRedirect);
            if (pageGroup) pageGroup.classList.toggle('hidden', isRedirect);
        }
    });

    const EDGE_FORBIDDEN_ROUTE_PREFIX_KEYS = {
        'admin': 'common.route_forbidden_admin',
        'api': 'common.route_forbidden_api',
        'desk': 'common.route_forbidden_desk',
        'shared': 'common.route_forbidden_shared',
        'assets': 'common.route_forbidden_assets',
        'content': 'common.route_forbidden_content',
        'theme': 'common.route_forbidden_theme',
        'commercial': 'common.route_forbidden_commercial',
        'cdn-cgi': 'common.route_forbidden_cdncgi',
        '.well-known': 'common.route_forbidden_wellknown'
    };

    const EDGE_FORBIDDEN_EXACT_ROUTE_KEYS = {
        '/sitemap.xml': { key: 'common.route_forbidden_sitemap' },
        '/robots.txt': { key: 'common.route_forbidden_robots' },
        '/favicon.ico': { key: 'common.route_forbidden_favicon' },
        '/app.css': { key: 'common.route_forbidden_appcss' },
        '/zh-cn': { key: 'common.route_forbidden_locale', params: { path: '/zh-CN' } },
        '/en-us': { key: 'common.route_forbidden_locale', params: { path: '/en-US' } }
    };

    window.inspectEdgeSpecialRouteSlug = function(rawVal, fullPath) {
        const rawTrimmed = (rawVal || '').trim();
        const lowerPath = (fullPath || '/').toLowerCase();
        const firstSeg = lowerPath.replace(/^\/+/, '').split('/')[0] || '';
        const trFn = (typeof window.__EDGE_I18N__?.t === 'function')
            ? function(k, p) { return window.__EDGE_I18N__.t(k, p); }
            : function(k) { return k; };

        if (EDGE_FORBIDDEN_EXACT_ROUTE_KEYS[lowerPath]) {
            const rule = EDGE_FORBIDDEN_EXACT_ROUTE_KEYS[lowerPath];
            return { level: 'forbidden', message: trFn(rule.key, rule.params) };
        }
        if (firstSeg && EDGE_FORBIDDEN_ROUTE_PREFIX_KEYS[firstSeg]) {
            return { level: 'forbidden', message: trFn(EDGE_FORBIDDEN_ROUTE_PREFIX_KEYS[firstSeg]) };
        }
        if (lowerPath === '/') {
            const isRawIndex = rawTrimmed.replace(/^\/+|\/+$/g, '').toLowerCase() === 'index';
            return { level: 'warning', message: trFn(isRawIndex ? 'common.route_warn_home_index' : 'common.route_warn_home_root') };
        }
        if (lowerPath === '/404') return { level: 'warning', message: trFn('common.route_warn_404') };
        if (lowerPath === '/500') return { level: 'warning', message: trFn('common.route_warn_500') };
        if (lowerPath === '/503' || lowerPath === '/maintenance') {
            return { level: 'warning', message: trFn('common.route_warn_503', { path: fullPath }) };
        }
        return { level: 'none', message: '' };
    };

    window.renderEdgeSpecialRouteHint = function(hintEl, inputEl, checkResult) {
        if (!hintEl) return;
        if (!checkResult || checkResult.level === 'none') {
            hintEl.className = 'hidden text-[11px] px-2.5 py-2 rounded-lg border font-medium leading-relaxed';
            hintEl.textContent = '';
            if (inputEl) inputEl.classList.remove('border-red-500', 'dark:border-red-500', 'border-amber-400', 'dark:border-amber-500', 'border-[var(--admin-accent-border)]');
            return;
        }
        const isForbidden = checkResult.level === 'forbidden';
        hintEl.className = isForbidden
            ? 'text-[11px] px-2.5 py-1.5 rounded-lg border font-semibold leading-relaxed hint-special-forbidden'
            : 'text-[11px] px-2.5 py-1.5 rounded-lg border font-medium leading-relaxed hint-special-warning';
        hintEl.textContent = checkResult.message;
        if (inputEl) {
            inputEl.classList.toggle('border-red-500', isForbidden);
            inputEl.classList.toggle('border-[var(--admin-accent-border)]', !isForbidden);
        }
    };

    window.walnutCopyText = async function(text, okMsg, errMsg) {
        const str = String(text ?? '');
        try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(str);
            } else {
                const ta = document.createElement('textarea');
                ta.value = str;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
            }
            if (window.showToast && okMsg) window.showToast(okMsg, 'success');
            return true;
        } catch (e) {
            if (window.showToast && errMsg) window.showToast(errMsg, 'error');
            return false;
        }
    };

    window.walnutDownloadFile = function(filename, content, mimeType) {
        const blob = new Blob([String(content ?? '')], { type: mimeType || 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    };

    window.walnutReadFileInput = function(inputEl, onLoaded) {
        if (!inputEl) return;
        inputEl.addEventListener('change', function() {
            const file = inputEl.files && inputEl.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function(ev) {
                if (typeof onLoaded === 'function') {
                    onLoaded(String(ev.target && ev.target.result || ''), file);
                }
            };
            reader.readAsText(file);
        });
    };
})();
