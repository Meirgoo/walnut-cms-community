(function() {
    'use strict';

    const t = function(k, params) {
        const fn = window.__WALNUT_I18N__ && window.__WALNUT_I18N__.t;
        return typeof fn === 'function' ? fn(k, params) : k;
    };

    function isCpuLimitResponse(status, textBody) {
        if (status === 503 && String(textBody || '').includes('1102')) return true;
        if (status === 422 && String(textBody || '').includes('SOFT_CPU_LIMIT')) return true;
        return false;
    }

    if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
        const _origFetch = window.fetch.bind(window);
        window.fetch = async function(input, init) {
            const res = await _origFetch(input, init);
            if (res.status === 503 || res.status === 422) {
                try {
                    const text = await res.clone().text();
                    if (isCpuLimitResponse(res.status, text)) {
                        if (window.showToast) window.showToast(t('common.soft_cpu_limit_warning'), 'warning');
                    }
                } catch {}
            }
            return res;
        };
    }

    try {
        if (window.location.pathname === '/admin/login') {
            localStorage.removeItem('walnut_admin_hint');
        }
    } catch {}

    document.addEventListener('htmx:afterRequest', function(evt) {
        try {
            const detail = evt && evt.detail;
            const path = detail && detail.pathInfo && detail.pathInfo.requestPath;
            if (path && path.endsWith('/admin/api/login') && detail.xhr && detail.xhr.status >= 200 && detail.xhr.status < 400) {
                localStorage.setItem('walnut_admin_hint', '1');
            }
        } catch {}
    });

    document.addEventListener('click', function(evt) {
        const logoutLink = evt.target && evt.target.closest ? evt.target.closest('a[href^="/admin/logout"]') : null;
        if (logoutLink) {
            try { localStorage.removeItem('walnut_admin_hint'); } catch {}
        }
    }, true);

    document.addEventListener('htmx:responseError', function(evt) {
        const xhr = evt && evt.detail && evt.detail.xhr;
        if (xhr && isCpuLimitResponse(xhr.status, xhr.responseText)) {
            if (window.showToast) window.showToast(t('common.soft_cpu_limit_warning'), 'warning');
        }
    });

    function splitContentSmartChunks(text, targetBytes) {
        const encoder = new TextEncoder();
        if (encoder.encode(text).length <= 50 * 1024 && targetBytes >= 40 * 1024) {
            return [text];
        }
        const chunks = [];
        let start = 0;
        const approxCharsPerByte = text.length / Math.max(1, encoder.encode(text).length);
        while (start < text.length) {
            const estSpan = Math.max(1024, Math.floor(targetBytes * approxCharsPerByte));
            const maxChunkBytes = targetBytes + 8 * 1024;
            if (start + estSpan >= text.length && encoder.encode(text.slice(start)).length <= maxChunkBytes) {
                chunks.push(text.slice(start));
                break;
            }
            let cut = Math.min(text.length, start + estSpan);
            const doubleNl = text.lastIndexOf('\n\n', cut);
            if (doubleNl > start + Math.floor(estSpan * 0.4)) {
                cut = doubleNl + 2;
            } else {
                const singleNl = text.lastIndexOf('\n', cut);
                if (singleNl > start + Math.floor(estSpan * 0.4)) {
                    cut = singleNl + 1;
                }
            }
            // Enforce <= 48KB UTF-8 byte cap (when targetBytes is 40KB) so newline-free payloads stay within request limits.
            while (cut > start + 1 && encoder.encode(text.slice(start, cut)).length > maxChunkBytes) {
                cut = start + Math.max(1, Math.floor((cut - start) * 0.8));
            }
            chunks.push(text.slice(start, cut));
            start = cut;
        }
        return chunks;
    }

    window.walnutSaveLongArticleChunks = async function(payload) {
        const fullText = String(payload.contentRaw || '');
        let targetBytes = 40 * 1024;
        let chunks = splitContentSmartChunks(fullText, targetBytes);
        let articleId = payload.id || '';
        let versionId = '';
        let idx = 0;

        while (idx < chunks.length) {
            const mode = idx === 0 ? 'init' : (idx === chunks.length - 1 ? 'commit' : 'append');
            if (window.showToast) {
                window.showToast(t('common.chunk_save_progress', { current: idx + 1, total: chunks.length }), 'info');
            }
            const res = await fetch('/admin/articles/api/save-chunk', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Admin-CSRF-Token': 'walnut-admin-csrf-valid-token'
                },
                body: JSON.stringify({
                    articleId: articleId || undefined,
                    versionId: versionId || undefined,
                    chunkMode: mode,
                    chunkText: chunks[idx],
                    title: payload.title,
                    slug: payload.slug,
                    summary: payload.summary,
                    locale: payload.locale,
                    status: payload.status,
                    maturity: payload.maturity,
                    translationGroupId: payload.translationGroupId,
                    metadata: payload.metadata
                })
            });
            const bodyText = await res.clone().text();
            if (isCpuLimitResponse(res.status, bodyText) && targetBytes > 8 * 1024) {
                targetBytes = Math.max(8 * 1024, Math.floor(targetBytes / 2));
                const remaining = chunks.slice(idx).join('');
                const reChunks = splitContentSmartChunks(remaining, targetBytes);
                chunks = chunks.slice(0, idx).concat(reChunks);
                await new Promise(function(r) { setTimeout(r, 500); });
                continue;
            }
            const json = JSON.parse(bodyText || '{}');
            if (!res.ok || !json.success) {
                throw new Error(json.error || t('common.error'));
            }
            articleId = json.id || articleId;
            versionId = json.versionId || versionId;
            idx++;
        }
        return { id: articleId, versionId: versionId, chunks: chunks.length };
    };

    document.addEventListener('submit', async function(evt) {
        const form = evt.target;
        if (!form || form.id !== 'editor-form') return;
        const typeInput = form.querySelector('input[name="type"]');
        const contentInput = form.querySelector('textarea[name="content_raw"]') || document.getElementById('editor-core');
        if (!typeInput || typeInput.value !== 'article' || !contentInput) return;
        const raw = contentInput.value || '';
        if (new Blob([raw]).size <= 50 * 1024) return;

        evt.preventDefault();
        evt.stopPropagation();
        try {
            const fd = new FormData(form);
            const res = await window.walnutSaveLongArticleChunks({
                id: fd.get('id') || '',
                title: fd.get('title') || '',
                slug: fd.get('slug') || '',
                summary: fd.get('summary') || '',
                locale: fd.get('locale') || 'zh-CN',
                status: fd.get('status') || 'published',
                contentRaw: raw
            });
            if (window.showToast) window.showToast(t('common.success'), 'success');
            if (!fd.get('id') && res.id) {
                window.location.href = '/admin/articles/edit/' + res.id;
            }
        } catch (err) {
            if (window.showToast) window.showToast(err.message || t('common.error'), 'error');
        }
    }, true);

    function mergeAdminDict(target, source) {
        if (!source || typeof source !== 'object') return target;
        for (const k in source) {
            if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])) {
                target[k] = Object.assign(target[k] || {}, source[k]);
            } else {
                target[k] = source[k];
            }
        }
        return target;
    }

    function syncAdminDict(root) {
        try {
            const doc = root && root.querySelector ? root : document;
            const el = doc.querySelector ? doc.querySelector('#walnut-i18n-dict') : document.getElementById('walnut-i18n-dict');
            if (el && el.textContent) {
                const parsed = JSON.parse(el.textContent);
                const i18nStore = (window.__WALNUT_I18N__ = window.__WALNUT_I18N__ || {});
                i18nStore.dict = i18nStore.dict || {};
                mergeAdminDict(i18nStore.dict, parsed);
                i18nStore.adminDict = i18nStore.dict;
            }
        } catch(e) {}
    }
    syncAdminDict();
    document.addEventListener('htmx:afterSwap', function(evt) {
        syncAdminDict(evt && evt.detail && evt.detail.elt);
    });
    window.dispatchEvent(new CustomEvent('walnut:i18n-loaded'));

    class WalnutSelect extends HTMLElement {
        constructor() {
            super();
            this._value = '';
            this._options = [];
            this._selectedIndex = -1;
            this._isOpen = false;
            this._onDocumentClick = this._onDocumentClick.bind(this);
            this._onKeyDown = this._onKeyDown.bind(this);
        }

        connectedCallback() {
            if (this._initialized) return;

            const menuId = this.getAttribute('data-menu-id');
            if (menuId) {
                if (this._initStructuredDropdown(menuId)) {
                    this._initialized = true;
                    return;
                }
                const self = this;
                setTimeout(function() {
                    if (self._initialized) return;
                    if (self._initStructuredDropdown(menuId)) {
                        self._initialized = true;
                    }
                }, 0);
                return;
            }

            const rawOptions = Array.from(this.querySelectorAll('option'));
            if (rawOptions.length > 0) {
                this._initOptionsDropdown(rawOptions);
                this._initialized = true;
                return;
            }

            // Retry on the next task because streaming HTML parsing may fire connectedCallback before child <option> tags mount.
            const self = this;
            setTimeout(function() {
                if (self._initialized) return;
                const deferredOptions = Array.from(self.querySelectorAll('option'));
                if (deferredOptions.length > 0) {
                    self._initOptionsDropdown(deferredOptions);
                    self._initialized = true;
                } else {
                    self._initEmptyDropdown();
                    self._initialized = true;
                }
            }, 0);
        }

        disconnectedCallback() {
            document.removeEventListener('click', this._onDocumentClick);
            document.removeEventListener('keydown', this._onKeyDown);
        }

        _initOptionsDropdown(rawOptions) {
            this._options = rawOptions.map(function(opt) {
                return {
                    value: opt.getAttribute('value') !== null ? opt.getAttribute('value') : (opt.textContent || '').trim(),
                    label: (opt.textContent || '').trim(),
                    selected: opt.hasAttribute('selected')
                };
            });

            rawOptions.forEach(function(opt) { opt.style.display = 'none'; });

            if (!this.classList.contains('relative') && !this.classList.contains('absolute') && !this.classList.contains('fixed')) {
                this.classList.add('relative');
            }
            if (!this.style.display && getComputedStyle(this).display === 'inline') {
                this.style.display = 'inline-block';
            }

            let initialValue = this.getAttribute('value');
            let selectedOpt = null;
            if (initialValue !== null) {
                selectedOpt = this._options.find(function(o) { return o.value === initialValue; });
            }
            if (!selectedOpt) {
                selectedOpt = this._options.find(function(o) { return o.selected; }) || this._options[0];
            }

            this._value = selectedOpt ? selectedOpt.value : '';
            this._selectedIndex = selectedOpt ? this._options.indexOf(selectedOpt) : 0;

            const nameAttr = this.getAttribute('name');
            this._hiddenInput = document.createElement('input');
            this._hiddenInput.type = 'hidden';
            if (nameAttr) this._hiddenInput.name = nameAttr;
            this._hiddenInput.value = this._value;
            this.appendChild(this._hiddenInput);

            this._triggerBtn = document.createElement('button');
            this._triggerBtn.type = 'button';
            this._triggerBtn.className = 'walnut-select-trigger flex items-center justify-between space-x-1.5 w-full h-full min-w-0 leading-none bg-transparent text-inherit outline-none cursor-pointer';

            this._labelEl = document.createElement('span');
            this._labelEl.className = 'walnut-select-label truncate';
            this._labelEl.textContent = selectedOpt ? selectedOpt.label : '';
            this._triggerBtn.appendChild(this._labelEl);

            this._arrowEl = document.createElement('span');
            this._arrowEl.className = 'material-symbols-outlined text-[14px] opacity-70 shrink-0 transition-transform duration-200 select-none';
            this._arrowEl.textContent = 'expand_more';
            this._triggerBtn.appendChild(this._arrowEl);

            this.appendChild(this._triggerBtn);

            this._menuEl = document.createElement('div');
            this._menuEl.className = 'walnut-select-menu hidden absolute left-0 top-full mt-1 min-w-full w-max max-w-[280px] bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700/80 rounded-xl shadow-2xl py-1 z-[9999] overflow-hidden ring-1 ring-black/5 dark:ring-black/20';

            const self = this;
            this._options.forEach(function(opt, idx) {
                const itemEl = document.createElement('div');
                itemEl.className = 'walnut-select-item flex items-center justify-between px-3 py-1.5 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer transition-colors ' +
                    (opt.value === self._value ? 'bg-slate-100 dark:bg-slate-800/80 text-emerald-600 dark:text-emerald-400 font-bold' : 'font-medium');
                itemEl.setAttribute('data-value', opt.value);
                itemEl.setAttribute('data-index', String(idx));

                const textSpan = document.createElement('span');
                textSpan.className = 'truncate mr-2';
                textSpan.textContent = opt.label;
                itemEl.appendChild(textSpan);

                const checkIcon = document.createElement('span');
                checkIcon.className = 'material-symbols-outlined text-[14px] text-emerald-600 dark:text-emerald-400 shrink-0 ' + (opt.value === self._value ? '' : 'invisible');
                checkIcon.textContent = 'check';
                itemEl.appendChild(checkIcon);

                itemEl.addEventListener('click', function(e) {
                    e.stopPropagation();
                    self.selectedIndex = idx;
                    self._close();
                    self._fireChange();
                });

                self._menuEl.appendChild(itemEl);
            });

            this.appendChild(this._menuEl);

            this._triggerBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (self._isOpen) {
                    self._close();
                } else {
                    self._open();
                }
            });

            document.addEventListener('click', this._onDocumentClick);
            document.addEventListener('keydown', this._onKeyDown);
        }

        _initStructuredDropdown(menuId) {
            const self = this;
            const menu = document.getElementById(menuId);
            const triggerBtn = this.querySelector('button') || this.querySelector('[data-role="trigger"]');
            if (!menu || !triggerBtn) return false;
            this._menuEl = menu;

            const inputId = this.getAttribute('data-input-id');
            const labelId = this.getAttribute('data-label-id');
            if (inputId) this._hiddenInput = document.getElementById(inputId);
            if (labelId) this._labelEl = document.getElementById(labelId);

            triggerBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                const isHidden = menu.classList.contains('hidden');
                document.querySelectorAll('.walnut-select-menu:not(.hidden)').forEach(function(m) {
                    if (m !== menu) m.classList.add('hidden');
                });
                if (isHidden) {
                    menu.classList.remove('hidden');
                    const rect = triggerBtn.getBoundingClientRect();
                    const menuHeight = menu.offsetHeight || 140;
                    const spaceBelow = window.innerHeight - rect.bottom;
                    const spaceAbove = rect.top;
                    if (spaceBelow < menuHeight && spaceAbove > spaceBelow) {
                        menu.classList.remove('top-full', 'mt-1');
                        menu.classList.add('bottom-full', 'mb-1');
                    } else {
                        menu.classList.remove('bottom-full', 'mb-1');
                        menu.classList.add('top-full', 'mt-1');
                    }
                } else {
                    menu.classList.add('hidden');
                }
            });

            const items = menu.querySelectorAll('[data-value]');
            items.forEach(function(item) {
                item.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const val = item.getAttribute('data-value');
                    const label = item.getAttribute('data-label') || (item.textContent || '').trim();
                    self.value = val;
                    if (self._labelEl) self._labelEl.textContent = label;
                    menu.classList.add('hidden');
                    self._fireChange();
                });
            });

            document.addEventListener('click', function(e) {
                if (!self.contains(e.target) && !menu.contains(e.target)) {
                    menu.classList.add('hidden');
                }
            });
            return true;
        }

        _initEmptyDropdown() {
            this._options = [];
        }

        _open() {
            document.querySelectorAll('walnut-select').forEach(function(el) {
                if (typeof el._close === 'function') el._close();
            });
            if (this._menuEl) {
                this._menuEl.classList.remove('hidden');

                const rect = this.getBoundingClientRect();
                const menuHeight = this._menuEl.offsetHeight || 140;
                const spaceBelow = window.innerHeight - rect.bottom;
                const spaceAbove = rect.top;

                if (spaceBelow < menuHeight && spaceAbove > spaceBelow) {
                    this._menuEl.classList.remove('top-full', 'mt-1');
                    this._menuEl.classList.add('bottom-full', 'mb-1');
                } else {
                    this._menuEl.classList.remove('bottom-full', 'mb-1');
                    this._menuEl.classList.add('top-full', 'mt-1');
                }

                if (this.closest('#admin-sidebar') || rect.right > window.innerWidth - 60 || (rect.left + 160 > window.innerWidth)) {
                    this._menuEl.classList.remove('left-0');
                    this._menuEl.classList.add('right-0');
                } else {
                    this._menuEl.classList.remove('right-0');
                    this._menuEl.classList.add('left-0');
                }

                const blockCard = this.closest('[data-block-index]');
                if (blockCard) blockCard.style.zIndex = '60';

                this._isOpen = true;
                if (this._arrowEl) this._arrowEl.style.transform = 'rotate(180deg)';
            }
        }

        _close() {
            if (this._menuEl) {
                this._menuEl.classList.add('hidden');
                const blockCard = this.closest('[data-block-index]');
                if (blockCard) blockCard.style.zIndex = '';
                this._isOpen = false;
                if (this._arrowEl) this._arrowEl.style.transform = '';
            }
        }

        _onDocumentClick(e) {
            if (!this.contains(e.target)) {
                this._close();
            }
        }

        _onKeyDown(e) {
            if (e.key === 'Escape' && this._isOpen) {
                this._close();
            }
        }

        _updateUi() {
            if (!this._labelEl && !this._menuEl) return;
            const currentVal = this._value;
            const selectedOpt = this._options.find(function(o) { return o.value === currentVal; });
            if (selectedOpt && this._labelEl) {
                this._labelEl.textContent = selectedOpt.label;
            }
            if (this._menuEl) {

                const items = this._menuEl.querySelectorAll('.walnut-select-item');
                items.forEach(function(item) {
                    const itemVal = item.getAttribute('data-value');
                    const isSelected = itemVal === currentVal;
                    const check = item.querySelector('.material-symbols-outlined');
                    if (isSelected) {
                        item.classList.add('bg-slate-100', 'dark:bg-slate-800/80', 'text-emerald-600', 'dark:text-emerald-400', 'font-bold');
                        item.classList.remove('font-medium');
                        if (check) check.classList.remove('invisible');
                    } else {
                        item.classList.remove('bg-slate-100', 'dark:bg-slate-800/80', 'text-emerald-600', 'dark:text-emerald-400', 'font-bold');
                        item.classList.add('font-medium');
                        if (check) check.classList.add('invisible');
                    }
                });
            }
        }

        _fireChange() {
            const evt = new Event('change', { bubbles: true });
            this.dispatchEvent(evt);
            const inlineOnChange = this.getAttribute('onchange');
            if (inlineOnChange) {
                try {
                    new Function('event', inlineOnChange).call(this, evt);
                } catch (err) {
                    console.error('[WalnutSelect] onchange error:', err);
                }
            }
        }

        get options() {
            return this._options || [];
        }

        get selectedIndex() {
            return typeof this._selectedIndex === 'number' ? this._selectedIndex : 0;
        }

        set selectedIndex(idx) {
            if (this._options && this._options[idx]) {
                this._selectedIndex = idx;
                this.value = this._options[idx].value;
            }
        }

        get value() {
            if (this._hiddenInput) return this._hiddenInput.value;
            return this._value !== undefined ? this._value : (this.getAttribute('value') || '');
        }

        set value(val) {
            const strVal = String(val !== undefined && val !== null ? val : '');
            this._value = strVal;
            if (this._hiddenInput) this._hiddenInput.value = strVal;
            if (this._options && this._options.length > 0) {
                const idx = this._options.findIndex(function(o) { return String(o.value) === strVal; });
                if (idx >= 0) {
                    this._selectedIndex = idx;
                }
            }
            this._updateUi();
        }
    }

    if (!customElements.get('walnut-select')) {
        customElements.define('walnut-select', WalnutSelect);
    }

    class WalnutColorPicker extends HTMLElement {
        connectedCallback() {
            if (this._initialized) return;
            this._initialized = true;
            this._hexInput = this.querySelector('input[type="text"], input[data-role="hex-input"], input');
            this._swatch = this.querySelector('[data-role="swatch"], .color-swatch');
            this._trigger = this.querySelector('[data-role="trigger"]');
            const initial = this.getAttribute('value') !== null
                ? this.getAttribute('value')
                : (this._hexInput ? this._hexInput.value : '');
            this.value = initial;
            if (this._hexInput) {
                this._hexInput.addEventListener('input', () => {
                    if (this._swatch) {
                        this._swatch.style.backgroundColor = this._hexInput.value.trim() || '#2563eb';
                    }
                });
            }
            const openModal = () => {
                if (typeof window.openWebColorPickerModal === 'function' && this._hexInput && this._hexInput.id) {
                    window.openWebColorPickerModal(this._hexInput.id, this._swatch ? this._swatch.id : '');
                }
            };
            if (this._trigger) this._trigger.addEventListener('click', openModal);
            if (this._swatch) this._swatch.addEventListener('click', openModal);
        }

        get value() {
            return this._hexInput ? this._hexInput.value : (this.getAttribute('value') || '');
        }

        set value(val) {
            const str = String(val || '');
            if (this._hexInput) this._hexInput.value = str;
            if (this._swatch) this._swatch.style.backgroundColor = str.trim() || '#2563eb';
        }
    }

    if (!customElements.get('walnut-color-picker')) {
        customElements.define('walnut-color-picker', WalnutColorPicker);
    }

    class WalnutShortcutRecorder extends HTMLElement {
        connectedCallback() {
            if (this._initialized) return;
            this._initialized = true;

            this._input = this.querySelector('[data-role="shortcut-input"]');
            this._box = this.querySelector('[data-role="recorder-box"]');
            this._badgesContainer = this.querySelector('[data-role="badges-container"]');
            this._statusText = this.querySelector('[data-role="status-text"]');
            this._recordBtn = this.querySelector('[data-role="record-btn"]');
            this._addBtn = this.querySelector('[data-role="add-btn"]');
            this._resetBtn = this.querySelector('[data-role="reset-btn"]');

            this._defaultVal = this.getAttribute('data-default') || 'alt+k,cmd+k';
            this._recording = false;
            this._recordMode = 'replace';
            this._shortcuts = this._parseList(this._input ? this._input.value : this._defaultVal);

            this._boundKeyDown = this._onKeyDown.bind(this);
            this._boundKeyUp = this._onKeyUp.bind(this);
            this._boundOutsideClick = this._onOutsideClick.bind(this);

            const self = this;
            if (this._box) {
                this._box.addEventListener('click', function(e) {
                    if (e.target.closest('[data-remove-shortcut]')) return;
                    e.preventDefault();
                    if (!self._recording) {
                        self._startRecording('replace');
                    }
                });
            }

            if (this._recordBtn) {
                this._recordBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    if (self._recording && self._recordMode === 'replace') {
                        self._stopRecording();
                    } else {
                        self._startRecording('replace');
                    }
                });
            }

            if (this._addBtn) {
                this._addBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    if (self._recording && self._recordMode === 'append') {
                        self._stopRecording();
                    } else {
                        self._startRecording('append');
                    }
                });
            }

            if (this._resetBtn) {
                this._resetBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    self._stopRecording();
                    self._shortcuts = self._parseList(self._defaultVal);
                    self._syncValue();
                    self._render();
                    if (window.showToast) {
                        window.showToast(t('settings.shortcut_reset_toast'), 'success');
                    }
                });
            }

            this._render();
        }

        disconnectedCallback() {
            this._stopRecording();
        }

        _parseList(raw) {
            return String(raw || '')
                .split(',')
                .map(function(s) { return s.trim().toLowerCase(); })
                .filter(Boolean);
        }

        _syncValue() {
            const joined = this._shortcuts.join(',');
            if (this._input) {
                this._input.value = joined;
                this._input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            if (window.__WALNUT_RUNTIME__?.quickAction && typeof window.__WALNUT_RUNTIME__?.quickAction.updateShortcut === 'function') {
                window.__WALNUT_RUNTIME__?.quickAction.updateShortcut(joined);
            }
        }

        _formatKeyBadge(combo) {
            return combo
                .split('+')
                .map(function(p) {
                    const clean = p.trim().toLowerCase();
                    if (clean === 'cmd' || clean === 'meta') return '⌘ Cmd';
                    if (clean === 'alt' || clean === 'option') return '⌥ Alt';
                    if (clean === 'ctrl' || clean === 'control') return '⌃ Ctrl';
                    if (clean === 'shift') return '⇧ Shift';
                    return clean.toUpperCase();
                })
                .join(' + ');
        }

        _render() {
            if (!this._badgesContainer || !this._statusText) return;
            const self = this;
            this._badgesContainer.innerHTML = '';

            if (this._recording) {
                if (this._box) {
                    this._box.classList.add('ring-2', 'ring-emerald-500/40', 'border-emerald-500', 'bg-emerald-50/30', 'dark:bg-emerald-950/20');
                }
                if (this._recordBtn) {
                    this._recordBtn.textContent = this.getAttribute('data-recording-label') || t('settings.btn_recording_shortcut');
                    this._recordBtn.classList.remove('bg-emerald-600', 'hover:bg-emerald-500');
                    this._recordBtn.classList.add('bg-rose-600', 'hover:bg-rose-500', 'animate-pulse');
                }
                if (this._recordMode === 'append' && this._shortcuts.length > 0) {
                    this._shortcuts.forEach(function(sc) {
                        const chip = document.createElement('span');
                        chip.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-mono font-bold bg-slate-200/70 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-300 dark:border-slate-700';
                        chip.textContent = self._formatKeyBadge(sc);
                        self._badgesContainer.appendChild(chip);
                    });
                }
                this._statusText.className = 'text-xs font-mono font-bold text-emerald-600 dark:text-emerald-400 animate-pulse';
                this._statusText.textContent = this.getAttribute('data-recording-label') || t('settings.btn_recording_shortcut');
                return;
            }

            if (this._box) {
                this._box.classList.remove('ring-2', 'ring-emerald-500/40', 'border-emerald-500', 'bg-emerald-50/30', 'dark:bg-emerald-950/20');
            }
            if (this._recordBtn) {
                this._recordBtn.textContent = this.getAttribute('data-record-label') || t('settings.btn_record_shortcut');
                this._recordBtn.classList.remove('bg-rose-600', 'hover:bg-rose-500', 'animate-pulse');
                this._recordBtn.classList.add('bg-emerald-600', 'hover:bg-emerald-500');
            }

            if (this._shortcuts.length === 0) {
                this._statusText.className = 'text-xs font-mono text-slate-400 dark:text-slate-500';
                this._statusText.textContent = this.getAttribute('data-empty-hint') || t('settings.shortcut_empty_hint');
                return;
            }

            this._statusText.textContent = '';
            this._shortcuts.forEach(function(sc, idx) {
                const badge = document.createElement('span');
                badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-white dark:bg-slate-800 text-slate-800 dark:text-emerald-300 border border-slate-300 dark:border-slate-700 shadow-2xs';

                const labelSpan = document.createElement('span');
                labelSpan.textContent = self._formatKeyBadge(sc);
                badge.appendChild(labelSpan);

                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.setAttribute('data-remove-shortcut', String(idx));
                removeBtn.className = 'text-slate-400 hover:text-rose-500 dark:hover:text-rose-400 transition cursor-pointer leading-none ml-0.5';
                removeBtn.textContent = '×';
                removeBtn.addEventListener('click', function(ev) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    self._shortcuts.splice(idx, 1);
                    if (self._shortcuts.length === 0) {
                        self._shortcuts = self._parseList(self._defaultVal);
                    }
                    self._syncValue();
                    self._render();
                });

                badge.appendChild(removeBtn);
                self._badgesContainer.appendChild(badge);
            });
        }

        _startRecording(mode) {
            this._recording = true;
            this._recordMode = mode || 'replace';
            (window.__WALNUT_RUNTIME__ = window.__WALNUT_RUNTIME__ || {}).recordingShortcut = true;
            this._render();
            if (this._box) this._box.focus();
            window.addEventListener('keydown', this._boundKeyDown, true);
            window.addEventListener('keyup', this._boundKeyUp, true);
            document.addEventListener('mousedown', this._boundOutsideClick, true);
        }

        _stopRecording() {
            if (!this._recording) return;
            this._recording = false;
            (window.__WALNUT_RUNTIME__ = window.__WALNUT_RUNTIME__ || {}).recordingShortcut = false;
            window.removeEventListener('keydown', this._boundKeyDown, true);
            window.removeEventListener('keyup', this._boundKeyUp, true);
            document.removeEventListener('mousedown', this._boundOutsideClick, true);
            this._render();
        }

        _onOutsideClick(e) {
            if (!this.contains(e.target)) {
                this._stopRecording();
            }
        }

        _normalizeKey(e) {
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

        _onKeyDown(e) {
            if (!this._recording) return;
            e.preventDefault();
            e.stopPropagation();

            if (e.key === 'Escape') {
                this._stopRecording();
                return;
            }

            const mods = [];
            if (e.ctrlKey) mods.push('ctrl');
            if (e.altKey) mods.push('alt');
            if (e.shiftKey) mods.push('shift');
            if (e.metaKey) mods.push('cmd');

            const isModifierOnly = ['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(e.key) ||
                /^(Control|Alt|Shift|Meta|OS)/.test(e.code || '');

            if (isModifierOnly) {
                if (this._statusText && mods.length > 0) {
                    this._statusText.textContent = this._formatKeyBadge(mods.join('+')) + ' + ...';
                }
                return;
            }

            const mainKey = this._normalizeKey(e);
            if (!mainKey) return;

            const isFunctionKey = /^f([1-9]|1[0-2])$/.test(mainKey);
            if (mods.length === 0 && !isFunctionKey) {
                if (window.showToast) {
                    window.showToast(t('settings.shortcut_need_modifier_warn'), 'warning');
                }
                return;
            }

            const combo = mods.concat([mainKey]).join('+');
            if (this._recordMode === 'append') {
                if (!this._shortcuts.includes(combo)) {
                    this._shortcuts.push(combo);
                }
            } else {
                this._shortcuts = [combo];
            }

            this._syncValue();
            this._stopRecording();

            if (window.showToast) {
                window.showToast(t('settings.shortcut_recorded_toast', { shortcut: this._formatKeyBadge(combo) }), 'success');
            }
        }

        _onKeyUp(e) {
            if (!this._recording) return;
            e.preventDefault();
            e.stopPropagation();
            const mods = [];
            if (e.ctrlKey) mods.push('ctrl');
            if (e.altKey) mods.push('alt');
            if (e.shiftKey) mods.push('shift');
            if (e.metaKey) mods.push('cmd');
            if (this._statusText) {
                if (mods.length > 0) {
                    this._statusText.textContent = this._formatKeyBadge(mods.join('+')) + ' + ...';
                } else {
                    this._statusText.textContent = this.getAttribute('data-recording-label') || t('settings.btn_recording_shortcut');
                }
            }
        }
    }

    if (!customElements.get('walnut-shortcut-recorder')) {
        customElements.define('walnut-shortcut-recorder', WalnutShortcutRecorder);
    }

    const CSRF_TOKEN = 'walnut-admin-csrf-valid-token';

    const originalFetch = window.fetch;
    window.fetch = function(url, options) {
        options = options || {};
        options.headers = options.headers || {};
        if (options.method && options.method.toUpperCase() !== 'GET' && options.method.toUpperCase() !== 'HEAD') {
            if (options.headers instanceof Headers) {
                if (!options.headers.has('X-Admin-CSRF-Token')) {
                    options.headers.set('X-Admin-CSRF-Token', CSRF_TOKEN);
                }
            } else if (Array.isArray(options.headers)) {
                options.headers.push(['X-Admin-CSRF-Token', CSRF_TOKEN]);
            } else {
                options.headers['X-Admin-CSRF-Token'] = CSRF_TOKEN;
            }
        }
        return originalFetch.call(this, url, options);
    };

    window.$ = function(selector) { return document.querySelector(selector); };
    window.$$ = function(selector) { return document.querySelectorAll(selector); };
    window.alert = function(msg) { if (window.showToast) window.showToast(msg, 'info'); };

    window.showToast = function(msg, type) {
        type = type || 'success';
        const container = document.getElementById('global-toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        let colorClasses = 'bg-slate-900 text-white border-slate-700';
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

        const cleanup = function () {
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

    document.addEventListener('htmx:configRequest', function(evt) {
        if (evt.detail && evt.detail.headers) {
            evt.detail.headers['X-Admin-CSRF-Token'] = CSRF_TOKEN;
        }
    });

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

    window.toggleAdminSidebar = function() {
        const sidebar = document.getElementById('admin-sidebar');
        if (!sidebar) return;
        const isNowCollapsed = !sidebar.classList.contains('sidebar-collapsed');
        window.setSidebarCollapse(isNowCollapsed);
        try {
            localStorage.setItem('walnut_sidebar_collapsed', isNowCollapsed ? 'true' : 'false');
        } catch(e) {}
    };

    function initSidebar() {
        const sidebar = document.getElementById('admin-sidebar');
        if (!sidebar) return;
        const cachedCollapsed = localStorage.getItem('walnut_sidebar_collapsed');
        const shouldCollapse = cachedCollapsed !== null ? cachedCollapsed === 'true' : (window.innerWidth < 768);
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
    window.addEventListener('resize', function() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function() {
            const sidebar = document.getElementById('admin-sidebar');
            if (window.innerWidth < 768 && sidebar && !sidebar.classList.contains('sidebar-collapsed')) {
                setSidebarCollapse(true);
            }
        }, 150);
    });

    window.filterByFolder = function(tableId, folderName, chipContainerId) {
        const table = document.getElementById(tableId);
        if (!table) return;
        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll('tr:not(.table-empty-row)'));
        const f = (folderName || '').trim().toLowerCase();

        rows.forEach(function(row) {
            const rowFolder = (row.getAttribute('data-folder') || '').trim().toLowerCase();
            if (!f || f === 'all' || rowFolder === f) {
                row.style.display = '';
            } else {
                row.style.display = 'none';
            }
        });

        if (chipContainerId) {
            const container = document.getElementById(chipContainerId);
            if (container) {
                const chips = container.querySelectorAll('.folder-chip');
                chips.forEach(function(c) {
                    const cFolder = (c.getAttribute('data-folder') || '').trim().toLowerCase();
                    if ((!f && cFolder === 'all') || cFolder === f) {
                        c.className = 'folder-chip px-3 py-1 rounded-xl text-xs font-bold bg-slate-900 text-white dark:bg-emerald-600 dark:text-white shadow-sm transition cursor-pointer flex items-center space-x-1';
                    } else {
                        c.className = 'folder-chip px-3 py-1 rounded-xl text-xs font-semibold bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 transition cursor-pointer flex items-center space-x-1';
                    }
                });
            }
        }
    };

    const activeColMultiFilters = {};

    window.toggleColumnHeaderFilter = function(e, tableId, colName) {
        e.stopPropagation();
        const existing = document.getElementById('col-filter-popover');
        if (existing) {
            const prevCol = existing.getAttribute('data-current-col');
            const prevTable = existing.getAttribute('data-current-table');
            existing.remove();
            if (prevCol === colName && prevTable === tableId) return;
        }

        const btn = e.currentTarget;
        const rect = btn.getBoundingClientRect();
        const table = document.getElementById(tableId);
        const filterKey = tableId + ':' + colName;
        const selectedSet = new Set(activeColMultiFilters[filterKey] || []);

        const valueCounts = new Map();
        if (table) {
            table.querySelectorAll('tbody tr:not(.table-empty-row)').forEach(function(row) {
                const cell = row.querySelector('[data-col="' + colName + '"]');
                const raw = ((cell ? cell.textContent : '') || '').replace(/\s+/g, ' ').trim();
                if (raw && raw !== '-') {
                    valueCounts.set(raw, (valueCounts.get(raw) || 0) + 1);
                }
            });
        }
        const sortedValues = Array.from(valueCounts.entries()).sort(function(a, b) {
            return b[1] - a[1] || a[0].localeCompare(b[0]);
        });

        const popover = document.createElement('div');
        popover.id = 'col-filter-popover';
        popover.setAttribute('data-current-col', colName);
        popover.setAttribute('data-current-table', tableId);
        popover.className = 'fixed z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl p-2.5 space-y-2 text-xs w-60';
        popover.style.left = Math.min(window.innerWidth - 250, Math.max(10, rect.left - 80)) + 'px';
        popover.style.top = (rect.bottom + 6) + 'px';

        const optionsHtml = sortedValues.length === 0
            ? ''
            : `<div id="col-filter-options" class="max-h-44 overflow-y-auto thin-scrollbar space-y-0.5 border-t border-b border-slate-100 dark:border-slate-700/70 py-1.5">
                ${sortedValues.map(function(entry) {
                    const val = entry[0];
                    const cnt = entry[1];
                    const escVal = val.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
                    const checked = selectedSet.has(val) ? 'checked' : '';
                    return `<label class="col-filter-opt flex items-center justify-between gap-2 px-1.5 py-1 rounded hover:bg-slate-50 dark:hover:bg-slate-700/60 cursor-pointer" data-val="${escVal}">
                        <span class="flex items-center space-x-1.5 min-w-0">
                            <input type="checkbox" class="col-filter-cb rounded text-emerald-600 focus:ring-0 shrink-0" value="${escVal}" ${checked} />
                            <span class="truncate text-[11px] text-slate-700 dark:text-slate-200" title="${escVal}">${escVal}</span>
                        </span>
                        <span class="text-[10px] font-mono text-slate-400 shrink-0">${cnt}</span>
                    </label>`;
                }).join('')}
            </div>`;

        popover.innerHTML = `
            <div class="flex items-center justify-between pb-1.5 border-b border-slate-100 dark:border-slate-700">
                <span class="font-bold text-slate-700 dark:text-slate-200 text-[11px] flex items-center space-x-1">
                    <span class="material-symbols-outlined text-[13px] text-emerald-500">filter_alt</span>
                    <span>${t('common.filter')}: ${colName}</span>
                </span>
                <button type="button" class="text-slate-400 hover:text-slate-600 dark:hover:text-white cursor-pointer" onclick="document.getElementById('col-filter-popover')?.remove()">
                    <span class="material-symbols-outlined text-[14px]">close</span>
                </button>
            </div>
            <input type="text" id="col-filter-input" placeholder="${t('common.search_placeholder')}" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 text-xs outline-none focus:border-emerald-500" />
            ${optionsHtml}
            <div class="flex justify-between items-center pt-0.5">
                <button type="button" class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-[10px] cursor-pointer" id="col-filter-reset-btn">${t('common.clear')}</button>
                <button type="button" class="bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-0.5 rounded text-[11px] font-bold cursor-pointer" id="col-filter-apply-btn">${t('common.filter')}</button>
            </div>
        `;

        document.body.appendChild(popover);

        const getCheckedValues = function() {
            return Array.from(popover.querySelectorAll('.col-filter-cb:checked')).map(function(cb) { return cb.value; });
        };

        const input = document.getElementById('col-filter-input');
        if (input) {
            input.focus();
            input.addEventListener('input', function() {
                const q = input.value.trim().toLowerCase();
                popover.querySelectorAll('.col-filter-opt').forEach(function(opt) {
                    const v = (opt.getAttribute('data-val') || '').toLowerCase();
                    opt.style.display = (!q || v.indexOf(q) !== -1) ? '' : 'none';
                });
            });
            input.addEventListener('keydown', function(evt) {
                if (evt.key === 'Enter') {
                    const checked = getCheckedValues();
                    activeColMultiFilters[filterKey] = checked;
                    applyColFilter(tableId, colName, input.value, checked);
                    popover.remove();
                }
            });
        }

        popover.querySelectorAll('.col-filter-cb').forEach(function(cb) {
            cb.addEventListener('change', function() {
                const checked = getCheckedValues();
                activeColMultiFilters[filterKey] = checked;
                applyColFilter(tableId, colName, input ? input.value : '', checked);
            });
        });

        document.getElementById('col-filter-apply-btn')?.addEventListener('click', function() {
            const checked = getCheckedValues();
            activeColMultiFilters[filterKey] = checked;
            applyColFilter(tableId, colName, input ? input.value : '', checked);
            popover.remove();
        });

        document.getElementById('col-filter-reset-btn')?.addEventListener('click', function() {
            activeColMultiFilters[filterKey] = [];
            applyColFilter(tableId, colName, '', []);
            popover.remove();
        });

        function onDocClick(evt) {
            if (!popover.contains(evt.target) && evt.target !== btn && !btn.contains(evt.target)) {
                popover.remove();
                document.removeEventListener('click', onDocClick);
            }
        }
        setTimeout(function() {
            document.addEventListener('click', onDocClick);
        }, 10);
    };

    function applyColFilter(tableId, colName, filterVal, checkedList) {
        const table = document.getElementById(tableId);
        if (!table) return;
        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll('tr:not(.table-empty-row)'));
        const f = (filterVal || '').trim().toLowerCase();
        const checkedSet = new Set(Array.isArray(checkedList) ? checkedList : (activeColMultiFilters[tableId + ':' + colName] || []));

        rows.forEach(function(row) {
            const cell = row.querySelector('[data-col="' + colName + '"]');
            const rawText = ((cell ? cell.textContent : row.textContent) || '').replace(/\s+/g, ' ').trim();
            const matchText = !f || rawText.toLowerCase().indexOf(f) !== -1;
            const matchChecked = checkedSet.size === 0 || checkedSet.has(rawText);
            row.style.display = (matchText && matchChecked) ? '' : 'none';
        });

        const colBtn = table.querySelector('th[data-col="' + colName + '"] .col-filter-btn');
        if (colBtn) {
            if (f || checkedSet.size > 0) {
                colBtn.classList.add('text-emerald-500');
            } else {
                colBtn.classList.remove('text-emerald-500');
            }
        }
    }

    window.toggleTransGroupSection = function(groupId) {
        const rows = document.querySelectorAll('.tg-subrow-' + groupId);
        const arrow = document.getElementById('tg-arrow-' + groupId);
        if (!rows || rows.length === 0) return;
        let anyVisible = false;
        rows.forEach(function(r) {
            if (!r.classList.contains('hidden') && r.style.display !== 'none') anyVisible = true;
        });
        const shouldHide = anyVisible;
        rows.forEach(function(r) {
            if (shouldHide) {
                r.classList.add('hidden');
            } else {
                r.classList.remove('hidden');
                r.style.display = '';
            }
        });
        if (arrow) {
            arrow.style.transform = shouldHide ? 'rotate(-90deg)' : 'rotate(0deg)';
        }
    };

    window.filterTableRows = function(tableId, query, countBadgeId, emptyStateId) {
        const table = document.getElementById(tableId);
        if (!table) return;
        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll('tr:not(.table-empty-row)'));
        const q = (query || '').trim().toLowerCase();
        let matchCount = 0;

        rows.forEach(function(row) {
            const text = (row.textContent || '').toLowerCase();
            const isMatch = !q || text.indexOf(q) !== -1;
            if (isMatch) {
                row.style.display = '';
                matchCount++;
            } else {
                row.style.display = 'none';
            }
        });

        const badge = document.getElementById(countBadgeId);
        if (badge) {
            badge.innerText = q ? t('common.matching_records', { count: matchCount }) : t('common.total_records', { count: rows.length });
        }

        const emptyEl = document.getElementById(emptyStateId);
        if (emptyEl) {
            if (matchCount === 0 && rows.length > 0) {
                emptyEl.classList.remove('hidden');
            } else {
                emptyEl.classList.add('hidden');
            }
        }
    };

    window.filterCardItems = function(containerId, itemSelector, query, countBadgeId, emptyStateId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const items = Array.from(container.querySelectorAll(itemSelector));
        const q = (query || '').trim().toLowerCase();
        let matchCount = 0;

        items.forEach(function(item) {
            const text = (item.textContent || '').toLowerCase();
            const isMatch = !q || text.indexOf(q) !== -1;
            if (isMatch) {
                item.style.display = '';
                matchCount++;
            } else {
                item.style.display = 'none';
            }
        });

        const badge = document.getElementById(countBadgeId);
        if (badge) {
            badge.innerText = q ? t('common.matching_records', { count: matchCount }) : t('common.total_records', { count: items.length });
        }

        const emptyEl = document.getElementById(emptyStateId);
        if (emptyEl) {
            if (matchCount === 0 && items.length > 0) {
                emptyEl.classList.remove('hidden');
            } else {
                emptyEl.classList.add('hidden');
            }
        }
    };

    const DEFAULT_COLS_REGISTRY = {
        articles: {
            folder: true,
            'trans-group': false,
            trans_group: false,
            slug: false,
            version: false,
            created: false,
            locale: true,
            tags: false,
            maturity: false,
            status: true,
            updated: true,
            actions: true
        },
        pages: {folder: false, template: true, page_type: false, batch_id: false, version: false, locale: true, status: true, updated: true, actions: true},
        users: {folder: true, email: true, 'global-role': true, 'site-role': true, created: true, actions: true},
        logs: {action: true, user: true, details: true, status: true, ip: true, created: true, actions: true},
        tasks: {type: true, folder: true, interval: true, next_run: true, last_run: true, status: true, actions: true},
        micro: {title: true, folder: true, status: false, maturity: true, locale: false, tags: true, created: false, updated: true, actions: true},
        datasets: {collection: true, schema: true, items_count: true, schema_slug: false, ref_pages: false, created: false, updated: true, actions: true}
    };


    window.toggleColumnPickerMenu = function(tableId, storageKey) {
        const key = storageKey || (tableId ? tableId.replace(/-table$/, '') : 'articles');
        const menu = document.getElementById('column-picker-menu-' + key)
            || document.getElementById(key + '-column-picker-dropdown')
            || document.getElementById('column-picker-dropdown');
        if (menu) menu.classList.toggle('hidden');
    };

    window.toggleTableColumn = function(tableIdOrColName, colNameOrVisible, visibleOrKey, storageKey) {
        let tableId = null;
        let colName;
        let visible = true;
        let key;

        if (typeof visibleOrKey === 'boolean') {
            tableId = tableIdOrColName;
            colName = colNameOrVisible;
            visible = visibleOrKey;
            key = storageKey || (tableId ? tableId.replace(/-table$/, '') : 'articles');
        } else {
            colName = tableIdOrColName;
            visible = !!colNameOrVisible;
            key = (typeof visibleOrKey === 'string' ? visibleOrKey : 'articles');
        }

        if (!colName) return;

        const selector = tableId ? ('#' + tableId + ' [data-col="' + colName + '"]') : ('[data-col="' + colName + '"]');
        let elements = document.querySelectorAll(selector);
        if (elements.length === 0) {
            elements = document.querySelectorAll('[data-col="' + colName + '"]');
        }
        elements.forEach(function(el) {
            if (visible) el.classList.remove('hidden');
            else el.classList.add('hidden');
        });

        const cbSelector = 'input[type="checkbox"].col-toggle-' + colName + ', ' +
            'input[type="checkbox"][data-col="' + colName + '"]';
        document.querySelectorAll(cbSelector).forEach(function(cb) {
            cb.checked = visible;
        });

        try {
            const storeKey = 'walnut_' + key + '_cols_v2';
            const current = JSON.parse(localStorage.getItem(storeKey) || '{}');
            current[colName] = visible;
            if (colName === 'trans-group') current['trans_group'] = visible;
            if (colName === 'trans_group') current['trans-group'] = visible;
            localStorage.setItem(storeKey, JSON.stringify(current));
        } catch (e) {}
    };

    window.initTableColumns = function(tableId, storageKey, defaultCols) {
        const key = storageKey || (tableId ? tableId.replace(/-table$/, '') : 'articles');
        const defaults = defaultCols || DEFAULT_COLS_REGISTRY[key] || {};
        const storeKey = 'walnut_' + key + '_cols_v2';
        const cols = Object.assign({}, defaults);

        try {
            const saved = localStorage.getItem(storeKey);
            if (saved) {
                const parsed = JSON.parse(saved);
                Object.assign(cols, parsed);
            }
        } catch (e) {}

        Object.keys(cols).forEach(function(colName) {
            const isVisible = cols[colName];

            const cbSelector = '#column-picker-menu-' + key + ' .col-toggle-' + colName + ', ' +
                '#' + key + '-column-picker-dropdown [data-col="' + colName + '"], ' +
                '#' + key + '-column-picker-wrapper input[data-col="' + colName + '"], ' +
                '.col-toggle-checkbox[data-col="' + colName + '"], ' +
                '.' + key + '-col-toggle-checkbox[data-col="' + colName + '"], ' +
                'input[type="checkbox"].col-toggle-' + colName;
            document.querySelectorAll(cbSelector).forEach(function(cb) {
                cb.checked = isVisible;
            });

            const cellSelector = tableId ? ('#' + tableId + ' [data-col="' + colName + '"]') : ('[data-col="' + colName + '"]');
            const elements = document.querySelectorAll(cellSelector);
            elements.forEach(function(el) {
                if (isVisible) el.classList.remove('hidden');
                else el.classList.add('hidden');
            });
        });
    };

    window.toggleColumnPicker = function() { window.toggleColumnPickerMenu('articles-table', 'articles'); };
    function initArticleColumns() { window.initTableColumns('articles-table', 'articles', DEFAULT_COLS_REGISTRY.articles); }

    window.updateArticleBatchState = function() {
        const checked = Array.from(document.querySelectorAll('.article-checkbox:checked, .row-select-box:checked'));
        const toolbar = document.getElementById('articles-batch-toolbar');
        const badge = document.getElementById('articles-selected-badge');
        if (checked.length > 0) {
            if (toolbar) toolbar.classList.remove('hidden');
            if (badge) badge.innerText = t('common.selected_count', { count: checked.length });
        } else {
            if (toolbar) toolbar.classList.add('hidden');
        }
    };

    window.toggleAllArticles = function(checked) {
        document.querySelectorAll('.article-checkbox, .row-select-box').forEach(function(cb) { cb.checked = checked; });
        window.updateArticleBatchState();
    };

    window.selectAllArticles = function() { window.toggleAllArticles(true); };
    window.deselectAllArticles = function() { window.toggleAllArticles(false); };

    window.batchTrashSelected = function() {
        const checked = Array.from(document.querySelectorAll('.article-checkbox:checked, .row-select-box:checked'));
        if (checked.length === 0) return;

        window.showConfirmDialog({
            title: t('articles.btn_trash'),
            message: t('articles.confirm_batch_delete', { count: checked.length }),
            icon: 'delete',
            onConfirm: async function() {
                const nodeIds = checked.map(function (cb) {
                    return cb.getAttribute('data-id');
                }).filter(Boolean);
                for (let i = 0; i < nodeIds.length; i += 10) {
                    const fd = new FormData();
                    fd.append('node_ids', JSON.stringify(nodeIds.slice(i, i + 10)));
                    const res = await fetch('/admin/articles/api/batch-soft-delete', { method: 'POST', body: fd });
                    if (!res.ok) {
                        if (window.showToast) window.showToast(t('common.error'), 'error');
                        return;
                    }
                }
                window.location.reload();
            }
        });
    };

    window.promptCreateFolder = function(pageType, chipsContainerId, tableId) {
        const container = document.getElementById(chipsContainerId || (pageType + '-folder-chips'));
        const targetTable = tableId || (pageType === 'micro' ? 'micro-table' : (pageType + '-table'));

        const existingModal = document.getElementById('common-create-folder-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'common-create-folder-modal';
        modal.className = 'fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4';
        modal.innerHTML = `
            <div class="bg-white dark:bg-slate-800 rounded-2xl max-w-sm w-full p-5 shadow-2xl border border-slate-200 dark:border-slate-700 space-y-4">
                <div class="flex justify-between items-center border-b border-slate-100 dark:border-slate-700 pb-2">
                    <h3 class="text-sm font-bold text-slate-900 dark:text-white flex items-center space-x-1.5">
                        <span class="material-symbols-outlined text-emerald-600 text-[18px]">create_new_folder</span>
                        <span>${t('articles.title_new_folder')}</span>
                    </h3>
                    <button type="button" onclick="document.getElementById('common-create-folder-modal').remove()" class="text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">
                        <span class="material-symbols-outlined text-[18px]">close</span>
                    </button>
                </div>
                <div>
                    <label class="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">${t('common.prompt_create_folder')} *</label>
                    <input type="text" id="new-folder-input-val" placeholder="guides, daily, dev" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs font-mono text-slate-800 dark:text-slate-100 outline-none focus:border-slate-900 dark:focus:border-emerald-500" />
                </div>
                <div class="flex justify-end space-x-2 pt-2 border-t border-slate-100 dark:border-slate-700">
                    <button type="button" onclick="document.getElementById('common-create-folder-modal').remove()" class="px-3.5 py-1.5 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer">${t('common.cancel')}</button>
                    <button type="button" id="confirm-create-folder-btn" class="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 rounded-xl text-xs font-bold shadow-sm cursor-pointer">${t('common.confirm')}</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const input = document.getElementById('new-folder-input-val');
        if (input) input.focus();

        document.getElementById('confirm-create-folder-btn').onclick = function() {
            const val = (input.value || '').trim();
            if (!val) {
                if (window.showToast) window.showToast(t('common.prompt_create_folder'), 'warning');
                return;
            }
            modal.remove();

            if (container) {
                const existingBtn = container.querySelector('[data-folder="' + val + '"]');
                if (!existingBtn) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'folder-chip px-3 py-1 rounded-xl text-xs font-semibold bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 transition cursor-pointer flex items-center space-x-1';
                    btn.setAttribute('data-folder', val);
                    btn.onclick = function() {
                        window.filterByFolder(targetTable, val, container.id);
                    };
                    btn.innerHTML = '<span class="material-symbols-outlined text-[14px] text-amber-500">folder</span><span>' + val + '</span>';
                    container.appendChild(btn);
                }
                window.filterByFolder(targetTable, val, container.id);
            }

            if (window.showToast) window.showToast(t('common.success'), 'success');
        };
    };

    window.updateTableBatchState = function(tableId, toolbarId, badgeId, checkboxClass) {
        const tb = document.getElementById(tableId);
        if (!tb) return;
        const cls = checkboxClass || 'row-select-box';
        const checked = Array.from(tb.querySelectorAll('.' + cls + ':checked'));
        const toolbar = document.getElementById(toolbarId || (tableId.replace('-table', '') + '-batch-toolbar'));
        const badge = document.getElementById(badgeId || (tableId.replace('-table', '') + '-selected-badge'));
        if (checked.length > 0) {
            if (toolbar) toolbar.classList.remove('hidden');
            if (badge) badge.innerText = t('common.selected_count', { count: checked.length });
        } else {
            if (toolbar) toolbar.classList.add('hidden');
        }
    };

    window.toggleAllTableRows = function(tableId, checked, checkboxClass) {
        const tb = document.getElementById(tableId);
        if (!tb) return;
        const cls = checkboxClass || 'row-select-box';
        tb.querySelectorAll('.' + cls).forEach(function(cb) { cb.checked = checked; });
        window.updateTableBatchState(tableId);
    };

    window.selectAllTableRows = function(tableId) { window.toggleAllTableRows(tableId, true); };
    window.deselectAllTableRows = function(tableId) { window.toggleAllTableRows(tableId, false); };

    window.batchDeleteSelected = function(tableId, deleteUrl, entityName, checkboxClass) {
        const tb = document.getElementById(tableId);
        if (!tb) return;
        const cls = checkboxClass || 'row-select-box';
        const checked = Array.from(tb.querySelectorAll('.' + cls + ':checked'));
        if (checked.length === 0) return;

        const name = entityName || t('common.record_unit');
        window.showConfirmDialog({
            title: t('common.confirm_delete_title'),
            message: t('common.confirm_batch_delete_msg', { count: checked.length, name: name }),
            icon: 'delete',
            onConfirm: async function() {
                const ids = checked.map(function (cb) {
                    return cb.getAttribute('data-id');
                }).filter(Boolean);
                const targetUrl = deleteUrl || '/admin/articles/api/batch-soft-delete';
                let chunkSize = 10;
                let offset = 0;
                while (offset < ids.length) {
                    const chunk = ids.slice(offset, offset + chunkSize);
                    if (window.showToast && ids.length > chunkSize) {
                        window.showToast(t('common.loading') + ' ' + Math.min(offset + chunk.length, ids.length) + ' / ' + ids.length, 'info');
                    }
                    try {
                        const res = await fetch(targetUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-Admin-CSRF-Token': 'walnut-admin-csrf-valid-token'
                            },
                            body: JSON.stringify({
                                ids: chunk,
                                node_ids: chunk,
                                user_ids: chunk
                            })
                        });
                        const text = await res.clone().text();
                        if (isCpuLimitResponse(res.status, text) && chunkSize > 1) {
                            chunkSize = Math.max(1, Math.floor(chunkSize / 2));
                            await new Promise(function(r) { setTimeout(r, 500); });
                            continue;
                        }
                        offset += chunk.length;
                    } catch (e) {
                        const fd = new FormData();
                        fd.append('node_ids', JSON.stringify(chunk));
                        fd.append('ids', JSON.stringify(chunk));
                        fd.append('user_ids', JSON.stringify(chunk));
                        await fetch(targetUrl, { method: 'POST', body: fd });
                        offset += chunk.length;
                    }
                }
                window.location.reload();
            }
        });
    };

    window.batchMoveToFolder = function(tableId, moveUrl, pageType, checkboxClass) {
        const tb = document.getElementById(tableId);
        if (!tb) return;
        const cls = checkboxClass || 'row-select-box';
        const checked = Array.from(tb.querySelectorAll('.' + cls + ':checked'));
        if (checked.length === 0) return;

        const chipsId = pageType ? (pageType + '-folder-chips') : (tableId.replace('-table', '') + '-folder-chips');
        const container = document.getElementById(chipsId);
        const existingFolders = [];
        if (container) {
            container.querySelectorAll('.folder-chip').forEach(function(el) {
                const f = el.getAttribute('data-folder');
                if (f && f !== 'all' && !existingFolders.includes(f)) existingFolders.push(f);
            });
        }

        const existingModal = document.getElementById('common-batch-folder-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'common-batch-folder-modal';
        modal.className = 'fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4';
        modal.innerHTML = `
            <div class="bg-white dark:bg-slate-800 rounded-2xl max-w-sm w-full p-5 shadow-2xl border border-slate-200 dark:border-slate-700 space-y-4">
                <div class="flex justify-between items-center border-b border-slate-100 dark:border-slate-700 pb-2">
                    <h3 class="text-sm font-bold text-slate-900 dark:text-white flex items-center space-x-1.5">
                        <span class="material-symbols-outlined text-amber-500 text-[18px]">folder</span>
                        <span>${t('common.batch_move_folder')} (<span class="text-emerald-500">${checked.length}</span>)</span>
                    </h3>
                    <button type="button" onclick="document.getElementById('common-batch-folder-modal').remove()" class="text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">
                        <span class="material-symbols-outlined text-[18px]">close</span>
                    </button>
                </div>
                <div class="space-y-3">
                    <div>
                        <label class="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">${t('common.folder_select_existing')}</label>
                        <div class="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                            ${existingFolders.map(function(f) {
                                return '<button type="button" class="folder-select-opt px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-emerald-600 hover:text-white transition cursor-pointer" data-val="' + f + '">' + f + '</button>';
                            }).join('')}
                        </div>
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">${t('common.folder_or_input_new')}</label>
                        <input type="text" id="batch-folder-target-input" placeholder="${t('common.folder_input_placeholder')}" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs font-mono text-slate-800 dark:text-slate-100 outline-none focus:border-slate-900 dark:focus:border-emerald-500" />
                    </div>
                </div>
                <div class="flex justify-end space-x-2 pt-2 border-t border-slate-100 dark:border-slate-700">
                    <button type="button" onclick="document.getElementById('common-batch-folder-modal').remove()" class="px-3.5 py-1.5 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer">${t('common.cancel')}</button>
                    <button type="button" id="confirm-batch-folder-btn" class="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 rounded-xl text-xs font-bold shadow-sm cursor-pointer">${t('common.btn_confirm_move')}</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelectorAll('.folder-select-opt').forEach(function(btn) {
            btn.onclick = function() {
                const inp = document.getElementById('batch-folder-target-input');
                if (inp) inp.value = btn.getAttribute('data-val');
            };
        });

        document.getElementById('confirm-batch-folder-btn').onclick = async function() {
            const inp = document.getElementById('batch-folder-target-input');
            const targetFolder = (inp ? inp.value : '').trim() || '/';
            const ids = checked.map(function (cb) {
                return cb.getAttribute('data-id');
            }).filter(Boolean);

            const CHUNK_SIZE = 10;
            let allOk = true;
            for (let offset = 0; offset < ids.length; offset += CHUNK_SIZE) {
                const chunk = ids.slice(offset, offset + CHUNK_SIZE);
                if (window.showToast && ids.length > CHUNK_SIZE) {
                    window.showToast(t('common.loading') + ' ' + Math.min(offset + chunk.length, ids.length) + ' / ' + ids.length, 'info');
                }
                const fd = new FormData();
                fd.append('node_ids', JSON.stringify(chunk));
                fd.append('user_ids', JSON.stringify(chunk));
                fd.append('folder', targetFolder);

                const res = await fetch(moveUrl || '/admin/articles/api/batch-folder', {method: 'POST', body: fd});
                if (!res.ok) {
                    allOk = false;
                    break;
                }
            }
            if (allOk) {
                modal.remove();
                if (window.showToast) window.showToast(t('common.batch_folder_moved', { count: ids.length, folder: targetFolder }), 'success');
                setTimeout(function() { window.location.reload(); }, 300);
            } else {
                if (window.showToast) window.showToast(t('common.batch_folder_failed'), 'error');
            }
        };
    };

    window.openNewMicroModal = function() {
        const existing = document.getElementById('new-micro-modal');
        if (existing) { existing.classList.remove('hidden'); return; }

        const modal = document.createElement('div');
        modal.id = 'new-micro-modal';
        modal.className = 'fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4';
        modal.innerHTML = `
            <div class="bg-white dark:bg-slate-800 rounded-3xl max-w-lg w-full p-6 shadow-2xl border border-slate-200 dark:border-slate-700 space-y-4">
                <div class="flex justify-between items-center border-b border-slate-100 dark:border-slate-700 pb-3">
                    <h3 class="text-sm font-bold text-slate-900 dark:text-white flex items-center space-x-1.5">
                        <span class="material-symbols-outlined text-emerald-600 text-[18px]">edit_note</span>
                        <span>${t('micro.btn_new_node') || t('garden.btn_new_node')}</span>
                    </h3>
                    <button type="button" onclick="document.getElementById('new-micro-modal').classList.add('hidden')" class="text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">
                        <span class="material-symbols-outlined text-[18px]">close</span>
                    </button>
                </div>
                <div class="space-y-3 text-xs">
                    <div class="bg-emerald-50 dark:bg-emerald-950/50 p-2.5 rounded-xl border border-emerald-200 dark:border-emerald-800/60 text-[11px] text-emerald-800 dark:text-emerald-300">
                        ${t('micro.modal_tip') || t('garden.modal_tip')}
                    </div>
                    <div>
                        <label class="block font-bold text-slate-700 dark:text-slate-300 mb-1">${t('micro.field_title_opt') || t('garden.field_title_opt')}</label>
                        <input type="text" id="micro-title-input" placeholder="${t('micro.placeholder_title') || t('garden.placeholder_title')}" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-800 dark:text-slate-100 outline-none focus:border-slate-900 dark:focus:border-emerald-500" />
                    </div>
                    <div>
                        <label class="block font-bold text-slate-700 dark:text-slate-300 mb-1">${t('micro.field_content_opt') || t('garden.field_content_opt')}</label>
                        <textarea id="micro-raw-input" rows="4" placeholder="${t('micro.placeholder_content') || t('garden.placeholder_content')}" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl p-3 text-xs text-slate-800 dark:text-slate-100 outline-none focus:border-slate-900 dark:focus:border-emerald-500 resize-none"></textarea>
                    </div>
                    <div>
                        <label class="block font-bold text-slate-700 dark:text-slate-300 mb-1">${t('micro.field_link_opt') || t('garden.field_link_opt')}</label>
                        <input type="url" id="micro-link-input" placeholder="https://..." class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-xs font-mono text-slate-800 dark:text-slate-100 outline-none focus:border-slate-900 dark:focus:border-emerald-500" />
                    </div>
                </div>
                <div class="flex justify-end space-x-2 pt-3 border-t border-slate-100 dark:border-slate-700">
                    <button type="button" onclick="document.getElementById('new-micro-modal').classList.add('hidden')" class="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer">${t('common.cancel')}</button>
                    <button type="button" id="confirm-save-micro-btn" class="bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2 rounded-xl text-xs font-bold shadow-sm cursor-pointer">${t('micro.btn_save_micro') || t('garden.btn_save_micro')}</button>
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
            if (currentSiteId) {
                fd.append('site_id', currentSiteId);
            }
            fd.append('type', 'micro');
            fd.append('title', title);
            fd.append('content_raw', content);
            fd.append('link', link);
            fd.append('meta_source_url', link);
            fd.append('maturity', '');
            fd.append('progress', '');
            fd.append('status', 'published');
            fd.append('csrf_token', 'walnut-admin-csrf-valid-token');

            try {
                const res = await fetch('/admin/api/save', {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'X-Admin-CSRF-Token': 'walnut-admin-csrf-valid-token'
                    },
                    body: fd
                });
                const data = await res.json();
                if (data.success) {
                    modal.classList.add('hidden');
                    if (window.showToast) window.showToast(t('micro.save_micro_success') || t('garden.save_micro_success'), 'success');
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
                title: t('micro.btn_convert_to_article') || t('garden.btn_convert_to_article'),
                message: t('micro.confirm_convert_to_article') || t('garden.confirm_convert_to_article'),
                icon: 'article',
                onConfirm: async function() {
                    try {
                        const res = await fetch('/admin/micros/api/convert-to-article/' + encodeURIComponent(id), {
                            method: 'POST',
                            headers: {
                                'Accept': 'application/json',
                                'X-Admin-CSRF-Token': 'walnut-admin-csrf-valid-token'
                            }
                        });
                        const data = await res.json();
                        if (data && data.success && data.articleId) {
                            if (window.showToast) window.showToast(t('micro.convert_success') || t('garden.convert_success'), 'success');
                            setTimeout(function() {
                                window.location.href = '/admin/articles/edit/' + encodeURIComponent(data.articleId);
                            }, 400);
                        } else {
                            if (window.showToast) window.showToast(t('micro.convert_failed', { reason: data.error || 'Unknown error' }) || t('garden.convert_failed', { reason: data.error || 'Unknown error' }), 'error');
                        }
                    } catch(err) {
                        if (window.showToast) window.showToast(t('micro.convert_failed', { reason: err.message }) || t('garden.convert_failed', { reason: err.message }), 'error');
                    }
                }
            });
        }
    };

    window.toggleVersionAccordion = function(nodeId) {
        const box = document.getElementById('versions-box-' + nodeId);
        const arrow = document.getElementById('arrow-icon-' + nodeId);
        if (box && box.classList.contains('hidden')) {
            box.classList.remove('hidden');
            if (arrow) arrow.classList.add('rotate-180');
        } else if (box) {
            box.classList.add('hidden');
            if (arrow) arrow.classList.remove('rotate-180');
        }
    };

    window.updateTrashGroupBatchState = function() {
        const checked = Array.from(document.querySelectorAll('.trash-group-checkbox:checked'));
        const toolbar = document.getElementById('trash-batch-toolbar');
        const badge = document.getElementById('trash-selected-badge');
        if (checked.length > 0) {
            if (toolbar) toolbar.classList.remove('hidden');
            if (badge) badge.innerText = t('common.selected_count', { count: checked.length });
        } else {
            if (toolbar) toolbar.classList.add('hidden');
        }
    };

    window.selectAllTrashGroups = function() {
        document.querySelectorAll('.trash-group-checkbox').forEach(function(cb) { cb.checked = true; });
        window.updateTrashGroupBatchState();
    };

    window.deselectAllTrashGroups = function() {
        document.querySelectorAll('.trash-group-checkbox').forEach(function(cb) { cb.checked = false; });
        window.updateTrashGroupBatchState();
    };

    window.batchRestoreSelectedArticles = async function() {
        const checked = Array.from(document.querySelectorAll('.trash-group-checkbox:checked'));
        if (checked.length === 0) return;
        const nodeIds = checked.map(function (cb) {
            return cb.getAttribute('data-node-id');
        }).filter(Boolean);
        for (let i = 0; i < nodeIds.length; i += 10) {
            const fd = new FormData();
            fd.append('node_ids', JSON.stringify(nodeIds.slice(i, i + 10)));
            const res = await fetch('/admin/trash/api/batch-restore', { method: 'POST', body: fd });
            if (!res.ok) {
                if (window.showToast) window.showToast(t('common.error'), 'error');
                return;
            }
        }
        window.location.reload();
    };

    window.batchHardDeleteSelectedArticles = function() {
        const checked = Array.from(document.querySelectorAll('.trash-group-checkbox:checked'));
        if (checked.length === 0) return;

        window.showConfirmDialog({
            title: t('trash.btn_batch_hard_delete'),
            message: t('trash.confirm_batch_hard_delete', { count: checked.length }),
            icon: 'delete_forever',
            onConfirm: async function() {
                const nodeIds = checked.map(function (cb) {
                    return cb.getAttribute('data-node-id');
                }).filter(Boolean);
                for (let i = 0; i < nodeIds.length; i += 10) {
                    const fd = new FormData();
                    fd.append('node_ids', JSON.stringify(nodeIds.slice(i, i + 10)));
                    const res = await fetch('/admin/trash/api/batch-hard-delete', { method: 'POST', body: fd });
                    if (!res.ok) {
                        if (window.showToast) window.showToast(t('common.error'), 'error');
                        return;
                    }
                }
                window.location.reload();
            }
        });
    };

    window.openSnapshotPreview = function(title, vNum, contentRaw) {
        const modal = document.getElementById('snapshot-preview-modal');
        const titleElem = document.getElementById('snapshot-modal-title');
        const contentElem = document.getElementById('snapshot-modal-content');

        if (titleElem) titleElem.innerText = title + ' (v' + vNum + ')';
        if (contentElem && window.marked) {
            contentElem.innerHTML = window.marked.parse(contentRaw || '');
        }
        if (modal) modal.classList.remove('hidden');
    };

    window.closeSnapshotPreview = function() {
        const modal = document.getElementById('snapshot-preview-modal');
        if (modal) modal.classList.add('hidden');
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
        const previewUrl = normPath.includes('walnut_preview=') ? normPath : (normPath + sep + 'walnut_preview=1');

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
                } catch (_) {}
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
                btn.classList.remove('bg-white', 'dark:bg-slate-800', 'shadow-sm');
                btn.classList.add('hover:bg-white/50', 'dark:hover:bg-slate-800/50');
            }
        });

        let activeBtn = btnDesktop;
        if (width === '768px') activeBtn = btnTablet;
        if (width === '375px') activeBtn = btnMobile;
        if (activeBtn) {
            activeBtn.classList.remove('hover:bg-white/50', 'dark:hover:bg-slate-800/50');
            activeBtn.classList.add('bg-white', 'dark:bg-slate-800', 'shadow-sm');
        }
    };

    window.updateBatchState = function() {
        const checked = Array.from(document.querySelectorAll('.media-select-box:checked'));
        const toolbar = document.getElementById('batch-toolbar');
        const badge = document.getElementById('selected-count-badge');
        if (checked.length > 0) {
            if (toolbar) toolbar.classList.remove('hidden');
            if (badge) badge.innerText = t('media.selected_count', { count: checked.length });
        } else {
            if (toolbar) toolbar.classList.add('hidden');
        }
    };

    window.selectAllMedia = function() {
        document.querySelectorAll('.media-select-box').forEach(function(cb) { cb.checked = true; });
        window.updateBatchState();
    };

    window.deselectAllMedia = function() {
        document.querySelectorAll('.media-select-box').forEach(function(cb) { cb.checked = false; });
        window.updateBatchState();
    };

    window.batchCopyUrls = function() {
        const checked = Array.from(document.querySelectorAll('.media-select-box:checked'));
        const urls = checked.map(function (cb) {
            return cb.getAttribute('data-url');
        }).join('\n');
        navigator.clipboard.writeText(urls);
        window.showToast(t('media.batch_copy_urls_success', { count: checked.length }), 'success');
    };

    window.batchCopyMarkdown = function() {
        const checked = Array.from(document.querySelectorAll('.media-select-box:checked'));
        const mds = checked.map(function (cb) {
            return '![' + (cb.getAttribute('data-name') || 'image') + '](' + cb.getAttribute('data-url') + ')';
        }).join('\n');
        navigator.clipboard.writeText(mds);
        window.showToast(t('media.batch_copy_md_success', { count: checked.length }), 'success');
    };

    window.batchDeleteMediaSelected = function() {
        const checked = Array.from(document.querySelectorAll('.media-select-box:checked'));
        if (checked.length === 0) return;

        window.showConfirmDialog({
            title: t('common.confirm_delete_title'),
            message: t('media.confirm_batch_delete', { count: checked.length }),
            icon: 'delete_forever',
            onConfirm: async function() {
                for (let i = 0; i < checked.length; i++) {
                    const id = checked[i].getAttribute('data-id');
                    if (id) {
                        await fetch('/admin/media/api/delete/' + id, { method: 'DELETE' });
                    }
                }
                window.location.reload();
            }
        });
    };

    window.openMediaModal = function(asset) {
        const modal = document.getElementById('media-detail-modal');
        const imgPrev = document.getElementById('modal-img-preview');
        const docPrev = document.getElementById('modal-doc-preview');

        const nameEl = document.getElementById('modal-file-name');
        const mimeEl = document.getElementById('modal-mime-type');
        const sizeEl = document.getElementById('modal-file-size');
        const dateEl = document.getElementById('modal-created-at');
        const keyEl = document.getElementById('modal-r2-key');

        if (nameEl) nameEl.innerText = asset.file_name;
        if (mimeEl) mimeEl.innerText = asset.mime_type;
        if (sizeEl) sizeEl.innerText = (asset.file_size / 1024).toFixed(1) + ' KB';
        if (dateEl) {
            const rawDt = String(asset.created_at || '');
            const utcDt = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(rawDt) ? rawDt.replace(' ', 'T') + 'Z' : rawDt;
            dateEl.innerText = new Date(utcDt).toLocaleString();
        }
        if (keyEl) keyEl.innerText = asset.r2_key;

        let assetMeta = {};
        try {
            assetMeta = asset.metadata ? (typeof asset.metadata === 'string' ? JSON.parse(asset.metadata) : asset.metadata) : {};
        } catch {}

        const metaTitleInput = document.getElementById('modal-meta-title');
        const metaAltInput = document.getElementById('modal-meta-alt');
        const editFilenameInput = document.getElementById('modal-edit-filename');
        const editFolderInput = document.getElementById('modal-edit-folder');
        const editIsPublicInput = document.getElementById('modal-edit-is-public');

        if (metaTitleInput) metaTitleInput.value = assetMeta.title || '';
        if (metaAltInput) metaAltInput.value = assetMeta.alt || '';
        if (editFilenameInput) editFilenameInput.value = asset.file_name || '';
        if (editFolderInput) editFolderInput.value = assetMeta.folder || '';
        if (editIsPublicInput) editIsPublicInput.checked = asset.is_public === undefined ? true : Boolean(Number(asset.is_public));

        const saveBtn = document.getElementById('modal-save-btn');
        if (saveBtn) {
            saveBtn.onclick = async function() {
                saveBtn.disabled = true;
                try {
                    const res = await fetch('/admin/media/api/update/' + asset.id, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            title: metaTitleInput ? metaTitleInput.value : '',
                            alt: metaAltInput ? metaAltInput.value : '',
                            file_name: editFilenameInput ? editFilenameInput.value : asset.file_name,
                            folder: editFolderInput ? editFolderInput.value : '',
                            is_public: editIsPublicInput ? editIsPublicInput.checked : true
                        })
                    });
                    const data = await res.json();
                    if (data && data.success) {
                        if (window.showToast) window.showToast(t('media.save_meta_success'), 'success');
                        setTimeout(() => window.location.reload(), 400);
                    } else {
                        if (window.showToast) window.showToast((data && data.error) || t('common.error'), 'error');
                    }
                } catch (e) {
                    if (window.showToast) window.showToast(e.message || t('common.error'), 'error');
                } finally {
                    saveBtn.disabled = false;
                }
            };
        }

        const urlInput = document.getElementById('modal-url-input');
        const mdInput = document.getElementById('modal-md-input');
        const htmlInput = document.getElementById('modal-html-input');
        const directLink = document.getElementById('modal-direct-link');
        const downloadLink = document.getElementById('modal-download-link');

        const isImg = asset.mime_type && asset.mime_type.startsWith('image/');
        if (urlInput) urlInput.value = asset.public_url;
        if (mdInput) mdInput.value = isImg ? '![' + asset.file_name + '](' + asset.public_url + ')' : '[' + asset.file_name + '](' + asset.public_url + ')';
        if (htmlInput) htmlInput.value = isImg ? '<img src="' + asset.public_url + '" alt="' + asset.file_name + '" />' : '<a href="' + asset.public_url + '" download>' + asset.file_name + '</a>';
        if (directLink) directLink.href = asset.public_url;
        if (downloadLink) {
            downloadLink.href = asset.public_url;
            downloadLink.download = asset.file_name;
        }

        if (isImg) {
            if (imgPrev) { imgPrev.src = asset.public_url; imgPrev.classList.remove('hidden'); }
            if (docPrev) docPrev.classList.add('hidden');
        } else {
            if (imgPrev) imgPrev.classList.add('hidden');
            if (docPrev) docPrev.classList.remove('hidden');
        }

        const deleteBtn = document.getElementById('modal-delete-btn');
        if (deleteBtn) {
            deleteBtn.onclick = function() {
                window.showConfirmDialog({
                    title: t('media.btn_delete_file'),
                    message: t('media.confirm_delete_named', { name: asset.file_name }),
                    icon: 'delete',
                    onConfirm: async function() {
                        await fetch('/admin/media/api/delete/' + asset.id, { method: 'DELETE' });
                        window.location.reload();
                    }
                });
            };
        }

        if (modal) modal.classList.remove('hidden');
    };

    window.closeMediaModal = function() {
        const modal = document.getElementById('media-detail-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.copyModalInput = function(id) {
        const input = document.getElementById(id);
        if (input) {
            navigator.clipboard.writeText(input.value);
            window.showToast(t('common.copy_clipboard_success'), 'success');
        }
    };

    const tableSortStates = {};

    window.sortTableByColumn = function(tableId, colIndex, dataType) {
        dataType = dataType || 'string';
        const table = document.getElementById(tableId);
        if (!table) return;

        const tbody = table.querySelector('tbody');
        if (!tbody) return;

        const key = tableId + '_' + colIndex;
        const currentSort = tableSortStates[key] || 'none';
        const nextSort = currentSort === 'none' ? 'asc' : (currentSort === 'asc' ? 'desc' : 'none');

        Object.keys(tableSortStates).forEach(function(k) {
            if (k.startsWith(tableId + '_')) {
                tableSortStates[k] = 'none';
            }
        });
        tableSortStates[key] = nextSort;

        const thList = table.querySelectorAll('thead th');
        thList.forEach(function(th, idx) {
            const icon = th.querySelector('.sort-icon');
            if (icon) {
                if (idx === colIndex) {
                    if (nextSort === 'asc') {
                        icon.textContent = 'arrow_upward';
                        icon.className = 'sort-icon material-symbols-outlined text-[15px] text-emerald-600 font-bold';
                    } else if (nextSort === 'desc') {
                        icon.textContent = 'arrow_downward';
                        icon.className = 'sort-icon material-symbols-outlined text-[15px] text-emerald-600 font-bold';
                    } else {
                        icon.textContent = 'unfold_more';
                        icon.className = 'sort-icon material-symbols-outlined text-[15px] text-slate-400';
                    }
                } else {
                    icon.textContent = 'unfold_more';
                    icon.className = 'sort-icon material-symbols-outlined text-[15px] text-slate-400';
                }
            }
        });

        const rows = Array.from(tbody.querySelectorAll('tr'));
        if (rows.length <= 1) return;

        if (!tbody._originalRows) {
            tbody._originalRows = rows.slice();
        }

        if (nextSort === 'none') {
            tbody._originalRows.forEach(function(r) { tbody.appendChild(r); });
            return;
        }

        rows.sort(function(a, b) {
            const cellA = a.children[colIndex];
            const cellB = b.children[colIndex];
            if (!cellA || !cellB) return 0;

            const valA = cellA.getAttribute('data-sort-val') !== null ? cellA.getAttribute('data-sort-val') : cellA.innerText.trim();
            const valB = cellB.getAttribute('data-sort-val') !== null ? cellB.getAttribute('data-sort-val') : cellB.innerText.trim();

            let cmp;
            if (dataType === 'number') {
                cmp = parseFloat(valA || '0') - parseFloat(valB || '0');
            } else if (dataType === 'date') {
                cmp = new Date(valA || 0).getTime() - new Date(valB || 0).getTime();
            } else {
                cmp = String(valA).localeCompare(String(valB), 'zh-CN');
            }

            return nextSort === 'asc' ? cmp : -cmp;
        });

        rows.forEach(function(r) { tbody.appendChild(r); });
    };

    let webColorPickerTarget = null;
    let currentChosenHex = '#10b981';

    const PALETTE_COLORS = [
        '#ef4444', '#f87171', '#dc2626', '#b91c1c',
        '#f97316', '#fb923c', '#ea580c', '#c2410c',
        '#f59e0b', '#fbbf24', '#d97706', '#b45309',
        '#eab308', '#fde047', '#ca8a04', '#a16207',
        '#84cc16', '#a3e635', '#65a30d', '#4d7c0f',
        '#22c55e', '#4ade80', '#16a34a', '#15803d',
        '#10b981', '#34d399', '#059669', '#047857',
        '#14b8a6', '#2dd4bf', '#0d9488', '#0f766e',
        '#06b6d4', '#22d3ee', '#0891b2', '#0e7490',
        '#0ea5e9', '#38bdf8', '#0284c7', '#0369a1',
        '#3b82f6', '#60a5fa', '#2563eb', '#1d4ed8',
        '#6366f1', '#818cf8', '#4f46e5', '#4338ca',
        '#8b5cf6', '#a78bfa', '#7c3aed', '#6d28d9',
        '#a855f7', '#c084fc', '#9333ea', '#7e22ce',
        '#d946ef', '#e879f9', '#c026d3', '#a21caf',
        '#ec4899', '#f472b6', '#db2777', '#be185d',
        '#f43f5e', '#fb7185', '#e11d48', '#be123c',
        '#0f172a', '#334155', '#64748b', '#94a3b8'
    ];

    window.initPaletteButtons = function() {
        const container = document.getElementById('web-color-palette-container');
        if (!container || container.children.length > 0) return;
        PALETTE_COLORS.forEach(function(c) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'w-7 h-7 rounded-lg shadow-xs border border-black/10 hover:scale-115 transition-transform cursor-pointer';
            btn.style.backgroundColor = c;
            btn.title = c;
            btn.onclick = function() { window.selectColorFromPalette(c); };
            container.appendChild(btn);
        });
    };

    window.openWebColorPickerModal = function(targetInputId, swatchId) {
        const input = document.getElementById(targetInputId);
        const swatch = document.getElementById(swatchId);
        const modal = document.getElementById('web-color-picker-modal');
        const hexInput = document.getElementById('web-color-hex-input');
        const previewSwatch = document.getElementById('web-color-preview-swatch');

        window.initPaletteButtons();

        webColorPickerTarget = { input: input, swatch: swatch };
        currentChosenHex = (input && input.value) ? input.value : '#10b981';

        if (hexInput) hexInput.value = currentChosenHex;
        if (previewSwatch) previewSwatch.style.backgroundColor = currentChosenHex;

        if (modal) modal.classList.remove('hidden');
    };

    window.closeWebColorPickerModal = function() {
        const modal = document.getElementById('web-color-picker-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.selectColorFromPalette = function(hex) {
        currentChosenHex = hex;
        const hexInput = document.getElementById('web-color-hex-input');
        const previewSwatch = document.getElementById('web-color-preview-swatch');
        if (hexInput) hexInput.value = hex;
        if (previewSwatch) previewSwatch.style.backgroundColor = hex;
    };

    window.applySelectedWebColor = function() {
        const hexInput = document.getElementById('web-color-hex-input');
        if (hexInput && hexInput.value) {
            currentChosenHex = hexInput.value.trim();
            if (!currentChosenHex.startsWith('#')) currentChosenHex = '#' + currentChosenHex;
        }

        if (webColorPickerTarget) {
            if (webColorPickerTarget.input) webColorPickerTarget.input.value = currentChosenHex;
            if (webColorPickerTarget.swatch) webColorPickerTarget.swatch.style.backgroundColor = currentChosenHex;
        }

        window.closeWebColorPickerModal();
        if (window.showToast) window.showToast(t('settings.color_selected_toast', { color: currentChosenHex }), 'success');
    };

    window.getAdminThemeMode = function() {
        return localStorage.getItem('walnut_theme_mode') || 'system';
    };

    window.applyThemeMode = function(mode) {
        mode = mode || window.getAdminThemeMode();
        localStorage.setItem('walnut_theme_mode', mode);

        let isDark;
        if (mode === 'dark') {
            isDark = true;
        } else if (mode === 'light') {
            isDark = false;
        } else {
            isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        }

        if (isDark) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
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

    window.togglePageColumnPicker = function() { window.toggleColumnPickerMenu('pages-table', 'pages'); };
    window.togglePageTableColumn = function(colName, visible) { window.toggleTableColumn('pages-table', colName, visible, 'pages'); };
    function initPageColumns() { window.initTableColumns('pages-table', 'pages', DEFAULT_COLS_REGISTRY.pages); }

    window.toggleUserColumnPicker = function() { window.toggleColumnPickerMenu('users-table', 'users'); };
    window.toggleUserTableColumn = function(colName, visible) { window.toggleTableColumn('users-table', colName, visible, 'users'); };
    function initUserColumns() { window.initTableColumns('users-table', 'users', DEFAULT_COLS_REGISTRY.users); }

    window.openUserModal = function() {
        const modal = document.getElementById('user-modal');
        const form = document.getElementById('user-form');
        const title = document.getElementById('user-modal-title');
        const pwdField = document.getElementById('password-field');
        const pwdInput = document.getElementById('user-password-input');
        const idInput = document.getElementById('user-id-input');

        if (form) form.reset();
        if (idInput) idInput.value = '';
        if (pwdField) pwdField.classList.remove('hidden');
        if (pwdInput) pwdInput.required = true;
        if (title) title.innerText = t('users.modal_new_title');
        if (modal) modal.classList.remove('hidden');
    };

    window.closeUserModal = function() {
        const modal = document.getElementById('user-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.editUserModal = function(user) {
        const modal = document.getElementById('user-modal');
        const title = document.getElementById('user-modal-title');
        const pwdField = document.getElementById('password-field');
        const pwdInput = document.getElementById('user-password-input');
        const idInput = document.getElementById('user-id-input');
        const usernameInput = document.getElementById('user-username-input');
        const emailInput = document.getElementById('user-email-input');
        const globalRoleInput = document.getElementById('user-global-role-input');
        const siteRoleInput = document.getElementById('user-site-role-input');

        if (idInput) idInput.value = user.id || '';
        if (usernameInput) usernameInput.value = user.username || '';
        if (emailInput) emailInput.value = user.email || '';
        if (globalRoleInput) globalRoleInput.value = user.global_role || 'user';
        if (siteRoleInput) siteRoleInput.value = user.site_role || 'admin';

        if (pwdField) pwdField.classList.add('hidden');
        if (pwdInput) pwdInput.required = false;
        if (title) title.innerText = t('users.modal_edit_title') + ': ' + user.username;
        if (modal) modal.classList.remove('hidden');
    };

    window.openEditUserModal = function(user) {
        const modal = document.getElementById('edit-user-modal') || document.getElementById('user-modal');
        const idInput = document.getElementById('edit-user-id') || document.getElementById('user-id-input');
        const usernameInput = document.getElementById('edit-username') || document.getElementById('user-username-input');
        const emailInput = document.getElementById('edit-email') || document.getElementById('user-email-input');
        const globalRoleSelect = document.getElementById('edit-global-role') || document.getElementById('user-global-role-input');
        const siteRoleSelect = document.getElementById('edit-site-role') || document.getElementById('user-site-role-input');

        if (idInput) idInput.value = user.id || '';
        if (usernameInput) usernameInput.value = user.username || '';
        if (emailInput) emailInput.value = user.email || '';
        if (globalRoleSelect) globalRoleSelect.value = user.global_role || 'user';
        if (siteRoleSelect) siteRoleSelect.value = user.site_role || 'admin';

        const pwdField = document.getElementById('password-field');
        if (pwdField) pwdField.classList.add('hidden');
        const pwdInput = document.getElementById('user-password-input');
        if (pwdInput) pwdInput.required = false;

        modal?.classList.remove('hidden');
    };

    window.closeEditUserModal = function() {
        const modal = document.getElementById('edit-user-modal') || document.getElementById('user-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.openResetPasswordModal = function(id, username) {
        const modal = document.getElementById('reset-pwd-modal');
        const idInput = document.getElementById('reset-pwd-id');
        const titleElem = document.getElementById('reset-pwd-username');
        if (idInput) idInput.value = id;
        if (titleElem) titleElem.innerText = username;
        if (modal) modal.classList.remove('hidden');
    };

    window.closeResetPasswordModal = function() {
        const modal = document.getElementById('reset-pwd-modal');
        if (modal) modal.classList.add('hidden');
    };

    async function convertImageToWebp(file) {
        if (!file.type.startsWith('image/') || file.type === 'image/webp' || file.type === 'image/svg+xml' || file.type === 'image/gif') {
            return file;
        }
        return new Promise(function(resolve) {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = function() {
                URL.revokeObjectURL(url);
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                if (!ctx) return resolve(file);
                ctx.drawImage(img, 0, 0);
                canvas.toBlob(function(blob) {
                    if (!blob) return resolve(file);
                    const baseName = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
                    const newFile = new File([blob], baseName + '.webp', {type: 'image/webp'});
                    resolve(newFile);
                }, 'image/webp', 0.85);
            };
            img.onerror = function() {
                URL.revokeObjectURL(url);
                resolve(file);
            };
            img.src = url;
        });
    }

    function initMediaUploadListener() {
        const uploadInput = document.getElementById('media-upload-input');
        if (!uploadInput) return;

        uploadInput.addEventListener('change', async function(e) {
            const files = e.target.files;
            if (!files || files.length === 0) return;

            const statusEl = document.getElementById('upload-status');
            if (statusEl) {
                statusEl.classList.remove('hidden');
                statusEl.innerText = t('media.uploading', { count: files.length });
            }

            const fd = new FormData();
            for (let i = 0; i < files.length; i++) {
                const processedFile = await convertImageToWebp(files[i]);
                fd.append('files', processedFile);
            }

            const searchParams = new URLSearchParams(window.location.search);
            const siteIdParam = searchParams.get('site_id');
            const uploadUrl = '/admin/media/api/upload' + (siteIdParam ? '?site_id=' + encodeURIComponent(siteIdParam) : '');

            try {
                const res = await fetch(uploadUrl, { method: 'POST', body: fd });
                const data = await res.json().catch(function() { return {}; });

                if (res.ok && data.success) {
                    if (statusEl) statusEl.innerText = t('media.upload_success');
                    if (window.showToast) window.showToast(t('media.upload_success'), 'success');
                    uploadInput.value = '';
                    setTimeout(function() { window.location.reload(); }, 500);
                } else {
                    const errMsg = data.error || t('common.error');
                    if (statusEl) statusEl.innerText = errMsg;
                    if (window.showToast) window.showToast(errMsg, 'error');
                }
            } catch (err) {
                if (statusEl) statusEl.innerText = t('common.network_error');
                if (window.showToast) window.showToast(t('common.network_error'), 'error');
            }
        });
    }

    window.toggleLogColumnPicker = function() { window.toggleColumnPickerMenu('logs-table', 'logs'); };
    window.toggleLogTableColumn = function(colName, visible) { window.toggleTableColumn('logs-table', colName, visible, 'logs'); };
    function initLogColumns() { window.initTableColumns('logs-table', 'logs', DEFAULT_COLS_REGISTRY.logs); }

    window.toggleTaskColumnPicker = function() { window.toggleColumnPickerMenu('tasks-table', 'tasks'); };
    window.toggleTaskTableColumn = function(colName, visible) { window.toggleTableColumn('tasks-table', colName, visible, 'tasks'); };
    function initTaskColumns() { window.initTableColumns('tasks-table', 'tasks', DEFAULT_COLS_REGISTRY.tasks); }

    window.toggleMicroColumnPicker = function() { window.toggleColumnPickerMenu('micro-table', 'micro'); };
    window.toggleMicroTableColumn = function(colName, visible) { window.toggleTableColumn('micro-table', colName, visible, 'micro'); };
    function initMicroColumns() { window.initTableColumns('micro-table', 'micro', DEFAULT_COLS_REGISTRY.micro); }

    window.syncTaskModalFields = function(taskType) {
        const targetNodeWrap = document.getElementById('task-field-target-node');
        const retDaysWrap = document.getElementById('task-field-retention-days');
        const retCountWrap = document.getElementById('task-field-retention-count');
        if (targetNodeWrap) targetNodeWrap.classList.toggle('hidden', taskType !== 'publish_node' && taskType !== 'scheduled_unpublish');
        if (retDaysWrap) retDaysWrap.classList.toggle('hidden', taskType !== 'purge_deleted' && taskType !== 'archive_analytics');
        if (retCountWrap) retCountWrap.classList.toggle('hidden', taskType !== 'r2_scheduled_backup');
    };

    window.setTaskScheduleType = function(mode) {
        const input = document.getElementById('task-form-schedule-type');
        const runAtWrap = document.getElementById('task-field-run-at');
        const intervalWrap = document.getElementById('task-field-interval-wrap');
        const btnOnce = document.getElementById('task-sched-btn-once');
        const btnRec = document.getElementById('task-sched-btn-recurring');
        const activeCls = ['border-emerald-500', 'bg-emerald-50', 'dark:bg-emerald-950/60', 'text-emerald-700', 'dark:text-emerald-300'];
        const idleCls = ['border-slate-200', 'dark:border-slate-700', 'text-slate-600', 'dark:text-slate-300'];
        if (input) input.value = mode;
        if (runAtWrap) runAtWrap.classList.toggle('hidden', mode !== 'once');
        if (intervalWrap) intervalWrap.classList.toggle('hidden', mode === 'once');
        if (btnOnce && btnRec) {
            const onBtn = mode === 'once' ? btnOnce : btnRec;
            const offBtn = mode === 'once' ? btnRec : btnOnce;
            onBtn.classList.remove(...idleCls);
            onBtn.classList.add(...activeCls);
            offBtn.classList.remove(...activeCls);
            offBtn.classList.add(...idleCls);
        }
    };

    window.setTaskIntervalPreset = function(preset, label) {
        const input = document.getElementById('task-form-interval-preset');
        const lbl = document.getElementById('task-preset-selected-label');
        const menu = document.getElementById('task-preset-dropdown-menu');
        const customWrap = document.getElementById('task-field-custom-minutes');
        if (input) input.value = preset;
        if (lbl && label) lbl.innerText = label;
        if (menu) menu.classList.add('hidden');
        if (customWrap) customWrap.classList.toggle('hidden', preset !== 'custom');
    };

    window.selectTaskType = function(taskType, label) {
        const formType = document.getElementById('task-form-type-input');
        const typeLabel = document.getElementById('task-type-selected-label');
        const menu = document.getElementById('task-type-dropdown-menu');
        if (formType) formType.value = taskType;
        if (typeLabel && label) typeLabel.innerText = label;
        if (menu) menu.classList.add('hidden');
        window.syncTaskModalFields(taskType);
        if (taskType === 'publish_node' || taskType === 'scheduled_unpublish') {
            window.setTaskScheduleType('once');
        } else {
            window.setTaskScheduleType('recurring');
        }
    };

    window.openTaskModal = function() {
        const title = document.getElementById('task-modal-title');
        const formId = document.getElementById('task-form-id');
        const formType = document.getElementById('task-form-type-input');
        const typeLabel = document.getElementById('task-type-selected-label');
        const interval = document.getElementById('task-form-interval');
        const targetNode = document.getElementById('task-form-target-node');
        const retDays = document.getElementById('task-form-retention-days');
        const retCount = document.getElementById('task-form-retention-count');
        const modal = document.getElementById('task-modal');
        if (title && modal?.dataset?.titleNew) title.innerText = modal.dataset.titleNew;
        if (formId) formId.value = '';
        if (formType) formType.value = 'publish_node';
        if (typeLabel && modal?.dataset?.defaultLabel) typeLabel.innerText = modal.dataset.defaultLabel;
        if (interval) interval.value = '5';
        if (targetNode) targetNode.value = '';
        if (retDays) retDays.value = '30';
        if (retCount) retCount.value = '7';
        window.syncTaskModalFields('publish_node');
        window.setTaskScheduleType('recurring');
        const customOpt = modal?.querySelector('[data-preset="custom"]');
        window.setTaskIntervalPreset('custom', customOpt?.dataset?.label || '');
        if (modal) modal.classList.remove('hidden');
    };

    window.editTaskModal = function(task) {
        const title = document.getElementById('task-modal-title');
        const formId = document.getElementById('task-form-id');
        const formType = document.getElementById('task-form-type-input');
        const typeLabel = document.getElementById('task-type-selected-label');
        const interval = document.getElementById('task-form-interval');
        const targetNode = document.getElementById('task-form-target-node');
        const retDays = document.getElementById('task-form-retention-days');
        const retCount = document.getElementById('task-form-retention-count');
        const modal = document.getElementById('task-modal');
        let payload = {};
        try { payload = typeof task.payload === 'string' ? JSON.parse(task.payload) : (task.payload || {}); } catch {}
        if (title && modal?.dataset?.titleEdit) title.innerText = modal.dataset.titleEdit;
        if (formId) formId.value = task.id;
        if (formType) formType.value = task.task_type;
        const opt = modal?.querySelector(`[data-task-type="${task.task_type}"]`);
        if (typeLabel) typeLabel.innerText = opt?.dataset?.label || task.task_type;
        if (interval) interval.value = task.cron_interval_minutes || 5;
        if (targetNode) targetNode.value = payload.node_id || '';
        if (retDays) retDays.value = payload.retention_days || 30;
        if (retCount) retCount.value = payload.retention_count || 7;
        window.syncTaskModalFields(task.task_type);
        window.setTaskScheduleType(task.schedule_type || 'recurring');
        const preset = task.interval_preset || 'custom';
        const presetOpt = modal?.querySelector(`[data-preset="${preset}"]`);
        window.setTaskIntervalPreset(preset, presetOpt?.dataset?.label || '');
        if (modal) modal.classList.remove('hidden');
    };

    window.closeTaskModal = function() {
        const modal = document.getElementById('task-modal');
        if (modal) modal.classList.add('hidden');
    };

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
                body: JSON.stringify({ siteId, app: appName })
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
                setTimeout(() => {
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

    window.toggleWizardDropdown = function(key) {
        const menu = document.getElementById('dropdown-menu-' + key);
        if (menu) menu.classList.toggle('hidden');
    };

    window.selectWizardLocale = function(locale, label) {
        const input = document.getElementById('wizard-locale-input');
        const labelEl = document.getElementById('wizard-locale-selected-label');
        if (input) input.value = locale;
        if (labelEl) labelEl.textContent = label;
        const menu = document.getElementById('dropdown-menu-wizard-locale');
        if (menu) menu.classList.add('hidden');
    };

    document.addEventListener('click', function(e) {
        ['articles', 'pages', 'users', 'logs', 'tasks', 'micro'].forEach(function(key) {
            const wrapper = document.getElementById('column-picker-wrapper-' + key)
                || document.getElementById(key + '-column-picker-wrapper')
                || document.getElementById('column-picker-wrapper');
            const menu = document.getElementById('column-picker-menu-' + key)
                || document.getElementById(key + '-column-picker-dropdown')
                || document.getElementById('column-picker-dropdown');
            if (wrapper && menu && !wrapper.contains(e.target)) {
                menu.classList.add('hidden');
            }
        });

        const wizardBox = document.getElementById('dropdown-box-wizard-locale');
        const wizardMenu = document.getElementById('dropdown-menu-wizard-locale');
        if (wizardBox && wizardMenu && !wizardBox.contains(e.target)) {
            wizardMenu.classList.add('hidden');
        }

        const schemaBox = document.getElementById('dropdown-box-dataset-schema');
        const schemaMenu = document.getElementById('dropdown-menu-dataset-schema');
        if (schemaBox && schemaMenu && !schemaBox.contains(e.target)) {
            schemaMenu.classList.add('hidden');
        }
    });

    function initAllTableColumnsInternal() {
        initArticleColumns();
        initPageColumns();
        initUserColumns();
        initLogColumns();
        initTaskColumns();
        initMicroColumns();
    }

    const unlockFoucCloak = function(root) {
        const target = root || document;
        target.querySelectorAll?.('[data-cloak], [walnut-cloak], .walnut-cloak').forEach(function(el) {
            el.removeAttribute('data-cloak');
            el.removeAttribute('walnut-cloak');
            el.classList.remove('walnut-cloak');
        });
    };
    window.unlockFoucCloak = unlockFoucCloak;

    window.switchAuditSubTab = function(tabId) {
        if (!tabId) return;
        ['tab-logs', 'tab-tasks', 'tab-webhooks', 'tab-backups', 'tab-blocklist', 'tab-traffic', 'tab-users'].forEach(function(id) {
            const tab = document.getElementById(id);
            const btn = document.getElementById('btn-' + id);
            if (tab) {
                if (id === tabId) {
                    tab.style.display = 'block';
                    tab.classList.remove('hidden');
                } else {
                    tab.style.display = 'none';
                    tab.classList.add('hidden');
                }
            }
            if (btn) {
                if (id === tabId) {
                    btn.className = 'px-4 py-2.5 border-b-2 border-slate-900 dark:border-white text-slate-900 dark:text-white transition-colors duration-75 ease-out flex items-center space-x-1.5 cursor-pointer';
                } else {
                    btn.className = 'px-4 py-2.5 border-b-2 border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors duration-75 ease-out flex items-center space-x-1.5 cursor-pointer';
                }
            }
        });
        const syncBar = document.getElementById('audit-traffic-sync-bar');
        if (syncBar) {
            syncBar.style.display = tabId === 'tab-traffic' ? 'flex' : 'none';
        }
    };

    window.filterDashboardFeed = function(moduleName) {
        const target = moduleName || 'all';
        document.querySelectorAll('.feed-filter-btn').forEach(function(btn) {
            const isActive = btn.getAttribute('data-module') === target;
            btn.className = isActive
                ? 'feed-filter-btn px-2.5 py-1 rounded-lg bg-white dark:bg-slate-800 text-slate-800 dark:text-white shadow-sm transition-colors duration-75 cursor-pointer'
                : 'feed-filter-btn px-2.5 py-1 rounded-lg text-slate-500 hover:text-slate-800 dark:hover:text-white transition-colors duration-75 cursor-pointer';
        });
        const list = document.getElementById('dashboard-content-feed-list') || document;
        list.querySelectorAll('.dashboard-feed-row').forEach(function(row) {
            const mod = row.getAttribute('data-feed-module') || '';
            const show = target === 'all' || mod === target;
            row.style.display = show ? 'flex' : 'none';
        });
    };

    document.addEventListener('DOMContentLoaded', function() {
        if (document.body && !document.body.hasAttribute('hx-sync')) {
            document.body.setAttribute('hx-sync', 'this:replace');
        }
        initResizableTableColumns();

    let isResizingCol = false;
    let lastResizeEndAt = 0;

    function initResizableTableColumns() {
        document.querySelectorAll('table[id]').forEach(function(table) {
            const tableId = table.id;
            const ths = Array.from(table.querySelectorAll('thead th'));
            if (ths.length === 0) return;

            if (!table.dataset.sortGuardBound) {
                table.dataset.sortGuardBound = '1';
                // Only sort on explicit .sort-icon clicks and ignore clicks within 300ms of resize end to prevent accidental sorts.
                table.addEventListener('click', function(e) {
                    if (isResizingCol || (Date.now() - lastResizeEndAt < 300)) {
                        e.stopPropagation();
                        e.preventDefault();
                        return;
                    }
                    const th = e.target.closest('th');
                    if (th && th.querySelector('.sort-icon') && !e.target.closest('.sort-icon') && !e.target.closest('.col-filter-btn') && !e.target.closest('input')) {
                        e.stopPropagation();
                    }
                }, true);
            }

            // Preserve table-auto and size individual columns rather than switching to table-layout: fixed.
            table.style.tableLayout = 'auto';

            let savedWidths = {};
            try {
                savedWidths = JSON.parse(localStorage.getItem('walnut_col_widths_' + tableId) || '{}');
            } catch (e) {}

            ths.forEach(function(th, idx) {
                const labelW = th.firstElementChild ? th.firstElementChild.scrollWidth : 48;
                const minColW = Math.max(88, Math.ceil(labelW + 36));
                th.dataset.minWidth = String(minColW);

                const colKey = th.getAttribute('data-col') || String(idx);
                if (savedWidths[colKey]) {
                    const applied = Math.max(minColW, Number(savedWidths[colKey]) || minColW);
                    th.style.width = applied + 'px';
                    th.style.minWidth = applied + 'px';
                }
            });

            ths.forEach(function(th, idx) {
                if (idx === 0 && th.classList.contains('w-12')) return;
                if (th.querySelector('.th-resize-handle')) return;
                const handle = document.createElement('span');
                handle.className = 'th-resize-handle';
                handle.addEventListener('click', function(e) { e.stopPropagation(); });
                handle.addEventListener('mousedown', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    const startX = e.clientX;
                    const startWidth = th.getBoundingClientRect().width;
                    const minColW = Number(th.dataset.minWidth || 88);
                    isResizingCol = true;
                    handle.classList.add('is-resizing');

                    function onMouseMove(ev) {
                        const nextW = Math.max(minColW, Math.round(startWidth + (ev.clientX - startX)));
                        th.style.width = nextW + 'px';
                        th.style.minWidth = nextW + 'px';
                    }
                    function onMouseUp() {
                        isResizingCol = false;
                        lastResizeEndAt = Date.now();
                        handle.classList.remove('is-resizing');
                        document.removeEventListener('mousemove', onMouseMove);
                        document.removeEventListener('mouseup', onMouseUp);
                        const colKey = th.getAttribute('data-col') || String(idx);
                        savedWidths[colKey] = Math.round(th.getBoundingClientRect().width);
                        try {
                            localStorage.setItem('walnut_col_widths_' + tableId, JSON.stringify(savedWidths));
                        } catch (err) {}
                    }
                    document.addEventListener('mousemove', onMouseMove);
                    document.addEventListener('mouseup', onMouseUp);
                });
                th.appendChild(handle);
            });
        });
    }
    document.addEventListener('htmx:afterSwap', initResizableTableColumns);
        unlockFoucCloak();
        initAllTableColumnsInternal();
        initMediaUploadListener();
        initFastMemoSubmitListener();
        initThemeSystemSync();
        try {
            const folderParam = new URLSearchParams(window.location.search).get('folder');
            if (folderParam && document.getElementById('micro-folder-chips') && window.filterByFolder) {
                window.filterByFolder('micro-table', folderParam, 'micro-folder-chips');
            }
        } catch (e) {}

        document.addEventListener('input', function(e) {
            if (e.target && e.target.id === 'wh-input-form-id') {
                const preview = document.getElementById('wh-preview-form-id');
                if (preview) {
                    preview.textContent = e.target.value.trim() || 'contact-us';
                }
            }
        });
    });

    // Do not call unlockFoucCloak unconditionally here; individual modules unlock after rendering to prevent pre-hydration flashes.
    document.addEventListener('htmx:load', function(evt) {
        syncAdminDict(evt && evt.detail && evt.detail.elt);
        initAllTableColumnsInternal();
    });

    window.handleBatchExportArticlesJson = function() {
        const selected = Array.from(document.querySelectorAll('.row-select-box:checked, .article-select-box:checked'));
        if (selected.length === 0) {
            if (window.showToast) window.showToast(t('common.no_nodes_selected'), 'warning');
            return;
        }
        const ids = selected.map(function (el) {
            return el.getAttribute('data-id');
        }).filter(Boolean);
        window.location.href = '/admin/articles/api/export-selected?ids=' + ids.join(',');
    };

    window.handleArticleFileImport = function(fileInput) {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;

        const reader = new FileReader();
        const fileName = file.name || 'article.md';
        const isMarkdown = fileName.endsWith('.md') || fileName.endsWith('.markdown');

        reader.onload = async function(e) {
            const content = e.target.result;
            let items = [];

            if (isMarkdown) {
                const lines = content.split('\n');
                let title = fileName.replace(/\.[^/.]+$/, '');
                if (lines[0] && lines[0].startsWith('# ')) {
                    title = lines[0].replace(/^#\s+/, '').trim();
                }
                items.push({
                    title: title,
                    slug: title.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-'),
                    content: content,
                    type: 'article'
                });
            } else {
                try {
                    const parsed = JSON.parse(content);
                    items = Array.isArray(parsed) ? parsed : [parsed];
                } catch (err) {
                    if (window.showToast) window.showToast(t('common.error'), 'error');
                    return;
                }
            }

            try {
                let chunkSize = 10;
                const total = items.length;
                let done = 0;
                let lastError = null;
                while (done < total) {
                    const chunk = items.slice(done, done + chunkSize);
                    if (window.showToast) window.showToast(t('common.loading') + ' ' + done + ' / ' + total, 'info');
                    const res = await fetch('/admin/articles/api/batch-import', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Admin-CSRF-Token': 'walnut-admin-csrf-valid-token'
                        },
                        body: JSON.stringify({ items: chunk })
                    });
                    const rawText = await res.clone().text();
                    if (isCpuLimitResponse(res.status, rawText) && chunkSize > 1) {
                        chunkSize = Math.max(1, Math.floor(chunkSize / 2));
                        await new Promise(function(r) { setTimeout(r, 500); });
                        continue;
                    }
                    const data = JSON.parse(rawText || '{}');
                    if (!data.success) {
                        lastError = data.error || t('common.error');
                        break;
                    }
                    done += chunk.length;
                    if (window.showToast) window.showToast(t('common.loading') + ' ' + done + ' / ' + total, 'info');
                }
                if (!lastError) {
                    if (window.showToast) window.showToast(t('common.success') + ' (' + done + ' / ' + total + ')', 'success');
                    setTimeout(function() { window.location.reload(); }, 600);
                } else {
                    if (window.showToast) window.showToast(lastError, 'error');
                }
            } catch (netErr) {
                if (window.showToast) window.showToast(t('common.network_error'), 'error');
            }
        };
        reader.readAsText(file);
    };

    window.openWebhookModal = function(config) {
        const modal = document.getElementById('webhook-modal');
        const form = document.getElementById('webhook-form');
        const titleEl = document.getElementById('webhook-modal-title');
        const idInput = document.getElementById('wh-input-id');
        const nameInput = document.getElementById('wh-input-name');
        const formIdInput = document.getElementById('wh-input-form-id');
        const urlInput = document.getElementById('wh-input-url');
        const secretInput = document.getElementById('wh-input-secret');
        const activeInput = document.getElementById('wh-input-active');
        const previewFormId = document.getElementById('wh-preview-form-id');

        if (!modal || !form) return;

        if (config) {
            if (titleEl) titleEl.textContent = t('webhooks.modal_edit_title');
            if (idInput) idInput.value = config.id || '';
            if (nameInput) nameInput.value = config.name || '';
            if (formIdInput) {
                formIdInput.value = config.form_id || '';
                formIdInput.readOnly = true;
            }
            if (urlInput) urlInput.value = config.form_webhook_url || '';
            if (secretInput) secretInput.value = config.form_webhook_secret || '';
            if (activeInput) activeInput.checked = config.is_active !== 0;
            if (previewFormId) previewFormId.textContent = config.form_id || 'contact-us';
        } else {
            if (titleEl) titleEl.textContent = t('webhooks.modal_create_title');
            form.reset();
            if (idInput) idInput.value = '';
            if (formIdInput) formIdInput.readOnly = false;
            if (activeInput) activeInput.checked = true;
            if (previewFormId) previewFormId.textContent = 'contact-us';
        }

        modal.classList.remove('hidden');
    };

    window.closeWebhookModal = function() {
        const modal = document.getElementById('webhook-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.handleWebhookFormSubmit = async function(e) {
        e.preventDefault();
        const id = (document.getElementById('wh-input-id')?.value || '').trim();
        const name = (document.getElementById('wh-input-name')?.value || '').trim();
        const form_id = (document.getElementById('wh-input-form-id')?.value || '').trim();
        const form_webhook_url = (document.getElementById('wh-input-url')?.value || '').trim();
        const form_webhook_secret = (document.getElementById('wh-input-secret')?.value || '').trim();
        const is_active = document.getElementById('wh-input-active')?.checked ? 1 : 0;

        if (!name || !form_id || !form_webhook_url) {
            window.showToast(t('common.fill_required'), 'warning');
            return;
        }

        try {
            const res = await fetch('/admin/webhooks/api/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: id || undefined,
                    name: name,
                    form_id: form_id,
                    form_webhook_url: form_webhook_url,
                    form_webhook_secret: form_webhook_secret || null,
                    is_active: is_active
                })
            });
            const json = await res.json();
            if (json.success) {
                window.showToast(t('webhooks.save_success'), 'success');
                window.closeWebhookModal();
                setTimeout(function() { window.location.reload(); }, 300);
            } else {
                window.showToast(json.error || t('webhooks.save_failed'), 'error');
            }
        } catch (err) {
            window.showToast(err.message, 'error');
        }
    };

    window.deleteWebhookRule = function(id, name) {
        window.showConfirmDialog({
            title: t('webhooks.delete_title'),
            message: (t('webhooks.delete_confirm') || '').replace('{{name}}', name),
            onConfirm: async function() {
                try {
                    const res = await fetch('/admin/webhooks/api/' + encodeURIComponent(id), {
                        method: 'DELETE'
                    });
                    const json = await res.json();
                    if (json.success) {
                        window.showToast(t('webhooks.delete_success'), 'success');
                        setTimeout(function() { window.location.reload(); }, 300);
                    } else {
                        window.showToast(json.error || t('webhooks.delete_failed'), 'error');
                    }
                } catch (err) {
                    window.showToast(err.message, 'error');
                }
            }
        });
    };

    window.testWebhookDispatch = async function(id) {
        window.showToast(t('webhooks.sending_test'), 'info');
        try {
            const res = await fetch('/admin/webhooks/api/test/' + encodeURIComponent(id), {
                method: 'POST'
            });
            const json = await res.json();
            if (json.success) {
                window.showToast(t('webhooks.test_success') + ' (Platform: ' + (json.data?.platform || 'custom') + ')', 'success');
            } else {
                window.showToast(json.error || t('webhooks.test_failed'), 'error');
            }
        } catch (err) {
            window.showToast(err.message, 'error');
        }
    };

    window.toggleWizardInitMode = function(mode) {
        const cp = document.getElementById('wizard-clone-panel');
        const sp = document.getElementById('wizard-snapshot-panel');
        if (cp) cp.classList.toggle('hidden', mode !== 'clone');
        if (sp) sp.classList.toggle('hidden', mode !== 'snapshot');
    };

    window.openBatchRenameModal = function() {
        const selected = Array.from(document.querySelectorAll('.media-select-box:checked'));
        if (selected.length === 0) {
            if (window.showToast) window.showToast(t('common.no_nodes_selected'), 'warning');
            return;
        }
        const modal = document.getElementById('media-batch-rename-modal');
        const countEl = document.getElementById('rename-modal-count');
        if (countEl) countEl.innerText = String(selected.length);
        if (modal) modal.classList.remove('hidden');
    };

    window.closeBatchRenameModal = function() {
        const modal = document.getElementById('media-batch-rename-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.submitBatchRename = async function() {
        const prefix = (document.getElementById('rename-prefix-input')?.value || '').trim();
        const replaceFrom = (document.getElementById('rename-from-input')?.value || '');
        const replaceTo = (document.getElementById('rename-to-input')?.value || '');

        const selected = Array.from(document.querySelectorAll('.media-select-box:checked'));
        const items = selected.map(function (box, idx) {
            const id = box.getAttribute('data-id');
            const oldName = box.getAttribute('data-name') || 'file';
            const ext = oldName.includes('.') ? oldName.substring(oldName.lastIndexOf('.')) : '';
            const base = oldName.includes('.') ? oldName.substring(0, oldName.lastIndexOf('.')) : oldName;

            let newBase = base;
            if (replaceFrom) {
                newBase = newBase.split(replaceFrom).join(replaceTo);
            }
            if (prefix) {
                newBase = prefix + '_' + (idx + 1) + '_' + newBase;
            }
            return { id: id, newName: newBase + ext };
        });

        try {
            const res = await fetch('/admin/media/api/batch-rename', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Admin-CSRF-Token': 'walnut-admin-csrf-valid-token'
                },
                body: JSON.stringify({ items: items })
            });
            const data = await res.json();
            if (data.success) {
                if (window.showToast) window.showToast(t('common.success'), 'success');
                setTimeout(function() { window.location.reload(); }, 600);
            } else {
                if (window.showToast) window.showToast(data.error || t('common.error'), 'error');
            }
        } catch (e) {
            if (window.showToast) window.showToast(t('common.network_error'), 'error');
        }
    };
})();
