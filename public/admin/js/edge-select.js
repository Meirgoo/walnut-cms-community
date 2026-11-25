(function() {
    'use strict';

    const t = function(k, params) {
        const fn = window.__EDGE_I18N__ && window.__EDGE_I18N__.t;
        return typeof fn === 'function' ? fn(k, params) : k;
    };

    function isCpuLimitResponse(status, textBody) {
        if (status === 503 && String(textBody || '').includes('1102')) return true;
        if (status === 422 && String(textBody || '').includes('SOFT_CPU_LIMIT')) return true;
        return false;
    }

    (window.__EDGE_RUNTIME__ = window.__EDGE_RUNTIME__ || {}).isCpuLimitResponse = isCpuLimitResponse;

    const CSRF_TOKEN = 'edge-admin-csrf-valid-token';

    if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
        const origFetch = window.fetch.bind(window);
        window.fetch = async function(input, init) {
            const opts = init ? Object.assign({}, init) : {};
            const method = (opts.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();
            if (method !== 'GET' && method !== 'HEAD') {
                opts.headers = opts.headers || {};
                if (opts.headers instanceof Headers) {
                    if (!opts.headers.has('X-Admin-CSRF-Token')) {
                        opts.headers.set('X-Admin-CSRF-Token', CSRF_TOKEN);
                    }
                } else if (Array.isArray(opts.headers)) {
                    opts.headers = opts.headers.slice();
                    opts.headers.push(['X-Admin-CSRF-Token', CSRF_TOKEN]);
                } else {
                    opts.headers = Object.assign({}, opts.headers);
                    if (!opts.headers['X-Admin-CSRF-Token']) {
                        opts.headers['X-Admin-CSRF-Token'] = CSRF_TOKEN;
                    }
                }
            }
            const res = await origFetch(input, opts);
            if (res.status === 503 || res.status === 422) {
                try {
                    const text = await res.clone().text();
                    if (isCpuLimitResponse(res.status, text) && window.showToast) {
                        window.showToast(t('common.soft_cpu_limit_warning'), 'warning');
                    }
                } catch {}
            }
            return res;
        };
    }

    document.addEventListener('htmx:configRequest', function(evt) {
        if (evt.detail && evt.detail.headers) {
            evt.detail.headers['X-Admin-CSRF-Token'] = CSRF_TOKEN;
        }
    });

    document.addEventListener('htmx:responseError', function(evt) {
        const xhr = evt && evt.detail && evt.detail.xhr;
        if (xhr && isCpuLimitResponse(xhr.status, xhr.responseText) && window.showToast) {
            window.showToast(t('common.soft_cpu_limit_warning'), 'warning');
        }
    });

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
            const el = doc.querySelector ? doc.querySelector('#edge-i18n-dict') : document.getElementById('edge-i18n-dict');
            if (el && el.textContent) {
                const parsed = JSON.parse(el.textContent);
                const i18nStore = (window.__EDGE_I18N__ = window.__EDGE_I18N__ || {});
                i18nStore.dict = i18nStore.dict || {};
                mergeAdminDict(i18nStore.dict, parsed);
                i18nStore.adminDict = i18nStore.dict;
            }
        } catch {}
    }

    (window.__EDGE_RUNTIME__ = window.__EDGE_RUNTIME__ || {}).syncAdminDict = syncAdminDict;
    syncAdminDict();
    document.addEventListener('htmx:afterSwap', function(evt) {
        syncAdminDict(evt && evt.detail && evt.detail.elt);
    });
    document.addEventListener('htmx:load', function(evt) {
        syncAdminDict(evt && evt.detail && evt.detail.elt);
    });
    window.dispatchEvent(new CustomEvent('walnut:i18n-loaded'));

    const openEdgeSelects = new Set();

    function closeAllEdgeSelects(exceptInstance) {
        Array.from(openEdgeSelects).forEach(function(inst) {
            if (inst !== exceptInstance && typeof inst._close === 'function') {
                inst._close();
            }
        });
    }

    document.addEventListener('click', function(e) {
        Array.from(openEdgeSelects).forEach(function(inst) {
            const inHost = inst.contains(e.target);
            const inMenu = inst._menuEl && inst._menuEl.contains(e.target);
            if (!inHost && !inMenu) {
                inst._close();
            }
        });
    });
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') closeAllEdgeSelects();
    });
    document.addEventListener('scroll', function(e) {
        if (openEdgeSelects.size === 0) return;
        const targetEl = e.target && e.target.nodeType === 1 ? e.target : null;
        if (targetEl && targetEl.closest && targetEl.closest('.edge-select-menu')) return;
        closeAllEdgeSelects();
    }, true);
    window.addEventListener('resize', function() { closeAllEdgeSelects(); });
    document.addEventListener('htmx:beforeSwap', function() { closeAllEdgeSelects(); });

    class WalnutSelect extends HTMLElement {
        constructor() {
            super();
            this._value = '';
            this._options = [];
            this._selectedIndex = -1;
            this._isOpen = false;
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
            this._close();
            if (this._menuEl && this._menuEl.parentNode === document.body) {
                this._menuEl.remove();
            }
        }

        // Rebuild internal menu/label state after script code appends or removes <option> elements.
        refresh(nextValue) {
            if (this.getAttribute('data-menu-id')) return;
            this._close();
            if (this._menuEl && this._menuEl.parentNode === document.body) {
                this._menuEl.remove();
            }
            if (this._hiddenInput && this._hiddenInput.parentNode) this._hiddenInput.remove();
            if (this._triggerBtn && this._triggerBtn.parentNode) this._triggerBtn.remove();
            if (this._menuEl && this._menuEl.parentNode) this._menuEl.remove();
            this._hiddenInput = null;
            this._triggerBtn = null;
            this._labelEl = null;
            this._arrowEl = null;
            this._menuEl = null;
            const rawOptions = Array.from(this.querySelectorAll('option'));
            if (nextValue !== undefined && nextValue !== null) {
                this.setAttribute('value', String(nextValue));
            } else {
                this.removeAttribute('value');
            }
            if (rawOptions.length > 0) {
                this._initOptionsDropdown(rawOptions);
            } else {
                this._initEmptyDropdown();
            }
            this._initialized = true;
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

            const initialValue = this.getAttribute('value');
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
            this._triggerBtn.className = 'edge-select-trigger flex items-center justify-between space-x-1.5 w-full h-full min-w-0 leading-none bg-transparent text-inherit outline-none cursor-pointer';

            this._labelEl = document.createElement('span');
            this._labelEl.className = 'edge-select-label truncate';
            this._labelEl.textContent = selectedOpt ? selectedOpt.label : '';
            this._triggerBtn.appendChild(this._labelEl);

            this._arrowEl = document.createElement('span');
            this._arrowEl.className = 'material-symbols-outlined text-[14px] opacity-70 shrink-0 transition-transform duration-150 select-none';
            this._arrowEl.textContent = 'expand_more';
            this._triggerBtn.appendChild(this._arrowEl);

            this.appendChild(this._triggerBtn);

            this._menuEl = document.createElement('div');
            this._menuEl.className = 'edge-select-menu hidden min-w-[120px] max-w-[300px] bg-[var(--admin-surface)] text-[var(--admin-text)] border border-[var(--admin-border)] rounded-lg shadow-xl py-1 overflow-y-auto';

            const self = this;
            this._options.forEach(function(opt, idx) {
                const isActive = opt.value === self._value;
                const itemEl = document.createElement('div');
                itemEl.className = 'edge-select-item flex items-center justify-between px-3 py-1.5 text-xs cursor-pointer transition-colors ' +
                    (isActive
                        ? 'bg-[var(--admin-accent-soft)] text-[var(--admin-accent-text)] font-semibold'
                        : 'text-[var(--admin-text)] hover:bg-[var(--admin-surface-hover)] font-medium');
                itemEl.setAttribute('data-value', opt.value);
                itemEl.setAttribute('data-index', String(idx));

                const textSpan = document.createElement('span');
                textSpan.className = 'truncate mr-2';
                textSpan.textContent = opt.label;
                itemEl.appendChild(textSpan);

                const checkIcon = document.createElement('span');
                checkIcon.className = 'material-symbols-outlined text-[14px] text-[var(--admin-accent-text)] shrink-0 ' + (isActive ? '' : 'invisible');
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
        }

        _initStructuredDropdown(menuId) {
            const self = this;
            const menu = document.getElementById(menuId);
            const triggerBtn = this.querySelector('[data-role="trigger"]') || this.querySelector('button');
            if (!menu || !triggerBtn) return false;
            this._menuEl = menu;
            this._triggerBtn = triggerBtn;
            this._arrowEl = triggerBtn.querySelector('.material-symbols-outlined');
            menu.classList.add('edge-select-menu');

            const inputId = this.getAttribute('data-input-id');
            const labelId = this.getAttribute('data-label-id');
            if (inputId) this._hiddenInput = document.getElementById(inputId);
            if (labelId) this._labelEl = document.getElementById(labelId);

            triggerBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (self._isOpen) {
                    self._close();
                } else {
                    self._open();
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
                    self._close();
                    self._fireChange();
                });
            });

            return true;
        }

        _initEmptyDropdown() {
            this._options = [];
        }

        _open() {
            closeAllEdgeSelects(this);
            if (!this._menuEl) return;

            if (!this._menuOriginalParent) {
                this._menuOriginalParent = this._menuEl.parentNode || this;
            }
            // Portal the menu to document.body while open so ancestor backdrop-filter or overflow rules never shift fixed viewport coordinates.
            document.body.appendChild(this._menuEl);
            this._menuEl.classList.remove('hidden', 'left-0', 'right-0', 'top-full', 'bottom-full', 'mt-1', 'mb-1');
            this._menuEl.style.position = 'fixed';
            this._menuEl.style.zIndex = '99999';
            this._menuEl.style.margin = '0';
            this._menuEl.style.overflowY = 'auto';
            this._menuEl.style.maxHeight = '';

            const anchor = this._triggerBtn || this;
            const rect = anchor.getBoundingClientRect();
            const menuWidth = Math.max(rect.width, 130);
            this._menuEl.style.minWidth = menuWidth + 'px';

            const measuredHeight = this._menuEl.offsetHeight || 160;
            const measuredWidth = Math.max(this._menuEl.offsetWidth || menuWidth, menuWidth);
            const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - 8);
            const spaceAbove = Math.max(0, rect.top - 8);
            const openUp = spaceBelow < measuredHeight && spaceAbove > spaceBelow;
            const clampedMax = Math.max(96, Math.min(measuredHeight, openUp ? spaceAbove : spaceBelow, 300));
            const clampedLeft = Math.max(8, Math.min(rect.left, window.innerWidth - measuredWidth - 8));

            this._menuEl.style.left = clampedLeft + 'px';
            this._menuEl.style.right = 'auto';
            this._menuEl.style.maxHeight = clampedMax + 'px';
            if (openUp) {
                this._menuEl.style.top = 'auto';
                this._menuEl.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
            } else {
                this._menuEl.style.bottom = 'auto';
                this._menuEl.style.top = (rect.bottom + 4) + 'px';
            }

            this._isOpen = true;
            openEdgeSelects.add(this);
            if (this._arrowEl) this._arrowEl.style.transform = 'rotate(180deg)';
        }

        _close() {
            openEdgeSelects.delete(this);
            if (this._menuEl) {
                this._menuEl.classList.add('hidden');
                this._menuEl.style.position = '';
                this._menuEl.style.left = '';
                this._menuEl.style.right = '';
                this._menuEl.style.top = '';
                this._menuEl.style.bottom = '';
                this._menuEl.style.minWidth = '';
                this._menuEl.style.maxHeight = '';
                this._menuEl.style.margin = '';
                this._menuEl.style.overflowY = '';
                this._menuEl.style.zIndex = '';
                if (this._menuOriginalParent && this._menuOriginalParent.isConnected) {
                    this._menuOriginalParent.appendChild(this._menuEl);
                }
            }
            this._isOpen = false;
            if (this._arrowEl) this._arrowEl.style.transform = '';
        }

        _updateUi() {
            if (!this._labelEl && !this._menuEl) return;
            const currentVal = this._value;
            const selectedOpt = this._options.find(function(o) { return o.value === currentVal; });
            if (selectedOpt && this._labelEl) {
                this._labelEl.textContent = selectedOpt.label;
            }
            if (this._menuEl) {
                const items = this._menuEl.querySelectorAll('.edge-select-item');
                items.forEach(function(item) {
                    const itemVal = item.getAttribute('data-value');
                    const isSelected = itemVal === currentVal;
                    const check = item.querySelector('.material-symbols-outlined');
                    if (isSelected) {
                        item.className = 'edge-select-item flex items-center justify-between px-3 py-1.5 text-xs cursor-pointer transition-colors bg-[var(--admin-accent-soft)] text-[var(--admin-accent-text)] font-semibold';
                        if (check) check.classList.remove('invisible');
                    } else {
                        item.className = 'edge-select-item flex items-center justify-between px-3 py-1.5 text-xs cursor-pointer transition-colors text-[var(--admin-text)] hover:bg-[var(--admin-surface-hover)] font-medium';
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

    if (!customElements.get('edge-select')) {
        customElements.define('edge-select', WalnutSelect);
    }
})();
