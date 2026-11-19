(function() {
    'use strict';

    function getDeclaredSchemes() {
        const raw = window.__WALNUT__ && Array.isArray(window.__WALNUT__.color_schemes)
            ? window.__WALNUT__.color_schemes
            : null;
        return raw && raw.length > 0 ? raw : ['light', 'dark'];
    }

    window.toggleThemeMode = function() {
        const schemes = getDeclaredSchemes();
        const supportsLight = schemes.indexOf('light') !== -1;
        const supportsDark = schemes.indexOf('dark') !== -1;
        if (supportsLight && !supportsDark) {
            document.documentElement.classList.remove('dark');
            document.documentElement.setAttribute('data-theme-mode', 'light');
            return;
        }
        if (supportsDark && !supportsLight) {
            document.documentElement.classList.add('dark');
            document.documentElement.setAttribute('data-theme-mode', 'dark');
            return;
        }
        const isDark = document.documentElement.classList.toggle('dark');
        document.documentElement.setAttribute('data-theme-mode', isDark ? 'dark' : 'light');
        try {
            localStorage.setItem('walnut_theme_mode', isDark ? 'dark' : 'light');
        } catch(e) {}
    };

    let activeProgressHandler = null;

    function initReadingProgress() {
        if (activeProgressHandler) {
            window.removeEventListener('scroll', activeProgressHandler);
            window.removeEventListener('resize', activeProgressHandler);
            activeProgressHandler = null;
        }
        const progressBars = document.querySelectorAll('[data-walnut-reading-progress], #walnut-reading-progress');
        if (!progressBars || progressBars.length === 0) return;
        const updateProgress = function() {
            const winScroll = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
            const docHeight = Math.max(
                document.body.scrollHeight || 0,
                document.documentElement.scrollHeight || 0
            );
            const winHeight = window.innerHeight || document.documentElement.clientHeight || 0;
            const scrollable = docHeight - winHeight;
            const scrolled = scrollable > 0 ? Math.min(100, Math.max(0, (winScroll / scrollable) * 100)) : 0;
            const widthVal = (Number.isFinite(scrolled) ? scrolled : 0) + '%';
            progressBars.forEach(function(bar) {
                bar.style.width = widthVal;
            });
        };
        activeProgressHandler = updateProgress;
        window.addEventListener('scroll', activeProgressHandler, { passive: true });
        window.addEventListener('resize', activeProgressHandler, { passive: true });
        updateProgress();
    }

    function initBoostGuard() {
        document.addEventListener('click', function(e) {
            const a = e.target && e.target.closest ? e.target.closest('a') : null;
            if (a && a.getAttribute) {
                const href = a.getAttribute('href') || '';
                if (href.startsWith('/admin')) {
                    a.setAttribute('hx-boost', 'false');
                }
            }
        }, true);
    }

    function isElementVisible(el) {
        if (!el || !el.isConnected) return false;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        let curr = el;
        while (curr && curr.nodeType === 1) {
            const cs = window.getComputedStyle(curr);
            if (!cs) break;
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
            if (parseFloat(cs.opacity) <= 0) return false;
            if (curr === el && parseFloat(cs.fontSize) <= 0) return false;
            curr = curr.parentElement;
        }
        return true;
    }

    function ensurePoweredByVisible() {
        const pb = window.__WALNUT__ && window.__WALNUT__.powered_by;
        if (!pb || pb.enabled !== true || !pb.url || !document.body) return;

        const targetHref = String(pb.url).trim();
        const normalizeUrl = (u) => String(u || '').replace(/\/+$/, '');
        const expectedNorm = normalizeUrl(targetHref);
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        const hasVisibleLink = anchors.some((a) => {
            const rawHref = a.getAttribute('href') || '';
            const matches = rawHref === targetHref || normalizeUrl(rawHref) === expectedNorm || normalizeUrl(a.href) === expectedNorm;
            return matches && isElementVisible(a);
        });

        if (!hasVisibleLink) {
            const bar = document.createElement('div');
            bar.setAttribute('data-walnut-powered-by', 'fallback');
            bar.style.cssText = 'text-align:center;padding:12px 16px;font-size:12px;line-height:1.4;opacity:0.8;';
            const link = document.createElement('a');
            link.href = targetHref;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = pb.label || 'Powered by Walnut CMS';
            bar.appendChild(link);
            document.body.appendChild(bar);
        }
    }

    function runVisitorBoot() {
        initReadingProgress();
        ensurePoweredByVisible();
    }

    initBoostGuard();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runVisitorBoot);
    } else {
        runVisitorBoot();
    }
    document.addEventListener('htmx:afterSettle', runVisitorBoot);
})();
