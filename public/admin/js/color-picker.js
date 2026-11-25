(function() {
    'use strict';

    const t = function(k, params) {
        const fn = window.__EDGE_I18N__ && window.__EDGE_I18N__.t;
        return typeof fn === 'function' ? fn(k, params) : k;
    };

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

    if (!customElements.get('edge-color-picker')) {
        customElements.define('edge-color-picker', WalnutColorPicker);
    }

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
})();
