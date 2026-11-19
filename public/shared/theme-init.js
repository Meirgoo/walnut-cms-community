(function() {
    try {
        const rawSchemes = window.__WALNUT__ && Array.isArray(window.__WALNUT__.color_schemes)
            ? window.__WALNUT__.color_schemes
            : null;
        const schemes = rawSchemes && rawSchemes.length > 0 ? rawSchemes : ['light', 'dark'];
        const supportsLight = schemes.indexOf('light') !== -1;
        const supportsDark = schemes.indexOf('dark') !== -1;

        let mode = localStorage.getItem('walnut_theme_mode') || 'system';
        let isDark;
        if (supportsLight && !supportsDark) {
            mode = 'light';
            isDark = false;
        } else if (supportsDark && !supportsLight) {
            mode = 'dark';
            isDark = true;
        } else {
            isDark = mode === 'dark' || (mode === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
        }
        if (isDark) document.documentElement.classList.add('dark');
        else document.documentElement.classList.remove('dark');
        document.documentElement.setAttribute('data-theme-mode', mode);

        // Pre-inject icon visibility rules before app.css parses to prevent all three theme icons flashing on first paint.
        let styleTheme = document.getElementById('walnut-theme-icons-preload');
        if (!styleTheme && document.head) {
            styleTheme = document.createElement('style');
            styleTheme.id = 'walnut-theme-icons-preload';
            styleTheme.textContent = 'html[data-theme-mode="light"] .theme-icon-dark,html[data-theme-mode="light"] .theme-icon-system,html[data-theme-mode="dark"] .theme-icon-light,html[data-theme-mode="dark"] .theme-icon-system,html:not([data-theme-mode]) .theme-icon-light,html:not([data-theme-mode]) .theme-icon-dark,html[data-theme-mode="system"] .theme-icon-light,html[data-theme-mode="system"] .theme-icon-dark{display:none!important;}';
            document.head.appendChild(styleTheme);
        }
    } catch(e){}

    function mergeDict(target, source) {
        if (!source || typeof source !== 'object') return target;
        for (const k in source) {
            if (Object.prototype.hasOwnProperty.call(source, k)) {
                if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])) {
                    if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {};
                    mergeDict(target[k], source[k]);
                } else {
                    target[k] = source[k];
                }
            }
        }
        return target;
    }

    const i18nStore = (window.__WALNUT_I18N__ = window.__WALNUT_I18N__ || {});
    i18nStore.dict = i18nStore.dict || {};
    i18nStore.adminDict = i18nStore.adminDict || i18nStore.dict;

    function syncInlineDict(root) {
        try {
            const doc = root && root.querySelector ? root : document;
            const el = doc.querySelector ? doc.querySelector('#walnut-i18n-dict') : document.getElementById('walnut-i18n-dict');
            if (el && el.textContent) {
                const dict = JSON.parse(el.textContent);
                mergeDict(i18nStore.dict, dict);
                i18nStore.adminDict = i18nStore.dict;
            }
        } catch(e){}
    }

    syncInlineDict();
    document.addEventListener('htmx:load', function(evt) {
        syncInlineDict(evt && evt.detail && evt.detail.elt);
    });

    if (!i18nStore.t) {
        i18nStore.t = function(path, params) {
            if (!path || typeof path !== 'string') return '';
            const dict = i18nStore.dict || i18nStore.adminDict || {};
            const parts = path.split('.');
            let cur = dict;
            for (let i = 0; i < parts.length; i++) {
                if (cur && typeof cur === 'object' && parts[i] in cur) {
                    cur = cur[parts[i]];
                } else {
                    return path;
                }
            }
            if (typeof cur !== 'string') return path;
            if (params) {
                return cur.replace(/\{(\w+)\}/g, function(_, k) {
                    return params[k] !== undefined ? String(params[k]) : '{' + k + '}';
                });
            }
            return cur;
        };
    }
})();
