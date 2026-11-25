(function() {
    'use strict';

    function getDeclaredSchemes() {
        const raw = window.__EDGE__ && Array.isArray(window.__EDGE__.color_schemes)
            ? window.__EDGE__.color_schemes
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
            localStorage.setItem('edge_theme_mode', isDark ? 'dark' : 'light');
        } catch(e) {}
    };

    let activeProgressHandler = null;

    function initReadingProgress() {
        if (activeProgressHandler) {
            window.removeEventListener('scroll', activeProgressHandler);
            window.removeEventListener('resize', activeProgressHandler);
            activeProgressHandler = null;
        }
        const progressBars = document.querySelectorAll('[data-edge-reading-progress], #edge-reading-progress');
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
        const pb = window.__EDGE__ && window.__EDGE__.powered_by;
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
            bar.setAttribute('data-edge-powered-by', 'fallback');
            bar.style.cssText = 'text-align:center;padding:12px 16px;font-size:12px;line-height:1.4;opacity:0.8;';
            const link = document.createElement('a');
            link.href = targetHref;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = pb.label || 'Powered by Walnut Edge CMS';
            bar.appendChild(link);
            document.body.appendChild(bar);
        }
    }

    function sanitizeExtFragment(rawHtml) {
        const tpl = document.createElement('template');
        tpl.innerHTML = String(rawHtml || '');
        tpl.content.querySelectorAll('script,iframe,object,embed,style[onload]').forEach((n) => n.remove());
        tpl.content.querySelectorAll('*').forEach((n) => {
            for (const attr of Array.from(n.attributes)) {
                const k = attr.name.toLowerCase();
                const v = attr.value.trim().toLowerCase();
                if (k.startsWith('on') || ((k === 'href' || k === 'src' || k === 'action' || k === 'formaction') && v.startsWith('javascript:'))) {
                    n.removeAttribute(attr.name);
                }
            }
        });
        return tpl.content;
    }

    function mountExtIslands() {
        const islands = document.querySelectorAll('[data-edge-ext-src]');
        if (!islands || islands.length === 0) return;
        islands.forEach((el) => {
            const state = el.getAttribute('data-edge-ext-mounted');
            if (state === '1' || state === 'loading') return;
            const src = (el.getAttribute('data-edge-ext-src') || '').trim();
            // Enforce strict same-origin /ext/ path on client before fetching.
            if (!src.startsWith('/ext/') || src.startsWith('//') || /[\s"'<>]/.test(src)) return;

            el.setAttribute('data-edge-ext-mounted', 'loading');
            const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
            const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;

            fetch(src, {
                credentials: 'same-origin',
                headers: { Accept: 'application/json, text/html;q=0.9, text/plain;q=0.8' },
                signal: ctrl ? ctrl.signal : undefined
            })
                .then(async (res) => {
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const ct = (res.headers.get('content-type') || '').toLowerCase();
                    if (ct.includes('application/json')) {
                        const data = await res.json();
                        if (data && typeof data.html === 'string') {
                            el.replaceChildren(sanitizeExtFragment(data.html));
                        } else if (data && (typeof data.text === 'string' || typeof data.message === 'string')) {
                            el.textContent = String(data.text ?? data.message);
                        }
                    } else {
                        const text = await res.text();
                        if (ct.includes('text/html') || /<[a-z][\s\S]*>/i.test(text)) {
                            el.replaceChildren(sanitizeExtFragment(text));
                        } else {
                            el.textContent = text;
                        }
                    }
                    el.setAttribute('data-edge-ext-mounted', '1');
                })
                .catch(() => {
                    el.setAttribute('data-edge-ext-mounted', 'error');
                })
                .finally(() => {
                    if (timer) clearTimeout(timer);
                });
        });
    }

    function runVisitorBoot() {
        initReadingProgress();
        ensurePoweredByVisible();
        mountExtIslands();
    }

    initBoostGuard();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runVisitorBoot);
    } else {
        runVisitorBoot();
    }
    document.addEventListener('htmx:afterSettle', runVisitorBoot);
})();
