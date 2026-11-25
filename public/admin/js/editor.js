(function() {
    'use strict';

    const t = function(k, params) {
        const fn = window.__EDGE_I18N__ && window.__EDGE_I18N__.t;
        return typeof fn === 'function' ? fn(k, params) : k;
    };

    (window.__EDGE_RUNTIME__ = window.__EDGE_RUNTIME__ || {}).vcsVersionsMap = (function() {
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

        if (window.innerWidth < 1024) {
            const willOpen = !sidebar.classList.contains('mobile-inspector-open');
            if (window.closeMobileDrawers) window.closeMobileDrawers();
            if (willOpen) {
                sidebar.classList.remove('hidden');
                sidebar.classList.add('mobile-inspector-open');
                let backdrop = document.getElementById('mobile-drawer-backdrop');
                if (!backdrop) {
                    backdrop = document.createElement('div');
                    backdrop.id = 'mobile-drawer-backdrop';
                    backdrop.className = 'fixed inset-0 z-50 bg-black/25';
                    backdrop.addEventListener('click', function() {
                        if (window.closeMobileDrawers) window.closeMobileDrawers();
                    });
                }
                const targetParent = sidebar.parentElement || document.body;
                if (backdrop.parentElement !== targetParent) {
                    targetParent.appendChild(backdrop);
                }
                backdrop.classList.remove('hidden');
            }
            return;
        }

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

    function applyResponsiveEditorLayout(prevWidth) {
        const w = window.innerWidth;
        const sidebar = document.getElementById('editor-inspector-sidebar');
        const icon = document.getElementById('editor-sidebar-toggle-icon');
        if (sidebar) {
            if (w < 1024 && (prevWidth === undefined || prevWidth >= 1024)) {
                sidebar.classList.add('hidden');
                sidebar.classList.remove('mobile-inspector-open');
                if (icon) icon.innerText = 'view_sidebar';
            } else if (w >= 1024 && prevWidth !== undefined && prevWidth < 1024) {
                sidebar.classList.remove('mobile-inspector-open');
                const isCollapsed = localStorage.getItem('walnut_editor_sidebar_collapsed') === 'true';
                sidebar.classList.toggle('hidden', isCollapsed);
                if (icon) icon.innerText = isCollapsed ? 'view_sidebar' : 'dock_to_right';
            }
        }
        if (w < 768) {
            const sourcePane = document.getElementById('editor-pane-source');
            if (sourcePane) {
                sourcePane.classList.add('w-full');
                sourcePane.classList.remove('w-1/2');
            }
        } else if (prevWidth !== undefined && prevWidth < 768) {
            const savedViewMode = localStorage.getItem('edge_editor_view_mode') || 'edit';
            if (window.setEditorViewMode) window.setEditorViewMode(savedViewMode);
        }
    }

    function initEditorSidebar() {
        const isCollapsed = localStorage.getItem('walnut_editor_sidebar_collapsed') === 'true' || window.innerWidth < 1024;
        const sidebar = document.getElementById('editor-inspector-sidebar');
        const icon = document.getElementById('editor-sidebar-toggle-icon');
        if (isCollapsed && sidebar) {
            sidebar.classList.add('hidden');
            if (icon) icon.innerText = 'view_sidebar';
        }
        applyResponsiveEditorLayout(undefined);
        let editorResizeTimer;
        let lastEditorWidth = window.innerWidth;
        window.addEventListener('resize', function() {
            clearTimeout(editorResizeTimer);
            editorResizeTimer = setTimeout(function() {
                const cur = window.innerWidth;
                applyResponsiveEditorLayout(lastEditorWidth);
                lastEditorWidth = cur;
            }, 120);
        });
    }

    const ALL_TABS = ['props', 'seo', 'links', 'versions'];
    const SECTION_TO_TAB = { meta: 'props', props: 'props', seo: 'seo', wiki: 'links', links: 'links', publish: 'versions', versions: 'versions' };

    window.switchInspectorTab = function(targetKey) {
        const tabKey = SECTION_TO_TAB[targetKey] || 'props';
        for (let i = 0; i < ALL_TABS.length; i++) {
            const k = ALL_TABS[i];
            const panel = document.getElementById('inspector-panel-' + k);
            const btn = document.getElementById('inspector-tab-' + k);
            const isActive = k === tabKey;
            if (panel) panel.classList.toggle('hidden', !isActive);
            if (btn) {
                btn.className = isActive
                    ? 'py-1.5 px-2 rounded-md text-xs font-bold transition-colors cursor-pointer bg-[var(--admin-surface)] text-[var(--admin-text)] shadow-sm border border-[var(--admin-border)]'
                    : 'py-1.5 px-2 rounded-md text-xs font-bold transition-colors cursor-pointer text-[var(--admin-text-muted)] hover:text-[var(--admin-text)] border border-transparent';
            }
        }
    };

    window.openSingleAccordion = function(targetKey) {
        window.switchInspectorTab(targetKey);
    };

    window.setEditorViewMode = function(mode) {
        const resolved = mode === 'split' ? 'split' : 'edit';
        try { localStorage.setItem('edge_editor_view_mode', resolved); } catch (e) {}
        const sourcePane = document.getElementById('editor-pane-source');
        const sourceInner = document.getElementById('editor-source-inner');
        const preview = document.getElementById('preview-core');
        if (sourcePane) {
            sourcePane.classList.toggle('w-full', resolved === 'edit');
            sourcePane.classList.toggle('w-1/2', resolved === 'split');
        }
        if (sourceInner) {
            sourceInner.classList.toggle('max-w-4xl', resolved === 'edit');
            sourceInner.classList.toggle('mx-auto', resolved === 'edit');
            sourceInner.classList.toggle('px-8', resolved === 'edit');
            sourceInner.classList.toggle('px-10', resolved === 'split');
            sourceInner.classList.toggle('lg:px-12', resolved === 'split');
        }
        if (preview) {
            preview.classList.toggle('hidden', resolved !== 'split');
        }
        document.querySelectorAll('#editor-view-toggle button[data-mode]').forEach(function(btn) {
            const isActive = btn.getAttribute('data-mode') === resolved;
            btn.className = isActive
                ? 'h-full px-2.5 rounded-md text-[13px] font-semibold transition-colors cursor-pointer bg-[var(--admin-accent-soft)] text-[var(--admin-accent-text)] flex items-center'
                : 'h-full px-2.5 rounded-md text-[13px] font-semibold transition-colors cursor-pointer text-[var(--admin-text-muted)] hover:text-[var(--admin-text)] flex items-center';
        });
        if (resolved === 'split' && window.updatePreview) {
            window.updatePreview();
        }
    };

    window.copyArticlePreviewUrl = function() {
        const box = document.getElementById('preview-url-box');
        if (!box) return;
        const text = (box.textContent || '').trim();
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function() {
                if (window.showToast) window.showToast(t('editor.copied_url'), 'success');
            }).catch(function() {});
        }
    };

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

    window.regenerateArticlePassword = function() {
        const input = document.getElementById('article-access-password-input');
        if (!input) return;
        const code = String(Math.floor(100000 + Math.random() * 900000));
        input.value = code;
        return code;
    };

    window.handleArticleVisibilityChange = function(val) {
        const visInput = document.getElementById('form-visibility-input');
        if (visInput) visInput.value = val;
        const box = document.getElementById('article-password-box');
        const pwInput = document.getElementById('article-access-password-input');
        if (box) {
            if (val === 'password') {
                box.classList.remove('hidden');
                if (pwInput && !pwInput.value.trim()) {
                    window.regenerateArticlePassword();
                }
            } else {
                box.classList.add('hidden');
            }
        }
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

    window.renderTagChips = function() {
        const container = document.getElementById('tag-chips-container');
        const hiddenInput = document.getElementById('form-tags-input');
        if (hiddenInput) hiddenInput.value = currentTags.join(',');

        if (!container) return;
        container.innerHTML = '';
        for (let i = 0; i < currentTags.length; i++) {
            const tag = currentTags[i];
            const chip = document.createElement('span');
            chip.className = 'inline-flex items-center space-x-1 bg-[var(--admin-accent-soft)] text-[var(--admin-accent-text)] border border-[var(--admin-accent-border)] px-2 py-0.5 rounded-md text-xs font-bold';

            const label = document.createElement('span');
            label.textContent = '#' + tag;

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'hover:text-red-600 text-amber-500 font-bold ml-1 cursor-pointer';
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
        // Strip fenced and inline code before scanning [[...]] so code examples and extension containers are not listed as wiki links.
        const stripped = (editor.value || '')
            .replace(/```[\s\S]*?```/g, '')
            .replace(/`[^`]*`/g, '');
        const wikiRegex = new RegExp('\\[\\[([^\\]|]+)(?:\\|[^\\]]+)?\\]\\]', 'g');
        const extPrefixRe = /^(?:tip|warn|warning|info|note|step|quote|callout|details|tabs|card):/i;
        const matches = Array.from(stripped.matchAll(wikiRegex));
        const uniqueTargets = [];
        for (let i = 0; i < matches.length; i++) {
            const m = matches[i][1].trim();
            if (m && !extPrefixRe.test(m) && uniqueTargets.indexOf(m) === -1) uniqueTargets.push(m);
        }

        const countBadge = document.getElementById('wiki-outgoing-count');
        const listElem = document.getElementById('wiki-outgoing-list');
        if (countBadge) countBadge.innerText = t('editor.outgoing_count_tag', { count: uniqueTargets.length }) || String(uniqueTargets.length);

        if (listElem) {
            listElem.innerHTML = '';
            if (uniqueTargets.length === 0) {
                const emptySpan = document.createElement('span');
                emptySpan.className = 'text-stone-400 text-[11px]';
                const tipMsg = document.getElementById('msg-no-outgoing-links');
                emptySpan.textContent = tipMsg ? tipMsg.value : (t('editor.no_outgoing_links') || '');
                listElem.appendChild(emptySpan);
            } else {
                for (let j = 0; j < uniqueTargets.length; j++) {
                    const target = uniqueTargets[j];
                    const item = document.createElement('div');
                    item.className = 'flex items-center space-x-1 text-amber-700 font-bold py-0.5';

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
        callout: '<div class="my-4 p-4 rounded-xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800/70 text-sm text-stone-700 dark:text-stone-200"><div class="font-bold text-xs uppercase tracking-wider text-stone-500 dark:text-stone-400 mb-1">CALLOUT</div><div>{{content}}</div></div>',
        tip: '<div class="my-4 p-4 rounded-xl border border-amber-200 dark:border-amber-800/80 bg-amber-50/70 dark:bg-amber-950/40 text-sm text-amber-900 dark:text-amber-200"><div class="font-bold text-xs uppercase tracking-wider text-amber-600 dark:text-amber-400 mb-1">TIP</div><div>{{content}}</div></div>',
        warning: '<div class="my-4 p-4 rounded-xl border border-amber-200 dark:border-amber-800/80 bg-amber-50/70 dark:bg-amber-950/40 text-sm text-amber-900 dark:text-amber-200"><div class="font-bold text-xs uppercase tracking-wider text-amber-600 dark:text-amber-400 mb-1">WARNING</div><div>{{content}}</div></div>',
        quote: '<blockquote class="my-4 pl-4 py-2 border-l-4 border-amber-500 bg-stone-50/60 dark:bg-stone-800/40 rounded-r-xl italic text-stone-700 dark:text-stone-300">{{content}}</blockquote>',
        step: '<div class="my-4 pl-4 py-2 border-l-2 border-indigo-500 bg-indigo-50/40 dark:bg-indigo-950/30 rounded-r-xl text-sm text-stone-800 dark:text-stone-200">{{content}}</div>'
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
                return '<a href="/' + escWikiText(cleanSlug) + '" class="text-amber-600 dark:text-amber-400 font-semibold hover:underline">' + escWikiText(label.trim()) + '</a>';
            })
            .replace(/\[\[([^\[\]\n:：]+)\]\]/g, function(_, slug) {
                var cleanSlug = String(slug || '').trim().replace(/^\/+/, '');
                return '<a href="/' + escWikiText(cleanSlug) + '" class="text-amber-600 dark:text-amber-400 font-semibold hover:underline">' + escWikiText(slug.trim()) + '</a>';
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

    function inspectArticleSpecialSlug(rawVal) {
        const trimmed = (rawVal || '').trim();
        if (!trimmed) return { level: 'none', message: '' };
        const clean = sanitizeSlug(trimmed);
        const fullPath = clean === '/' ? '/' : ('/' + clean);
        return typeof window.inspectEdgeSpecialRouteSlug === 'function'
            ? window.inspectEdgeSpecialRouteSlug(trimmed, fullPath)
            : { level: 'none', message: '' };
    }

    function updateArticleSlugHint(rawVal) {
        const hintEl = document.getElementById('article-slug-special-hint');
        const slugInput = document.getElementById('slug-input');
        if (hintEl && typeof window.renderEdgeSpecialRouteHint === 'function') {
            window.renderEdgeSpecialRouteHint(hintEl, slugInput, inspectArticleSpecialSlug(rawVal));
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
                if (fd.get('meta_og_use_first_image') === '1') chunkMeta.og_use_first_image = true;
                const tplId = String(fd.get('meta_template_page_id') || '').trim();
                if (tplId) { chunkMeta.template_page_id = tplId; chunkMeta.template_id = tplId; }
                const visVal = String(fd.get('visibility') || 'public').trim();
                const accessPw = String(fd.get('meta_access_password') || '').trim();
                if (accessPw) chunkMeta.access_password = accessPw;
                const aliasesRaw = String(fd.get('meta_aliases') || '').trim();
                if (aliasesRaw) {
                    chunkMeta.aliases = aliasesRaw.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
                }
                const pubAtRaw = String(fd.get('published_at') || '').trim();
                const res = await window.walnutSaveLongArticleChunks({
                    id: String(fd.get('id') || ''),
                    title: String(fd.get('title') || ''),
                    slug: String(fd.get('slug') || ''),
                    summary: String(fd.get('summary') || ''),
                    locale: String(fd.get('locale') || 'zh-CN'),
                    status: statusValue,
                    visibility: visVal,
                    maturity: String(fd.get('progress') || fd.get('maturity') || 'none'),
                    publishedAt: pubAtRaw || undefined,
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
        if (window.setEditorViewMode) window.setEditorViewMode('split');
        const content = window.__EDGE_RUNTIME__?.vcsVersionsMap ? window.__EDGE_RUNTIME__?.vcsVersionsMap[versionId] : '';
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
        const content = window.__EDGE_RUNTIME__?.vcsVersionsMap ? window.__EDGE_RUNTIME__?.vcsVersionsMap[versionId] : '';
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
        const nodeType = document.getElementById('form-type-input')?.value || 'article';
        const isMicro = nodeType === 'micro';
        window.showConfirmDialog({
            title: isMicro ? t('common.btn_move_to_trash') : t('editor.btn_trash_article'),
            message: isMicro ? t('micro.confirm_delete') : t('articles.confirm_delete'),
            icon: 'delete',
            onConfirm: async function() {
                const nodeId = document.getElementById('form-node-id')?.value || '';
                const delBase = isMicro ? '/admin/micros/api/delete/' : '/admin/articles/api/delete/';
                await fetch(delBase + encodeURIComponent(nodeId), { method: 'DELETE' });
                window.location.href = isMicro ? '/admin/micros' : '/admin/articles';
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
                        if (window.showToast) window.showToast(t('editor.schema_deleted'), 'success');
                        window.selectSchemaOption('default', t('editor.schema_standard'));

                        const optItem = document.getElementById('schema-item-' + schemaId)
                            || document.querySelector('#dropdown-menu-schema [data-value="' + schemaId + '"]');
                        if (optItem) optItem.remove();

                        const fieldsGroup = document.querySelector('[data-schema-id="' + schemaId + '"]');
                        if (fieldsGroup) fieldsGroup.remove();
                    } else {
                        if (window.showToast) window.showToast(data.error || t('common.error'), 'error');
                    }
                } catch(e) {
                    if (window.showToast) window.showToast(t('common.network_error'), 'error');
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

        const previewCore = document.getElementById('preview-core');
        if (previewCore && !previewCore.dataset.navGuardBound) {
            previewCore.dataset.navGuardBound = '1';
            // Keep preview strictly visual-only so accidental clicks on links or buttons never navigate away from the editor.
            previewCore.addEventListener('click', function(e) {
                const interactive = e.target && e.target.closest ? e.target.closest('a, button, form') : null;
                if (interactive) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            }, true);
        }

        let savedViewMode = 'edit';
        try { savedViewMode = localStorage.getItem('edge_editor_view_mode') || 'edit'; } catch (e) {}
        window.setEditorViewMode(savedViewMode);
        window.renderTagChips();
        initEditorSidebar();
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
        const isCpuLimit = window.__EDGE_RUNTIME__ && window.__EDGE_RUNTIME__.isCpuLimitResponse;
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
                headers: { 'Content-Type': 'application/json' },
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
            if (typeof isCpuLimit === 'function' && isCpuLimit(res.status, bodyText) && targetBytes > 8 * 1024) {
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
})();
