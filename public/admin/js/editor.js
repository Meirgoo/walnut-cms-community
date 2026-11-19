(function() {
    'use strict';

    const t = function(k, params) {
        const fn = window.__WALNUT_I18N__ && window.__WALNUT_I18N__.t;
        return typeof fn === 'function' ? fn(k, params) : k;
    };

    (window.__WALNUT_RUNTIME__ = window.__WALNUT_RUNTIME__ || {}).vcsVersionsMap = (function() {
        try {
            const el = document.getElementById('vcs-versions-data');
            return el ? JSON.parse(el.textContent || '{}') : {};
        } catch (e) {
            return {};
        }
    })();

    let currentTags = (function () {
        try {
            const el = document.getElementById('article-tags-data');
            return el ? JSON.parse(el.textContent || '[]') : [];
        } catch (e) {
            return [];
        }
    })();

    window.toggleEditorSidebar = function() {
        const sidebar = document.getElementById('editor-inspector-sidebar');
        const icon = document.getElementById('editor-sidebar-toggle-icon');
        if (!sidebar) return;
        if (sidebar.classList.contains('hidden')) {
            sidebar.classList.remove('hidden');
            if (icon) icon.innerText = 'dock_to_right';
            localStorage.setItem('walnut_editor_sidebar_collapsed', 'false');
        } else {
            sidebar.classList.add('hidden');
            if (icon) icon.innerText = 'view_sidebar';
            localStorage.setItem('walnut_editor_sidebar_collapsed', 'true');
        }
    };

    function initEditorSidebar() {
        const isCollapsed = localStorage.getItem('walnut_editor_sidebar_collapsed') === 'true';
        const sidebar = document.getElementById('editor-inspector-sidebar');
        const icon = document.getElementById('editor-sidebar-toggle-icon');
        if (isCollapsed && sidebar) {
            sidebar.classList.add('hidden');
            if (icon) icon.innerText = 'view_sidebar';
        }
    }

    const ALL_SECTIONS = ['meta', 'seo', 'wiki', 'publish'];

    window.openSingleAccordion = function(targetKey) {
        const targetContent = document.getElementById('accordion-content-' + targetKey);
        const targetArrow = document.getElementById('accordion-arrow-' + targetKey);
        const isCurrentlyOpen = targetContent && !targetContent.classList.contains('hidden');

        for (let i = 0; i < ALL_SECTIONS.length; i++) {
            const k = ALL_SECTIONS[i];
            const c = document.getElementById('accordion-content-' + k);
            const a = document.getElementById('accordion-arrow-' + k);
            if (c) c.classList.add('hidden');
            if (a) a.classList.add('-rotate-90');
        }

        if (!isCurrentlyOpen && targetContent) {
            targetContent.classList.remove('hidden');
            if (targetArrow) targetArrow.classList.remove('-rotate-90');
        }
    };

    const ALL_CUSTOM_DROPDOWNS = ['type', 'template', 'locale', 'schema', 'maturity'];

    window.toggleCustomDropdown = function(dropdownKey) {
        const targetMenu = document.getElementById('dropdown-menu-' + dropdownKey);
        if (!targetMenu) return;
        const isHidden = targetMenu.classList.contains('hidden');

        document.querySelectorAll('.walnut-select-menu:not(.hidden)').forEach(function(m) {
            if (m !== targetMenu) m.classList.add('hidden');
        });

        if (isHidden) {
            targetMenu.classList.remove('hidden');
        } else {
            targetMenu.classList.add('hidden');
        }
    };

    document.addEventListener('click', function(e) {
        for (let i = 0; i < ALL_CUSTOM_DROPDOWNS.length; i++) {
            const k = ALL_CUSTOM_DROPDOWNS[i];
            const box = document.getElementById('dropdown-box-' + k);
            const menu = document.getElementById('dropdown-menu-' + k);
            if (box && !box.contains(e.target)) {
                if (menu) menu.classList.add('hidden');
            }
        }
    });

    window.selectTemplateOption = function(id, slug, label) {
        const hiddenIdInput = document.getElementById('form-template-id-input');
        const hiddenSlugInput = document.getElementById('form-template-slug-input');
        const labelElem = document.getElementById('template-selected-label');

        if (hiddenIdInput) hiddenIdInput.value = id || '';
        if (hiddenSlugInput) hiddenSlugInput.value = slug || '';
        if (labelElem) labelElem.innerText = label;

        const menu = document.getElementById('dropdown-menu-template');
        if (menu) menu.classList.add('hidden');
    };

    window.selectTypeOption = function(val, label, icon) {
        const hiddenInput = document.getElementById('form-type-input');
        const labelElem = document.getElementById('type-selected-label');
        const iconElem = document.getElementById('type-selected-icon');
        const badgeElem = document.getElementById('type-badge');

        if (hiddenInput) hiddenInput.value = val;
        if (labelElem) labelElem.innerText = label;
        if (iconElem) iconElem.innerText = icon;
        if (badgeElem) badgeElem.innerText = val.toUpperCase();

        const menu = document.getElementById('dropdown-menu-type');
        if (menu) menu.classList.add('hidden');
        handleNodeTypeChange(val);
    };

    window.selectLocaleOption = function(val, label) {
        const hiddenInput = document.getElementById('form-locale-input');
        const labelElem = document.getElementById('locale-selected-label');
        const customInput = document.getElementById('custom-locale-input');

        if (hiddenInput) hiddenInput.value = val;
        if (labelElem) labelElem.innerText = label;

        if (val === '__custom__') {
            if (customInput) {
                customInput.classList.remove('hidden');
                customInput.focus();
            }
        } else {
            if (customInput) customInput.classList.add('hidden');
        }

        const menu = document.getElementById('dropdown-menu-locale');
        if (menu) menu.classList.add('hidden');
    };

    window.selectSchemaOption = function(val, label) {
        const hiddenInput = document.getElementById('form-schema-input');
        const labelElem = document.getElementById('schema-selected-label');

        if (hiddenInput) hiddenInput.value = val;
        if (labelElem) labelElem.innerText = label;

        const menu = document.getElementById('dropdown-menu-schema');
        if (menu) menu.classList.add('hidden');
        switchSchemaTemplate(val);
    };

    window.selectMaturityOption = function(val, label) {
        const hiddenInput = document.getElementById('form-maturity-input');
        const labelElem = document.getElementById('maturity-selected-label');

        if (hiddenInput) hiddenInput.value = val;
        if (labelElem) labelElem.innerText = label;

        const menu = document.getElementById('dropdown-menu-maturity');
        if (menu) menu.classList.add('hidden');
    };

    function getTypeHint(typeKey) {
        if (!window.__WALNUT_I18N__?.t) return '';
        const map = {
            article: t('editor.type_article'),
            note: t('editor.type_note'),
            memo: t('editor.type_note')
        };
        return map[typeKey] || '';
    }

    function handleNodeTypeChange(newType) {
        const hint = document.getElementById('type-hint');
        const clipBox = document.getElementById('field-box-clip-url');
        const slugStar = document.getElementById('slug-required-star');

        if (hint) hint.innerText = getTypeHint(newType);

        if (clipBox) {
            clipBox.classList.add('hidden');
        }

        if (newType === 'note' || newType === 'memo') {
            if (slugStar) slugStar.innerText = t('common.optional_mark') || '';
        } else {
            if (slugStar) slugStar.innerText = '*';
        }
    }

    window.renderTagChips = function() {
        const container = document.getElementById('tag-chips-container');
        const hiddenInput = document.getElementById('form-tags-input');
        if (hiddenInput) hiddenInput.value = currentTags.join(',');

        if (!container) return;
        container.innerHTML = '';
        for (let i = 0; i < currentTags.length; i++) {
            const tag = currentTags[i];
            const chip = document.createElement('span');
            chip.className = 'inline-flex items-center space-x-1 bg-emerald-50 text-emerald-700 border border-emerald-200 px-2.5 py-0.5 rounded-lg text-xs font-bold';

            const label = document.createElement('span');
            label.textContent = '#' + tag;

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'hover:text-red-600 text-emerald-500 font-bold ml-1 cursor-pointer';
            delBtn.textContent = '×';
            (function(t) {
                delBtn.onclick = function() { window.removeTagChip(t); };
            })(tag);

            chip.appendChild(label);
            chip.appendChild(delBtn);
            container.appendChild(chip);
        }
    };

    window.handleTagInputKey = function(e) {
        if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
            e.preventDefault();
            const val = e.target.value.replace(/,/g, '').replace(/，/g, '').trim();
            if (val && currentTags.indexOf(val) === -1) {
                currentTags.push(val);
                window.renderTagChips();
            }
            e.target.value = '';
        }
    };

    window.removeTagChip = function(tag) {
        const next = [];
        for (let i = 0; i < currentTags.length; i++) {
            if (currentTags[i] !== tag) next.push(currentTags[i]);
        }
        currentTags = next;
        window.renderTagChips();
    };

    window.toggleTransGroupDropdown = function() {
        const menu = document.getElementById('trans-group-dropdown-menu');
        if (menu) menu.classList.toggle('hidden');
    };

    window.selectTransGroup = function(groupId, groupName) {
        const input = document.getElementById('form-translation-group-id');
        const label = document.getElementById('trans-group-current-label');
        if (input) input.value = groupId;
        if (label) label.innerText = groupName;
        const menu = document.getElementById('trans-group-dropdown-menu');
        if (menu) menu.classList.add('hidden');
        if (window.showToast) window.showToast(t('articles.col_trans_group') + ': ' + groupName, 'info');
    };

    window.createNewTransGroup = async function() {
        const input = document.getElementById('new-trans-group-name');
        const name = input ? input.value.trim() : '';
        if (!name) return;
        try {
            const res = await fetch('/admin/articles/api/translation-groups/create', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: 'name=' + encodeURIComponent(name)
            });
            const data = await res.json();
            if (data.success && data.group) {
                window.selectTransGroup(data.group.id, data.group.name);
                if (input) input.value = '';
                if (window.showToast) window.showToast(t('common.success') + ': ' + data.group.name, 'success');
            }
        } catch(e) {
            if (window.showToast) window.showToast(t('common.error'), 'error');
        }
    };

    window.deleteTransGroup = async function(groupId) {
        const doDelete = async function () {
            try {
                await fetch('/admin/articles/api/translation-groups/delete/' + groupId, {method: 'DELETE'});
                const input = document.getElementById('form-translation-group-id');
                if (input && input.value === groupId) {
                    window.selectTransGroup('', t('editor.trans_group_not_joined'));
                }
                const item = document.getElementById('trans-group-item-' + groupId);
                if (item) item.remove();
                if (window.showToast) window.showToast(t('common.success'), 'success');
            } catch (e) {
            }
        };
        if (window.showConfirmDialog) {
            window.showConfirmDialog({ title: t('editor.delete_trans_group'), message: t('common.prompt_confirm'), onConfirm: doDelete });
        } else {
            doDelete();
        }
    };

    window.leaveTransGroup = function() {
        window.selectTransGroup('', t('editor.trans_group_not_joined'));
    };

    window.updateWikiOutgoingLinks = function() {
        const editor = document.getElementById('editor-core');
        if (!editor) return;
        const text = editor.value || '';
        const wikiRegex = new RegExp('\\[\\[([^\\]|]+)(?:\\|[^\\]]+)?\\]\\]', 'g');
        const matches = Array.from(text.matchAll(wikiRegex));
        const uniqueTargets = [];
        for (let i = 0; i < matches.length; i++) {
            const m = matches[i][1].trim();
            if (m && uniqueTargets.indexOf(m) === -1) uniqueTargets.push(m);
        }

        const countBadge = document.getElementById('wiki-outgoing-count');
        const listElem = document.getElementById('wiki-outgoing-list');
        if (countBadge) countBadge.innerText = t('editor.outgoing_count_tag', { count: uniqueTargets.length }) || String(uniqueTargets.length);

        if (listElem) {
            listElem.innerHTML = '';
            if (uniqueTargets.length === 0) {
                const emptySpan = document.createElement('span');
                emptySpan.className = 'text-slate-400 text-[11px]';
                const tipMsg = document.getElementById('msg-no-outgoing-links');
                emptySpan.textContent = tipMsg ? tipMsg.value : (t('editor.no_outgoing_links') || '');
                listElem.appendChild(emptySpan);
            } else {
                for (let j = 0; j < uniqueTargets.length; j++) {
                    const target = uniqueTargets[j];
                    const item = document.createElement('div');
                    item.className = 'flex items-center space-x-1 text-emerald-700 font-bold py-0.5';

                    const icon = document.createElement('span');
                    icon.className = 'material-symbols-outlined text-[14px]';
                    icon.textContent = 'link';

                    const txt = document.createElement('span');
                    txt.textContent = '[[' + target + ']]';

                    item.appendChild(icon);
                    item.appendChild(txt);
                    listElem.appendChild(item);
                }
            }
        }
    };

    window.insertWikiLink = function(target) {
        window.insertFormat('[[' + target + ']]');
        window.updateWikiOutgoingLinks();
    };

    window.autoExtractTdk = function() {
        const editor = document.getElementById('editor-core');
        const titleInput = document.getElementById('article-title-input');
        const summaryInput = document.getElementById('summary-input');
        const keywordsInput = document.querySelector('input[name="meta_keywords"]');

        const raw = editor ? editor.value.trim() : '';
        if (!raw) {
            if (window.showToast) window.showToast(t('editor.placeholder_content'), 'warning');
            return;
        }

        if (titleInput && !titleInput.value.trim()) {
            const hMatch = raw.match(/^#{1,3}\s+(.+)$/m);
            if (hMatch) {
                titleInput.value = hMatch[1].replace(/[*`_]/g, '').trim();
            } else {
                const firstLine = raw.split('\n')[0].replace(/[*`_#]/g, '').trim();
                if (firstLine) titleInput.value = firstLine.slice(0, 30);
            }
        }

        if (summaryInput) {
            const cleanedText = raw
                .replace(/^#{1,6}\s+.*$/gm, '')
                .replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, '$1')
                .replace(/!\[.*?\]\(.*?\)/g, '')
                .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                .replace(/`{3}[\s\S]*?`{3}/g, '')
                .replace(/`([^`]+)`/g, '$1')
                .replace(/[*_~>#-]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            if (cleanedText) {
                summaryInput.value = cleanedText.length > 160 ? cleanedText.slice(0, 160) + '...' : cleanedText;
            }
        }

        if (keywordsInput && !keywordsInput.value.trim()) {
            const tagMatches = Array.from(raw.matchAll(/#([a-zA-Z0-9_\u4e00-\u9fa5-]+)/g));
            if (tagMatches.length > 0) {
                const uniqueTags = Array.from(new Set(tagMatches.map(function (m) {
                    return m[1].trim();
                })));
                keywordsInput.value = uniqueTags.join(', ');
            }
        }

        if (window.showToast) window.showToast('✨ ' + t('editor.auto_extract_tdk'), 'success');
    };

    let cachedThemeMdComps = null;
    function getThemeMdComps() {
        if (cachedThemeMdComps !== null) return cachedThemeMdComps;
        cachedThemeMdComps = {};
        const el = document.getElementById('theme-md-components-data');
        if (el && el.textContent) {
            try { cachedThemeMdComps = JSON.parse(el.textContent) || {}; } catch (_) {}
        }
        return cachedThemeMdComps;
    }

    const FALLBACK_MD_STYLES = {
        callout: '<div class="my-4 p-4 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 text-sm text-slate-700 dark:text-slate-200"><div class="font-bold text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">CALLOUT</div><div>{{content}}</div></div>',
        tip: '<div class="my-4 p-4 rounded-xl border border-emerald-200 dark:border-emerald-800/80 bg-emerald-50/70 dark:bg-emerald-950/40 text-sm text-emerald-900 dark:text-emerald-200"><div class="font-bold text-xs uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-1">TIP</div><div>{{content}}</div></div>',
        warning: '<div class="my-4 p-4 rounded-xl border border-amber-200 dark:border-amber-800/80 bg-amber-50/70 dark:bg-amber-950/40 text-sm text-amber-900 dark:text-amber-200"><div class="font-bold text-xs uppercase tracking-wider text-amber-600 dark:text-amber-400 mb-1">WARNING</div><div>{{content}}</div></div>',
        quote: '<blockquote class="my-4 pl-4 py-2 border-l-4 border-emerald-500 bg-slate-50/60 dark:bg-slate-800/40 rounded-r-xl italic text-slate-700 dark:text-slate-300">{{content}}</blockquote>',
        step: '<div class="my-4 pl-4 py-2 border-l-2 border-indigo-500 bg-indigo-50/40 dark:bg-indigo-950/30 rounded-r-xl text-sm text-slate-800 dark:text-slate-200">{{content}}</div>'
    };

    function escWikiText(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderWikiLinks(html) {
        var protectedTokens = [];
        var stash = function(m) {
            var idx = protectedTokens.length;
            protectedTokens.push(m);
            return '\x00EDHTML' + idx + '\x00';
        };
        // Protect <pre>, <code>, existing <a> links, and raw HTML tags so code examples and attributes keep literal [[slug]].
        var protectedStr = String(html || '')
            .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, stash)
            .replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, stash)
            .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, stash)
            .replace(/<[^>]+>/g, stash);
        protectedStr = protectedStr
            .replace(/\[\[([^\[\]\n|]+)\|([^\[\]\n]+)\]\]/g, function(_, slug, label) {
                var cleanSlug = String(slug || '').trim().replace(/^\/+/, '');
                return '<a href="/' + escWikiText(cleanSlug) + '" class="text-emerald-600 dark:text-emerald-400 font-semibold hover:underline">' + escWikiText(label.trim()) + '</a>';
            })
            .replace(/\[\[([^\[\]\n:：]+)\]\]/g, function(_, slug) {
                var cleanSlug = String(slug || '').trim().replace(/^\/+/, '');
                return '<a href="/' + escWikiText(cleanSlug) + '" class="text-emerald-600 dark:text-emerald-400 font-semibold hover:underline">' + escWikiText(slug.trim()) + '</a>';
            });
        return protectedStr.replace(/\x00EDHTML(\d+)\x00/g, function(_, idx) {
            return protectedTokens[Number(idx)] || '';
        });
    }

    function renderCustomMarkdownPreview(rawMd) {
        if (!rawMd || !window.marked) return '';
        const themeComps = getThemeMdComps();
        const getTpl = function(tag) {
            const k = String(tag || '').toLowerCase();
            return themeComps[tag] || themeComps[k] || FALLBACK_MD_STYLES[k] || '';
        };
        const placeholders = [];
        const makeBlock = function(tag, inner) {
            const tpl = getTpl(tag);
            if (!tpl) return null;
            const parsedInner = window.marked.parse(String(inner || '').trim()).replace(/^<p[^>]*>([\s\S]*)<\/p>\s*$/i, '$1');
            const innerHtml = renderWikiLinks(parsedInner);
            const rendered = tpl.replace(/\{\{\{?\s*content\s*\}?\}\}/g, function() { return innerHtml; });
            const idx = placeholders.length;
            placeholders.push(rendered);
            return '\n\nWALNUTPREVIEWMD' + idx + 'TOKEN\n\n';
        };

        let processed = String(rawMd);
        const allTags = Array.from(new Set(Object.keys(FALLBACK_MD_STYLES).concat(Object.keys(themeComps).map(function(k) { return k.toLowerCase(); }))));
        if (allTags.length > 0) {
            const escTags = allTags.map(function(t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|');
            const htmlTagRe = new RegExp('<(' + escTags + ')\\b[^>]*>([\\s\\S]*?)<\\/\\1>', 'gi');
            processed = processed.replace(htmlTagRe, function(m, tag, inner) {
                return makeBlock(tag, inner) || m;
            });
            const fenceRe = new RegExp(':::(' + escTags + ')(?:[ \\t]+[^\\n]*)?\\r?\\n([\\s\\S]*?)\\r?\\n:::', 'gi');
            processed = processed.replace(fenceRe, function(m, tag, inner) {
                return makeBlock(tag, inner) || m;
            });
        }

        // Track bracket depth so nested [[wiki]] links inside [[tag: ...]] blocks do not terminate the outer block prematurely.
        const prefixRe = /\[\[([a-zA-Z0-9_\u4e00-\u9fa5-]+)\s*[:：]\s*/g;
        let match;
        let lastIdx = 0;
        let out = '';
        while ((match = prefixRe.exec(processed)) !== null) {
            const tag = match[1];
            if (!getTpl(tag)) continue;
            const startIdx = match.index;
            const contentStart = startIdx + match[0].length;
            let depth = 0;
            let closeIdx = -1;
            for (let i = contentStart; i < processed.length - 1; i++) {
                if (processed[i] === '[' && processed[i + 1] === '[') { depth++; i++; }
                else if (processed[i] === ']' && processed[i + 1] === ']') {
                    if (depth > 0) { depth--; i++; }
                    else { closeIdx = i; break; }
                }
            }
            if (closeIdx !== -1) {
                out += processed.slice(lastIdx, startIdx);
                const tok = makeBlock(tag, processed.slice(contentStart, closeIdx));
                out += tok || processed.slice(startIdx, closeIdx + 2);
                lastIdx = closeIdx + 2;
                prefixRe.lastIndex = lastIdx;
            }
        }
        out += processed.slice(lastIdx);

        let html = renderWikiLinks(window.marked.parse(out));
        placeholders.forEach(function(compHtml, idx) {
            const tokRe = new RegExp('<p[^>]*>\\s*WALNUTPREVIEWMD' + idx + 'TOKEN\\s*</p>|WALNUTPREVIEWMD' + idx + 'TOKEN', 'g');
            html = html.replace(tokRe, function() { return compHtml; });
        });
        return html;
    }

    window.updatePreview = function() {
        const editor = document.getElementById('editor-core');
        const preview = document.getElementById('preview-core');
        if (editor && preview && window.marked) {
            preview.innerHTML = renderCustomMarkdownPreview(editor.value || '');
            window.updateWikiOutgoingLinks();
        }
    };

    const ARTICLE_FORBIDDEN_PREFIX_KEYS = {
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

    const ARTICLE_FORBIDDEN_EXACT_KEYS = {
        '/sitemap.xml': { key: 'common.route_forbidden_sitemap' },
        '/robots.txt': { key: 'common.route_forbidden_robots' },
        '/favicon.ico': { key: 'common.route_forbidden_favicon' },
        '/app.css': { key: 'common.route_forbidden_appcss' },
        '/zh-cn': { key: 'common.route_forbidden_locale', params: { path: '/zh-CN' } },
        '/en-us': { key: 'common.route_forbidden_locale', params: { path: '/en-US' } }
    };

    function sanitizeSlug(raw) {
        if (!raw) return '';
        const trimmed = String(raw).trim();
        if (trimmed === '/' || trimmed.replace(/\/+/g, '/') === '/' || trimmed.toLowerCase() === 'index') {
            return '/';
        }
        const parts = trimmed.toLowerCase().split('/');
        const clean = [];
        for (let i = 0; i < parts.length; i++) {
            if (parts[i]) clean.push(parts[i]);
        }
        return clean.join('/');
    }

    function trArticleRouteMsg(key, params) {
        if (typeof window.__WALNUT_I18N__?.t === 'function') {
            return t(key, params);
        }
        return key;
    }

    function inspectArticleSpecialSlug(rawVal) {
        const trimmed = (rawVal || '').trim();
        if (!trimmed) return { level: 'none', message: '' };
        const clean = sanitizeSlug(trimmed);
        const fullPath = clean === '/' ? '/' : ('/' + clean);
        const lowerPath = fullPath.toLowerCase();
        const firstSeg = lowerPath.replace(/^\/+/, '').split('/')[0] || '';

        if (ARTICLE_FORBIDDEN_EXACT_KEYS[lowerPath]) {
            const rule = ARTICLE_FORBIDDEN_EXACT_KEYS[lowerPath];
            return { level: 'forbidden', message: trArticleRouteMsg(rule.key, rule.params) };
        }
        if (firstSeg && ARTICLE_FORBIDDEN_PREFIX_KEYS[firstSeg]) {
            return { level: 'forbidden', message: trArticleRouteMsg(ARTICLE_FORBIDDEN_PREFIX_KEYS[firstSeg]) };
        }
        if (lowerPath === '/') {
            const isRawIndex = trimmed.replace(/^\/+|\/+$/g, '').toLowerCase() === 'index';
            return {
                level: 'warning',
                message: isRawIndex
                    ? trArticleRouteMsg('common.route_warn_home_index')
                    : trArticleRouteMsg('common.route_warn_home_root')
            };
        }
        if (lowerPath === '/404') {
            return {
                level: 'warning',
                message: trArticleRouteMsg('common.route_warn_404')
            };
        }
        if (lowerPath === '/500') {
            return {
                level: 'warning',
                message: trArticleRouteMsg('common.route_warn_500')
            };
        }
        if (lowerPath === '/503' || lowerPath === '/maintenance') {
            return {
                level: 'warning',
                message: trArticleRouteMsg('common.route_warn_503', { path: fullPath })
            };
        }
        return { level: 'none', message: '' };
    }

    function updateArticleSlugHint(rawVal) {
        const hintEl = document.getElementById('article-slug-special-hint');
        const slugInput = document.getElementById('slug-input');
        if (!hintEl) return;

        const check = inspectArticleSpecialSlug(rawVal);
        if (check.level === 'none') {
            hintEl.className = 'hidden text-[11px] px-2.5 py-2 rounded-lg border font-medium leading-relaxed';
            hintEl.textContent = '';
            if (slugInput) {
                slugInput.classList.remove('border-red-500', 'dark:border-red-500', 'border-amber-400', 'dark:border-amber-500');
            }
        } else if (check.level === 'forbidden') {
            hintEl.className = 'text-[11px] px-2.5 py-2 rounded-lg border font-bold leading-relaxed bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/80';
            hintEl.textContent = check.message;
            if (slugInput) {
                slugInput.classList.remove('border-amber-400', 'dark:border-amber-500');
                slugInput.classList.add('border-red-500', 'dark:border-red-500');
            }
        } else if (check.level === 'warning') {
            hintEl.className = 'text-[11px] px-2.5 py-2 rounded-lg border font-semibold leading-relaxed bg-amber-50 dark:bg-amber-950/50 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800/80';
            hintEl.textContent = check.message;
            if (slugInput) {
                slugInput.classList.remove('border-red-500', 'dark:border-red-500');
                slugInput.classList.add('border-amber-400', 'dark:border-amber-500');
            }
        }
    }

    let previewDebounceTimer = null;

    function schedulePreview() {
        if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
        previewDebounceTimer = setTimeout(window.updatePreview, 100);
    }

    function highlightInvalidField(inputElem, message, accordionKey) {
        if (!inputElem) return;
        if (accordionKey) window.openSingleAccordion(accordionKey);
        inputElem.classList.add('ring-2', 'ring-red-500', 'border-red-500', 'bg-red-50/20');
        inputElem.focus();
        if (window.showToast) window.showToast(message, 'warning');
        inputElem.addEventListener('input', function() {
            inputElem.classList.remove('ring-2', 'ring-red-500', 'border-red-500', 'bg-red-50/20');
        }, { once: true });
    }

    window.submitWithStatus = async function(statusValue) {
        statusValue = statusValue || 'published';
        const form = document.getElementById('article-edit-form');
        if (!form) return;

        const publishBtn = document.getElementById('publish-main-btn');
        const typeInput = document.getElementById('form-type-input');
        const titleInput = document.getElementById('article-title-input');
        const editor = document.getElementById('editor-core');
        const slugInput = document.getElementById('slug-input');
        const summaryInput = document.getElementById('summary-input');
        const clipUrlInput = document.getElementById('clip-url-input');

        const selectedType = typeInput ? typeInput.value : 'article';
        const titleVal = titleInput ? titleInput.value.trim() : '';
        const contentVal = editor ? editor.value.trim() : '';
        const slugVal = slugInput ? sanitizeSlug(slugInput.value) : '';

        if (selectedType === 'clip' && clipUrlInput && !clipUrlInput.value.trim()) {
            highlightInvalidField(clipUrlInput, '⚠️ ' + t('editor.field_source_url'), 'meta');
            return;
        }

        if (selectedType === 'article') {
            if (!titleVal) {
                highlightInvalidField(titleInput, '⚠️ ' + t('editor.field_title'), null);
                return;
            }
            if (!slugVal) {
                highlightInvalidField(slugInput, '⚠️ ' + t('editor.field_slug'), 'meta');
                return;
            }
            const specialCheck = inspectArticleSpecialSlug(slugInput ? slugInput.value : slugVal);
            if (specialCheck.level === 'forbidden') {
                updateArticleSlugHint(slugInput ? slugInput.value : slugVal);
                highlightInvalidField(slugInput, specialCheck.message, 'meta');
                return;
            }
            if (!contentVal) {
                highlightInvalidField(editor, '⚠️ ' + t('editor.placeholder_content'), null);
                return;
            }
        } else if (selectedType === 'topic') {
            if (!titleVal) {
                highlightInvalidField(titleInput, '⚠️ ' + t('editor.field_title'), null);
                return;
            }
            if (summaryInput && !summaryInput.value.trim()) {
                highlightInvalidField(summaryInput, '⚠️ ' + t('editor.field_summary'), 'seo');
                return;
            }
        } else if (selectedType === 'clip') {
            if (!titleVal) {
                highlightInvalidField(titleInput, '⚠️ ' + t('editor.field_title'), null);
                return;
            }
        } else if (selectedType === 'note' || selectedType === 'memo') {
            if (!contentVal) {
                highlightInvalidField(editor, '⚠️ ' + t('editor.placeholder_content'), null);
                return;
            }
            if (!titleVal && titleInput) {
                const lines = contentVal.split('\n');
                const firstLine = lines.length > 0 ? lines[0].replace(/#/g, '').replace(/\*/g, '').trim() : '';
                titleInput.value = firstLine.slice(0, 20) || t('editor.type_note');
            }
        } else if (selectedType === 'log') {
            if (!contentVal) {
                highlightInvalidField(editor, '⚠️ ' + t('editor.placeholder_content'), null);
                return;
            }
            if (!titleVal && titleInput) {
                titleInput.value = t('editor.type_log') + ' ' + new Date().toLocaleDateString();
            }
        }

        if (slugInput) slugInput.value = slugVal;
        const statusInput = document.getElementById('form-status-input');
        if (statusInput) statusInput.value = statusValue;

        const fd = new FormData(form);

        if (publishBtn) {
            publishBtn.disabled = true;
            publishBtn.style.opacity = '0.7';
        }

        try {
            const rawContent = editor ? editor.value : '';
            if (selectedType === 'article' && typeof window.walnutSaveLongArticleChunks === 'function' && new Blob([rawContent]).size > 50 * 1024) {
                const tagsRaw = String(fd.get('meta_tags') || '').trim();
                const chunkMeta = {};
                if (tagsRaw) {
                    chunkMeta.tags = chunkMeta.keywords = tagsRaw.split(',').map(s => s.trim()).filter(Boolean);
                }
                const ogImg = String(fd.get('meta_og_image') || '').trim();
                if (ogImg) chunkMeta.og_image = ogImg;
                const tplId = String(fd.get('meta_template_page_id') || '').trim();
                if (tplId) { chunkMeta.template_page_id = tplId; chunkMeta.template_id = tplId; }
                const res = await window.walnutSaveLongArticleChunks({
                    id: String(fd.get('id') || ''),
                    title: String(fd.get('title') || ''),
                    slug: String(fd.get('slug') || ''),
                    summary: String(fd.get('summary') || ''),
                    locale: String(fd.get('locale') || 'zh-CN'),
                    status: statusValue,
                    maturity: String(fd.get('progress') || fd.get('maturity') || 'none'),
                    translationGroupId: String(fd.get('translation_group_id') || '') || null,
                    metadata: chunkMeta,
                    contentRaw: rawContent
                });
                if (window.showToast) window.showToast(t('common.success'), 'success');
                if (!fd.get('id') && res && res.id) {
                    window.location.href = '/admin/articles/edit/' + res.id;
                }
                if (publishBtn) {
                    publishBtn.disabled = false;
                    publishBtn.style.opacity = '1';
                }
                return;
            }

            const res = await fetch('/admin/articles/api/save', {
                method: 'POST',
                headers: {'Accept': 'application/json'},
                body: fd
            });

            const data = await res.json();

            if (res.ok && data.success) {
                if (data.unchanged) {
                    window.showToast('ℹ️ ' + t('editor.no_changes_detected'), 'warning');
                } else if (data.isNew) {
                    window.showToast(t('articles.save_success_redirect'), 'success');
                    setTimeout(function() {
                        window.location.href = data.redirectUrl || '/admin/articles';
                    }, 400);
                } else {
                    window.showToast(data.message || t('articles.save_success_version', { version: data.versionNumber || '1' }), 'success');
                    const vcsBadge = document.getElementById('vcs-versions-count');
                    if (vcsBadge && data.versionNumber) {
                        vcsBadge.innerText = t('editor.versions_count', { count: data.versionNumber });
                    }
                }
            } else {
                window.showToast(t('articles.save_rejected', { reason: data.error || '' }), 'error');
            }
        } catch (err) {
            console.error('[Editor]', err);
            window.showToast('❌ ' + t('common.network_error'), 'error');
        } finally {
            if (publishBtn) {
                publishBtn.disabled = false;
                publishBtn.style.opacity = '1';
            }
        }
    };

    window.insertFormat = function(startTag, endTag) {
        const editor = document.getElementById('editor-core');
        if (!editor) return;
        const end = endTag || '';
        const start = editor.selectionStart;
        const endPos = editor.selectionEnd;
        const selectedText = editor.value.substring(start, endPos);
        const replacement = startTag + selectedText + end;
        editor.value = editor.value.substring(0, start) + replacement + editor.value.substring(endPos);
        editor.focus();
        editor.setSelectionRange(start + startTag.length, endPos + startTag.length);
        schedulePreview();
    };

    window.insertHeading = function(prefix) {
        const editor = document.getElementById('editor-core');
        if (!editor) return;
        const start = editor.selectionStart;
        editor.value = editor.value.substring(0, start) + prefix + editor.value.substring(start);
        editor.focus();
        schedulePreview();
    };

    window.insertTable = function() {
        const editor = document.getElementById('editor-core');
        if (!editor) return;
        const tableMarkdown = '\n| Col 1 | Col 2 | Col 3 |\n| --- | --- | --- |\n| Data 1 | Data 2 | Data 3 |\n';
        window.insertFormat(tableMarkdown);
    };

    window.inspectVersionById = function(versionId, vNum) {
        const content = window.__WALNUT_RUNTIME__?.vcsVersionsMap ? window.__WALNUT_RUNTIME__?.vcsVersionsMap[versionId] : '';
        const preview = document.getElementById('preview-core');
        const diffBanner = document.getElementById('vcs-diff-banner');
        const diffLabel = document.getElementById('vcs-diff-label');

        if (!preview || !window.marked) return;
        preview.innerHTML = renderCustomMarkdownPreview(content || '');
        if (diffBanner && diffLabel) {
            diffLabel.innerText = t('editor.viewing_snapshot', { version: vNum });
            diffBanner.classList.remove('hidden');
        }
    };

    window.returnToLiveEdit = function() {
        const diffBanner = document.getElementById('vcs-diff-banner');
        if (diffBanner) diffBanner.classList.add('hidden');
        window.updatePreview();
    };

    window.rollbackToVersionById = function(versionId, vNum) {
        const content = window.__WALNUT_RUNTIME__?.vcsVersionsMap ? window.__WALNUT_RUNTIME__?.vcsVersionsMap[versionId] : '';
        window.showConfirmDialog({
            title: t('editor.btn_rollback_snapshot'),
            message: t('editor.confirm_rollback', { version: vNum }),
            icon: 'history',
            onConfirm: function() {
                const editor = document.getElementById('editor-core');
                if (editor) {
                    editor.value = content || '';
                    const commitInput = document.querySelector('input[name="commit_message"]');
                    if (commitInput) commitInput.value = t('editor.rollback_commit_prefix', { version: vNum });
                    window.updatePreview();
                    window.returnToLiveEdit();
                    window.showToast('✔️ ' + t('editor.rollback_success', { version: vNum }), 'success');
                }
            }
        });
    };

    window.deletePastVersion = function(vId, vNum) {
        window.showConfirmDialog({
            title: t('common.delete'),
            message: 'v' + vNum,
            icon: 'delete',
            onConfirm: async function() {
                const nodeId = document.getElementById('form-node-id')?.value || '';
                const res = await fetch('/admin/articles/api/version/' + vId + '?node_id=' + nodeId, {method: 'DELETE'});
                if (res.ok) {
                    document.getElementById('version-card-' + vId)?.remove();
                    window.showToast('✔️ ' + t('common.success'), 'success');
                }
            }
        });
    };

    window.confirmSoftDeleteArticle = function() {
        window.showConfirmDialog({
            title: t('editor.btn_trash_article'),
            message: t('articles.confirm_delete'),
            icon: 'delete',
            onConfirm: async function() {
                const nodeId = document.getElementById('form-node-id')?.value || '';
                await fetch('/admin/articles/api/delete/' + nodeId, { method: 'DELETE' });
                window.location.href = '/admin/articles';
            }
        });
    };

    function switchSchemaTemplate(schemaType) {
        const groups = document.querySelectorAll('.schema-fields-group');
        groups.forEach(function(el) { el.classList.add('hidden'); });

        const targetId = 'schema-fields-' + (schemaType || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
        const target = document.getElementById(targetId);
        if (target) {
            target.classList.remove('hidden');
        }
    }

    window.openSchedulePublishModal = function() {
        const now = new Date(Date.now() + 60 * 60 * 1000);
        const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        const dateInput = document.getElementById('schedule-datetime-input');
        const modal = document.getElementById('schedule-publish-modal');
        if (dateInput) dateInput.value = localIso;
        if (modal) modal.classList.remove('hidden');
    };

    window.closeSchedulePublishModal = function() {
        const modal = document.getElementById('schedule-publish-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.addSchemaFieldRow = function(field) {
        field = field || { name: '', label: '', type: 'meta[name]', default: '' };
        const list = document.getElementById('schema-fields-list');
        const emptyTip = document.getElementById('schema-fields-empty-tip');
        if (!list) return;
        if (emptyTip) emptyTip.style.display = 'none';

        const row = document.createElement('div');
        row.className = 'schema-field-row grid grid-cols-12 gap-2 items-center bg-white p-2 rounded-lg border border-slate-200 text-xs';
        row.innerHTML =
            '<div class="col-span-3">' +
                '<input type="text" placeholder="' + t('schemas.placeholder_field_key') + '" value="' + (field.name || '') + '" class="schema-field-name w-full border border-slate-300 rounded px-2 py-1 text-xs font-mono outline-none focus:border-slate-900" />' +
            '</div>' +
            '<div class="col-span-3">' +
                '<input type="text" placeholder="' + t('schemas.placeholder_field_label') + '" value="' + (field.label || '') + '" class="schema-field-label w-full border border-slate-300 rounded px-2 py-1 text-xs outline-none focus:border-slate-900" />' +
            '</div>' +
            '<div class="col-span-3">' +
                '<walnut-select class="schema-field-type w-full border border-slate-300 rounded px-1.5 py-1 text-xs outline-none focus:border-slate-900 bg-white">' +
                    '<option value="meta[name]" ' + (field.type === 'meta[name]' ? 'selected' : '') + '>meta[name]</option>' +
                    '<option value="meta[property]" ' + (field.type === 'meta[property]' ? 'selected' : '') + '>meta[property]</option>' +
                    '<option value="schema.org" ' + (field.type === 'schema.org' ? 'selected' : '') + '>schema.org</option>' +
                    '<option value="text" ' + (field.type === 'text' ? 'selected' : '') + '>' + t('schemas.type_text') + '</option>' +
                    '<option value="url" ' + (field.type === 'url' ? 'selected' : '') + '>' + t('schemas.type_url') + '</option>' +
                '</walnut-select>' +
            '</div>' +
            '<div class="col-span-2">' +
                '<input type="text" placeholder="' + t('schemas.field_summary') + '" value="' + (field.default || '') + '" class="schema-field-default w-full border border-slate-300 rounded px-2 py-1 text-xs outline-none focus:border-slate-900" />' +
            '</div>' +
            '<div class="col-span-1 text-right">' +
                '<button type="button" onclick="window.removeSchemaFieldRow(this)" class="text-red-500 hover:text-red-700 p-1 rounded hover:bg-red-50 cursor-pointer" title="' + t('common.delete') + '">' +
                    '<span class="material-symbols-outlined text-[16px]">delete</span>' +
                '</button>' +
            '</div>';

        list.appendChild(row);
    };

    window.removeSchemaFieldRow = function(btn) {
        const row = btn.closest('.schema-field-row');
        if (row) {
            row.remove();
            const list = document.getElementById('schema-fields-list');
            const emptyTip = document.getElementById('schema-fields-empty-tip');
            if (list && list.querySelectorAll('.schema-field-row').length === 0 && emptyTip) {
                emptyTip.style.display = 'block';
            }
        }
    };

    window.syncSchemaFieldsJson = function() {
        const rows = document.querySelectorAll('.schema-field-row');
        const fields = [];
        rows.forEach(function(row) {
            const name = (row.querySelector('.schema-field-name')?.value || '').trim();
            const label = (row.querySelector('.schema-field-label')?.value || '').trim();
            const type = row.querySelector('.schema-field-type')?.value || 'meta[name]';
            const def = (row.querySelector('.schema-field-default')?.value || '').trim();

            if (name) {
                fields.push({
                    name: name,
                    label: label || name,
                    type: type,
                    default: def
                });
            }
        });

        const hidden = document.getElementById('schema-metadata-fields-json');
        if (hidden) {
            hidden.value = JSON.stringify(fields);
        }
    };

    window.deleteSchemaModel = function(schemaId, schemaTitle) {
        if (!schemaId) return;
        window.showConfirmDialog({
            title: t('editor.btn_delete_schema'),
            message: (schemaTitle || schemaId),
            icon: 'delete',
            onConfirm: async function() {
                try {
                    const res = await fetch('/admin/schemas/api/delete/' + encodeURIComponent(schemaId), {
                        method: 'DELETE'
                    });
                    const data = await res.json();
                    if (res.ok && data.success) {
                        if (window.showToast) window.showToast('✔️ ' + t('editor.schema_deleted'), 'success');
                        window.selectSchemaOption('default', t('editor.schema_standard'));

                        const optItem = document.getElementById('schema-item-' + schemaId);
                        if (optItem) optItem.remove();

                        const fieldsGroup = document.querySelector('[data-schema-id="' + schemaId + '"]');
                        if (fieldsGroup) fieldsGroup.remove();
                    } else {
                        if (window.showToast) window.showToast('❌ ' + (data.error || t('common.error')), 'error');
                    }
                } catch(e) {
                    if (window.showToast) window.showToast('❌ ' + t('common.network_error'), 'error');
                }
            }
        });
    };

    document.addEventListener('DOMContentLoaded', function() {
        const editor = document.getElementById('editor-core');
        const slugInput = document.getElementById('slug-input');
        const previewSlugText = document.getElementById('preview-slug-text');

        if (editor) {
            editor.addEventListener('input', function() {
                schedulePreview();
            });
            editor.addEventListener('paste', async function(e) {
                const items = (e.clipboardData || window.clipboardData).items;
                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    if (item.type.indexOf('image') !== -1) {
                        e.preventDefault();
                        const file = item.getAsFile();
                        const fd = new FormData();
                        fd.append('image', file);

                        const start = editor.selectionStart;
                        const end = editor.selectionEnd;
                        const baseText = editor.value;
                        const uploadingPlaceholder = t('editor.uploading_placeholder') || '![Uploading...](uploading)';
                        editor.value = baseText.substring(0, start) + uploadingPlaceholder + baseText.substring(end);
                        schedulePreview();

                        try {
                            const res = await fetch('/api/upload', {method: 'POST', body: fd});
                            const data = await res.json();
                            if (data.url) {
                                editor.value = editor.value.replace(uploadingPlaceholder, '![' + (data.file_name || 'image') + '](' + data.url + ')');
                                window.showToast(t('media.upload_success'), 'success');
                            } else {
                                editor.value = editor.value.replace(uploadingPlaceholder, t('editor.upload_failed_placeholder'));
                                window.showToast(t('common.error'), 'error');
                            }
                        } catch (err) {
                            editor.value = editor.value.replace(uploadingPlaceholder, t('editor.upload_error_placeholder'));
                            window.showToast(t('common.network_error'), 'error');
                        }
                        schedulePreview();
                    }
                }
            });
        }

        if (slugInput) {
            slugInput.addEventListener('input', function(e) {
                const raw = e.target.value;
                const clean = sanitizeSlug(raw);
                if (previewSlugText) previewSlugText.innerText = clean === '/' ? '' : (clean || 'slug');
                updateArticleSlugHint(raw);
            });
            slugInput.addEventListener('blur', function(e) {
                const raw = e.target.value;
                updateArticleSlugHint(raw);
                e.target.value = sanitizeSlug(raw);
                if (previewSlugText) previewSlugText.innerText = e.target.value === '/' ? '' : (e.target.value || 'slug');
            });
            updateArticleSlugHint(slugInput.value);
            window.addEventListener('walnut:i18n-loaded', function() {
                updateArticleSlugHint(slugInput.value);
            });
        }

        window.updatePreview();
        window.renderTagChips();
        initEditorSidebar();
    });
})();
