(function() {
    'use strict';

    const t = (k, params) => {
        if (!k) return '';
        const fn = window.__EDGE_I18N__ && window.__EDGE_I18N__.t;
        if (typeof fn === 'function') {
            const res = fn(k, params);
            if (res) return res;
        }
        return k;
    };

    const getHost = () => (window.__EDGE_RUNTIME__ && window.__EDGE_RUNTIME__.pageEditorHost) || {};
    let activeGalleryCategory = 'all';
    let galleryCardsInitialized = false;

    function classifyGalleryComp(comp) {
        const s = ((comp.slug || '') + ' ' + (comp.category || '') + ' ' + (comp.title || '')).toLowerCase();
        if (/nav|header|menu|breadcrumb|sidebar/.test(s)) return 'nav';
        if (/hero|banner|intro|cta|cover/.test(s)) return 'hero';
        if (/footer|form|lead|contact|subscribe|pricing|testimonial/.test(s)) return 'footer';
        if (/dataset|media|gallery|feed|stream|viewer|table|chart/.test(s)) return 'data';
        return 'grid';
    }

    function buildGalleryCardDom(gridEl) {
        const host = getHost();
        const escapeHtmlText = host.escapeHtmlText || ((s) => String(s || ''));
        const datasetsData = typeof host.getPageDatasetsData === 'function' ? host.getPageDatasetsData() : {};
        const componentsMap = host.THEME_COMPONENTS_MAP || {};

        const slotCard = document.createElement('div');
        slotCard.id = 'comp-gallery-slot-card';
        slotCard.className = 'col-span-full shrink-0 p-4 bg-[var(--admin-accent-soft)] hover:bg-[var(--admin-surface-hover)] cursor-pointer flex items-center space-x-3 transition-colors duration-75 rounded-2xl border-2 border-dashed border-[var(--admin-accent-border)] hidden';
        slotCard.onclick = function() { window.addBlock('@slot:page_content'); };
        slotCard.innerHTML = `
            <div class="w-10 h-10 rounded-xl bg-[var(--admin-accent)] text-[var(--admin-accent-on)] flex items-center justify-center shrink-0">
                <span class="material-symbols-outlined text-[20px]">dynamic_feed</span>
            </div>
            <div class="min-w-0 flex-1">
                <div class="font-black text-xs text-[var(--admin-text)]">${t('pages.slot_comp_title')}</div>
                <div class="text-[11px] text-[var(--admin-accent-text)] mt-0.5">${t('pages.slot_comp_desc')}</div>
            </div>
        `;
        gridEl.appendChild(slotCard);

        const hasExtIsland = datasetsData.extIslandEnabled && Array.isArray(datasetsData.externalExtensions) && datasetsData.externalExtensions.length > 0;
        const extSlotTpl = hasExtIsland ? document.getElementById('commercial-ext-island-slot') : null;
        const extTplNode = extSlotTpl && extSlotTpl.content ? extSlotTpl.content.firstElementChild : null;
        if (extTplNode) {
            const extIslandCard = extTplNode.cloneNode(true);
            extIslandCard.onclick = function() { window.addBlock('@ext:island'); };
            gridEl.appendChild(extIslandCard);
        }

        const seenSlugs = new Set();
        Object.values(componentsMap).forEach(function(comp) {
            if (!comp || !comp.slug || seenSlugs.has(comp.slug)) return;
            seenSlugs.add(comp.slug);
            const cSlots = (Array.isArray(comp.slots) && comp.slots.length > 0) ? comp.slots : ['main'];
            const cat = classifyGalleryComp(comp);

            const card = document.createElement('div');
            card.setAttribute('data-gallery-card', '1');
            card.setAttribute('data-gallery-slug', comp.slug);
            card.setAttribute('data-gallery-category', cat);
            card.setAttribute('data-gallery-slots', cSlots.join(','));

            const previewWrap = document.createElement('div');
            previewWrap.className = 'shrink-0 bg-[var(--admin-chrome)] p-2.5 border-b border-[var(--admin-border)]';
            const viewport = document.createElement('div');
            viewport.className = 'w-full h-32 rounded-lg overflow-hidden relative bg-[var(--admin-surface)] ring-1 ring-[var(--admin-border)]';
            if (comp.preview_srcdoc) {
                const iframe = document.createElement('iframe');
                iframe.className = 'pointer-events-none select-none border-0 origin-top-left absolute top-0 left-0';
                iframe.style.width = '960px';
                iframe.style.height = '480px';
                iframe.style.transformOrigin = '0 0';
                iframe.setAttribute('data-srcdoc', comp.preview_srcdoc);
                iframe.setAttribute('tabindex', '-1');
                viewport.appendChild(iframe);
            } else {
                viewport.innerHTML = `<div class="w-full h-full flex items-center justify-center text-[var(--admin-text-muted)]"><span class="material-symbols-outlined text-[32px]">${comp.icon || 'widgets'}</span></div>`;
            }
            previewWrap.appendChild(viewport);
            card.appendChild(previewWrap);

            const info = document.createElement('div');
            info.className = 'p-4 flex-1 flex flex-col justify-between space-y-2.5';
            const slotsBadges = cSlots.map(function(s) {
                return `<span class="bg-[var(--admin-accent-soft)] text-[var(--admin-accent-text)] border border-[var(--admin-accent-border)] px-2 py-0.5 rounded-md font-mono text-[10px] font-semibold">${s}</span>`;
            }).join(' ');
            info.innerHTML = `
                <div>
                    <div class="flex items-center justify-between gap-2">
                        <div class="flex items-center space-x-2 min-w-0">
                            <span class="material-symbols-outlined text-[16px] text-[var(--admin-accent-text)] shrink-0">${comp.icon || 'widgets'}</span>
                            <span class="font-black text-xs text-[var(--admin-text)] truncate">${escapeHtmlText(comp.title)}</span>
                        </div>
                        <span class="text-[10px] font-mono text-[var(--admin-text-muted)] shrink-0">${escapeHtmlText(comp.slug)}</span>
                    </div>
                    <p class="text-[11px] text-[var(--admin-text-muted)] mt-1 line-clamp-2">${escapeHtmlText(comp.summary || comp.slug)}</p>
                </div>
                <div class="flex items-center justify-between pt-2 border-t border-[var(--admin-border)]">
                    <div class="flex items-center flex-wrap gap-1">${slotsBadges}</div>
                    <span data-gallery-quota-msg class="text-[10px] text-[var(--admin-accent-text)] font-bold hidden">${t('pages.slot_not_open_by_template')}</span>
                </div>
            `;
            card.appendChild(info);
            gridEl.appendChild(card);
        });

        const emptyEl = document.createElement('div');
        emptyEl.id = 'comp-gallery-empty';
        emptyEl.className = 'col-span-full py-12 text-center text-[var(--admin-text-muted)] text-xs italic hidden';
        emptyEl.textContent = t('pages.no_theme_comps');
        gridEl.appendChild(emptyEl);
    }

    function scaleVisibleGalleryIframes(gridEl) {
        requestAnimationFrame(function() {
            gridEl.querySelectorAll('[data-gallery-card]:not(.hidden) iframe').forEach(function(ifr) {
                const w = ifr.parentElement ? ifr.parentElement.clientWidth : 400;
                if (w > 0) {
                    const scale = Math.min(1, Math.max(0.25, w / 960));
                    ifr.style.transform = 'scale(' + scale.toFixed(4) + ')';
                }
                const pendingSrcdoc = ifr.getAttribute('data-srcdoc');
                if (pendingSrcdoc !== null) {
                    ifr.srcdoc = pendingSrcdoc;
                    ifr.removeAttribute('data-srcdoc');
                }
            });
        });
    }

    window.renderComponentGallery = function(category) {
        if (category) activeGalleryCategory = category;
        const filtersEl = document.getElementById('comp-gallery-filters');
        const gridEl = document.getElementById('comp-gallery-grid');
        if (!filtersEl || !gridEl) return;

        const host = getHost();
        const datasetsData = typeof host.getPageDatasetsData === 'function' ? host.getPageDatasetsData() : {};
        const blocks = typeof host.getCurrentBlocks === 'function' ? host.getCurrentBlocks() : [];
        const slotQuotas = host.DEFAULT_SLOT_QUOTAS || {};

        const cats = [
            { id: 'all', label: t('pages.gallery_cat_all') },
            { id: 'nav', label: t('pages.gallery_cat_nav') },
            { id: 'hero', label: t('pages.gallery_cat_hero') },
            { id: 'grid', label: t('pages.gallery_cat_grid') },
            { id: 'data', label: t('pages.gallery_cat_data') },
            { id: 'footer', label: t('pages.gallery_cat_footer') }
        ];
        if (!filtersEl.hasChildNodes()) {
            cats.forEach(function(cat) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.setAttribute('data-gallery-filter', cat.id);
                btn.textContent = cat.label;
                btn.onclick = function() { window.renderComponentGallery(cat.id); };
                filtersEl.appendChild(btn);
            });
        }
        filtersEl.querySelectorAll('button[data-gallery-filter]').forEach(function(btn) {
            const isActive = activeGalleryCategory === btn.getAttribute('data-gallery-filter');
            btn.className = isActive
                ? 'px-3 py-1 rounded-full text-xs font-bold bg-[var(--admin-accent)] text-[var(--admin-accent-on)] shadow-xs transition-colors duration-75 cursor-pointer'
                : 'px-3 py-1 rounded-full text-xs font-semibold bg-[var(--admin-surface)] text-[var(--admin-text-muted)] border border-[var(--admin-border)] hover:text-[var(--admin-text)] hover:border-[var(--admin-accent-border)] transition-colors duration-75 cursor-pointer';
        });

        // Keep mounted card iframes alive in DOM across category switches to eliminate srcdoc reload flashes.
        if (!galleryCardsInitialized) {
            gridEl.innerHTML = '';
            buildGalleryCardDom(gridEl);
            galleryCardsInitialized = true;
        }

        const pageTypeInput = document.getElementById('form-page-type');
        const currentPageType = pageTypeInput ? pageTypeInput.value : 'single';
        const hasPageContentSlotAlready = blocks.some(function(b) {
            const c = b.component || b.id || '';
            return c === '@slot:page_content' || c === 'slot:page_content';
        });
        const slotCard = document.getElementById('comp-gallery-slot-card');
        const showSlotCard = currentPageType === 'template' && !hasPageContentSlotAlready && (activeGalleryCategory === 'all' || activeGalleryCategory === 'grid');
        if (slotCard) slotCard.classList.toggle('hidden', !showSlotCard);
        const extCard = document.getElementById('comp-gallery-ext-island-card');
        const showExtCard = datasetsData.extIslandEnabled && (datasetsData.externalExtensions || []).length > 0 && (activeGalleryCategory === 'all' || activeGalleryCategory === 'data');
        if (extCard) extCard.classList.toggle('hidden', !showExtCard);

        const activeTpl = typeof host.getActiveTemplateObj === 'function' ? host.getActiveTemplateObj() : null;
        const tplSlotUsed = {};
        if (activeTpl && Array.isArray(activeTpl.blocks) && typeof host.resolveEditorBlockSlot === 'function') {
            activeTpl.blocks.forEach(function(tb) {
                const s = host.resolveEditorBlockSlot(tb);
                tplSlotUsed[s] = (tplSlotUsed[s] || 0) + 1;
            });
        }

        let visibleCount = 0;
        gridEl.querySelectorAll('[data-gallery-card]').forEach(function(card) {
            const slug = card.getAttribute('data-gallery-slug') || '';
            const cat = card.getAttribute('data-gallery-category') || 'grid';
            const cSlots = (card.getAttribute('data-gallery-slots') || 'main').split(',').filter(Boolean);
            const matchesCat = activeGalleryCategory === 'all' || cat === activeGalleryCategory;
            const allSlotsFull = cSlots.every(function(s) {
                const max = slotQuotas[s] !== undefined ? slotQuotas[s] : Infinity;
                return (tplSlotUsed[s] || 0) >= max;
            });

            card.className = (allSlotsFull
                ? 'shrink-0 rounded-2xl border border-[var(--admin-border)] bg-[var(--admin-chrome)] opacity-50 cursor-not-allowed overflow-hidden flex flex-col'
                : 'group shrink-0 rounded-2xl border border-[var(--admin-border)] bg-[var(--admin-surface)] hover:border-[var(--admin-accent)] hover:shadow-lg transition-colors duration-75 cursor-pointer overflow-hidden flex flex-col')
                + (matchesCat ? '' : ' hidden');
            card.onclick = allSlotsFull ? null : function() { window.addBlock(slug); };
            const quotaMsg = card.querySelector('[data-gallery-quota-msg]');
            if (quotaMsg) quotaMsg.classList.toggle('hidden', !allSlotsFull);
            if (matchesCat) visibleCount++;
        });

        const emptyEl = document.getElementById('comp-gallery-empty');
        if (emptyEl) emptyEl.classList.toggle('hidden', visibleCount > 0 || showSlotCard);

        scaleVisibleGalleryIframes(gridEl);
    };

    window.openAddComponentGallery = function() {
        const modal = document.getElementById('add-component-gallery-modal');
        if (!modal) return;
        modal.classList.remove('hidden');
        window.renderComponentGallery(activeGalleryCategory);
    };

    window.closeAddComponentGallery = function() {
        const modal = document.getElementById('add-component-gallery-modal');
        if (modal) modal.classList.add('hidden');
    };
})();
