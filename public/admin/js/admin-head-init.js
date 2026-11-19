(function() {
    // Lock sidebar collapsed state before first paint to prevent initial layout jump.
    try {
        localStorage.setItem('walnut_admin_hint', '1');
        const cachedCollapsed = localStorage.getItem('walnut_sidebar_collapsed');
        const shouldCollapse = cachedCollapsed !== null ? cachedCollapsed === 'true' : (window.innerWidth < 768);
        if (shouldCollapse) {
            document.documentElement.classList.add('is-sidebar-collapsed');
        } else {
            document.documentElement.classList.remove('is-sidebar-collapsed');
        }
    } catch(e){}

    // Pre-inject persisted table column visibility rules before render to eliminate CLS reflows.
    try {
        let colsCss = '';
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('walnut_') && k.endsWith('_cols_pref')) {
                const tableKey = k.slice(7, -10);
                const tableId = tableKey + '-table';
                try {
                    const pref = JSON.parse(localStorage.getItem(k));
                    if (pref && typeof pref === 'object') {
                        for (const col in pref) {
                            if (pref[col] === false) {
                                colsCss += '#' + tableId + ' [data-col="' + col + '"] { display: none !important; }\n';
                            } else if (pref[col] === true) {
                                colsCss += '#' + tableId + ' [data-col="' + col + '"] { display: table-cell !important; }\n';
                            }
                        }
                    }
                } catch(e){}
            }
        }
        if (colsCss) {
            let styleEl = document.getElementById('walnut-cols-preload');
            if (!styleEl) {
                styleEl = document.createElement('style');
                styleEl.id = 'walnut-cols-preload';
                document.head.appendChild(styleEl);
            }
            styleEl.textContent = colsCss;
        }
    } catch(e){}
})();
