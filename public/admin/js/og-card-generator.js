(function() {
    'use strict';

    const t = function(k, params) {
        const fn = window.__EDGE_I18N__ && window.__EDGE_I18N__.t;
        return typeof fn === 'function' ? fn(k, params) : k;
    };

    let currentOptions = {};
    let bgImageObj = null;

    function ensureModalDoms() {
        if (!document.getElementById('og-card-generator-modal')) {
            const modal = document.createElement('div');
            modal.id = 'og-card-generator-modal';
            modal.className = 'hidden fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';
            modal.innerHTML = `
                <div class="bg-white dark:bg-stone-800 rounded-3xl max-w-2xl w-full p-6 shadow-2xl border border-stone-200 dark:border-stone-700 space-y-4 max-h-[90vh] overflow-y-auto">
                    <div class="flex justify-between items-center border-b border-stone-100 dark:border-stone-700 pb-3">
                        <div class="flex items-center space-x-2">
                            <span class="material-symbols-outlined text-amber-600 text-[22px]">palette</span>
                            <h3 class="font-black text-sm text-stone-900 dark:text-white uppercase tracking-wider">${t('editor.og_modal_title')}</h3>
                        </div>
                        <button type="button" onclick="window.closeOgCardModal()" class="p-1 rounded-lg text-stone-400 hover:text-stone-700 dark:hover:text-white cursor-pointer">
                            <span class="material-symbols-outlined text-[20px]">close</span>
                        </button>
                    </div>

                    <div class="rounded-2xl overflow-hidden border border-stone-200 dark:border-stone-700 bg-stone-900 shadow-inner flex items-center justify-center">
                        <canvas id="og-preview-canvas" width="1200" height="630" class="w-full h-auto max-h-64 object-contain"></canvas>
                    </div>

                    <div class="space-y-3 text-xs">
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                                <label class="block font-bold text-stone-700 dark:text-stone-300 mb-1">${t('editor.og_field_title')}</label>
                                <input type="text" id="og-modal-title" class="w-full bg-stone-50 dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-xl px-3 py-2 text-xs font-bold text-stone-900 dark:text-white outline-none focus:border-amber-500" />
                            </div>
                            <div>
                                <label class="block font-bold text-stone-700 dark:text-stone-300 mb-1">${t('editor.og_field_site')}</label>
                                <input type="text" id="og-modal-site" value="WALNUT CMS" class="w-full bg-stone-50 dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-xl px-3 py-2 text-xs font-mono text-stone-900 dark:text-white outline-none focus:border-amber-500" />
                            </div>
                        </div>

                        <div>
                            <label class="block font-bold text-stone-700 dark:text-stone-300 mb-1">${t('editor.og_field_desc')}</label>
                            <textarea id="og-modal-desc" rows="2" class="w-full bg-stone-50 dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-xl p-2.5 text-xs text-stone-800 dark:text-stone-100 outline-none focus:border-amber-500 resize-none leading-relaxed"></textarea>
                        </div>

                        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                                <label class="block font-bold text-stone-700 dark:text-stone-300 mb-1">${t('editor.og_field_theme')}</label>
                                <edge-select id="og-modal-theme" class="w-full bg-stone-50 dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-xl px-3 py-2 text-xs text-stone-800 dark:text-stone-100 outline-none focus:border-amber-500">
                                    <option value="dark_slate">${t('editor.og_theme_dark_slate')}</option>
                                    <option value="emerald_glow">${t('editor.og_theme_emerald_glow')}</option>
                                    <option value="indigo_modern">${t('editor.og_theme_indigo_modern')}</option>
                                    <option value="sunset_gradient">${t('editor.og_theme_sunset_gradient')}</option>
                                    <option value="custom_bg">${t('editor.og_theme_custom_bg')}</option>
                                </edge-select>
                            </div>
                            <div id="og-custom-bg-box" class="hidden">
                                <label class="block font-bold text-stone-700 dark:text-stone-300 mb-1">${t('editor.og_field_custom_bg')}</label>
                                <div class="flex space-x-1">
                                    <input type="text" id="og-modal-bg-url" placeholder="https://.../bg.jpg" class="flex-1 bg-stone-50 dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-xl px-3 py-2 text-xs font-mono outline-none focus:border-amber-500" />
                                    <button type="button" onclick="window.openMediaPickerForOgBg()" class="bg-stone-200 dark:bg-stone-700 hover:bg-stone-300 text-stone-700 dark:text-white px-2.5 rounded-xl font-bold text-xs shrink-0 cursor-pointer">${t('editor.btn_pick_media')}</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="flex items-center justify-end space-x-3 pt-3 border-t border-stone-100 dark:border-stone-700">
                        <button type="button" onclick="window.closeOgCardModal()" class="px-4 py-2 text-xs font-bold text-stone-500 hover:text-stone-700 dark:hover:text-white cursor-pointer">${t('common.cancel')}</button>
                        <button type="button" id="og-generate-upload-btn" onclick="window.generateAndUploadOgCard()" class="bg-[#B45309] hover:bg-[#92400E] text-white px-5 py-2 rounded-xl text-xs font-black shadow-md transition flex items-center space-x-1 cursor-pointer">
                            <span class="material-symbols-outlined text-[16px]">cloud_upload</span>
                            <span>${t('editor.og_btn_generate_upload')}</span>
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            bindModalEvents();
        }

        if (!document.getElementById('media-picker-standalone-modal')) {
            const picker = document.createElement('div');
            picker.id = 'media-picker-standalone-modal';
            picker.className = 'hidden fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';
            picker.innerHTML = `
                <div class="bg-white dark:bg-stone-800 rounded-3xl max-w-2xl w-full p-6 shadow-2xl border border-stone-200 dark:border-stone-700 space-y-4 max-h-[85vh] flex flex-col">
                    <div class="flex justify-between items-center border-b border-stone-100 dark:border-stone-700 pb-3 shrink-0">
                        <div class="flex items-center space-x-2">
                            <span class="material-symbols-outlined text-amber-600 text-[20px]">perm_media</span>
                            <h3 class="font-black text-sm text-stone-900 dark:text-white">${t('editor.media_picker_title')}</h3>
                        </div>
                        <button type="button" onclick="document.getElementById('media-picker-standalone-modal')?.classList.add('hidden')" class="p-1 rounded-lg text-stone-400 hover:text-stone-700 dark:hover:text-white cursor-pointer">
                            <span class="material-symbols-outlined text-[20px]">close</span>
                        </button>
                    </div>
                    <div id="media-picker-grid" class="flex-1 overflow-y-auto grid grid-cols-3 sm:grid-cols-4 gap-3 p-1">
                        <div class="col-span-full py-8 text-center text-stone-400 text-xs">${t('editor.media_picker_loading')}</div>
                    </div>
                </div>
            `;
            document.body.appendChild(picker);
        }
    }

    function bindModalEvents() {
        const titleInp = document.getElementById('og-modal-title');
        const descInp = document.getElementById('og-modal-desc');
        const siteInp = document.getElementById('og-modal-site');
        const themeSelect = document.getElementById('og-modal-theme');
        const bgUrlInp = document.getElementById('og-modal-bg-url');

        [titleInp, descInp, siteInp].forEach(function(el) {
            el?.addEventListener('input', drawCanvas);
        });

        themeSelect?.addEventListener('change', function() {
            const isCustom = this.value === 'custom_bg';
            const customBox = document.getElementById('og-custom-bg-box');
            if (customBox) {
                if (isCustom) customBox.classList.remove('hidden');
                else customBox.classList.add('hidden');
            }
            if (!isCustom) {
                bgImageObj = null;
            }
            drawCanvas();
        });

        bgUrlInp?.addEventListener('change', function() {
            loadCustomBg(this.value);
        });
    }

    function loadCustomBg(url) {
        if (!url) {
            bgImageObj = null;
            drawCanvas();
            return;
        }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function() {
            bgImageObj = img;
            drawCanvas();
        };
        img.onerror = function() {
            bgImageObj = null;
            drawCanvas();
        };
        img.src = url;
    }

    function drawCanvas() {
        const canvas = document.getElementById('og-preview-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const w = 1200;
        const h = 630;
        const title = (document.getElementById('og-modal-title')?.value || 'Walnut Digital Garden').trim();
        const site = (document.getElementById('og-modal-site')?.value || 'WALNUT CMS').trim();
        const desc = (document.getElementById('og-modal-desc')?.value || '').trim();
        const theme = document.getElementById('og-modal-theme')?.value || 'dark_slate';

        ctx.clearRect(0, 0, w, h);

        if (theme === 'custom_bg' && bgImageObj) {
            ctx.drawImage(bgImageObj, 0, 0, w, h);
            ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
            ctx.fillRect(0, 0, w, h);
        } else if (theme === 'emerald_glow') {
            const grad = ctx.createLinearGradient(0, 0, w, h);
            grad.addColorStop(0, '#064e3b');
            grad.addColorStop(1, '#022c22');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
        } else if (theme === 'indigo_modern') {
            const grad = ctx.createLinearGradient(0, 0, w, h);
            grad.addColorStop(0, '#1e1b4b');
            grad.addColorStop(1, '#0f172a');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
        } else if (theme === 'sunset_gradient') {
            const grad = ctx.createLinearGradient(0, 0, w, h);
            grad.addColorStop(0, '#831843');
            grad.addColorStop(0.5, '#4c1d95');
            grad.addColorStop(1, '#0f172a');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
        } else {
            const grad = ctx.createLinearGradient(0, 0, w, h);
            grad.addColorStop(0, '#0f172a');
            grad.addColorStop(1, '#1e293b');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
        }

        ctx.save();
        ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
        ctx.beginPath();
        ctx.arc(1050, 100, 260, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(59, 130, 246, 0.12)';
        ctx.beginPath();
        ctx.arc(150, 520, 220, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.fillStyle = '#34d399';
        ctx.font = '900 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(site.toUpperCase(), 90, 110);

        ctx.fillStyle = '#10b981';
        ctx.fillRect(90, 135, 60, 4);

        ctx.fillStyle = '#ffffff';
        ctx.font = '900 56px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        const maxWidth = 1020;
        const lineHeight = 72;
        let y = 240;

        const words = title.split('');
        let currentLine = '';
        let lineCount = 0;

        for (let i = 0; i < words.length; i++) {
            const testLine = currentLine + words[i];
            const metrics = ctx.measureText(testLine);
            if (metrics.width > maxWidth && i > 0) {
                ctx.fillText(currentLine, 90, y);
                currentLine = words[i];
                y += lineHeight;
                lineCount++;
                if (lineCount >= 2 && i < words.length - 1) {
                    currentLine += '...';
                    break;
                }
            } else {
                currentLine = testLine;
            }
        }
        ctx.fillText(currentLine, 90, y);

        if (desc) {
            ctx.fillStyle = '#94a3b8';
            ctx.font = '400 26px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            const descMaxW = 1000;
            const descLineH = 38;
            let descY = y + 70;
            const descChars = desc.split('');
            let dLine = '';
            let dCount = 0;

            for (let j = 0; j < descChars.length; j++) {
                const test = dLine + descChars[j];
                if (ctx.measureText(test).width > descMaxW && j > 0) {
                    ctx.fillText(dLine, 90, descY);
                    dLine = descChars[j];
                    descY += descLineH;
                    dCount++;
                    if (dCount >= 2) break;
                } else {
                    dLine = test;
                }
            }
            if (dCount < 2) {
                ctx.fillText(dLine, 90, descY);
            }
        }

        ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.font = '600 18px monospace';
        ctx.fillText('POWERED BY WALNUT CMS', 890, 570);
    }

    window.openOgCardGeneratorModal = function(options) {
        ensureModalDoms();
        currentOptions = options || {};

        const titleSource = currentOptions.titleInputId ? document.getElementById(currentOptions.titleInputId)?.value : '';
        const summarySource = currentOptions.summaryInputId ? document.getElementById(currentOptions.summaryInputId)?.value : '';

        const titleInp = document.getElementById('og-modal-title');
        const descInp = document.getElementById('og-modal-desc');

        if (titleInp) titleInp.value = titleSource || 'Walnut Digital Garden';
        if (descInp) descInp.value = summarySource || '';

        const modal = document.getElementById('og-card-generator-modal');
        if (modal) modal.classList.remove('hidden');

        setTimeout(drawCanvas, 50);
    };

    window.closeOgCardModal = function() {
        const modal = document.getElementById('og-card-generator-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.generateAndUploadOgCard = async function() {
        const canvas = document.getElementById('og-preview-canvas');
        const btn = document.getElementById('og-generate-upload-btn');
        if (!canvas) return;

        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="material-symbols-outlined text-[16px] animate-spin">refresh</span><span>' + t('editor.og_btn_generating') + '</span>';
        }

        canvas.toBlob(async function(blob) {
            if (!blob) {
                if (window.showToast) window.showToast(t('common.error'), 'error');
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<span class="material-symbols-outlined text-[16px]">cloud_upload</span><span>' + t('editor.og_btn_generate_upload') + '</span>';
                }
                return;
            }

            try {
                const formData = new FormData();
                const fileName = `og-card-${Date.now().toString(36)}.png`;
                formData.append('file', blob, fileName);

                const res = await fetch('/admin/api/upload', {
                    method: 'POST',
                    body: formData
                });
                const data = await res.json();

                if (res.ok && data.url) {
                    const targetInput = currentOptions.targetInputId ? document.getElementById(currentOptions.targetInputId) : null;
                    if (targetInput) {
                        targetInput.value = data.url;
                    }
                    const previewImg = currentOptions.previewImgId ? document.getElementById(currentOptions.previewImgId) : null;
                    if (previewImg) {
                        previewImg.src = data.url;
                        previewImg.classList.remove('hidden');
                    }
                    window.closeOgCardModal();
                    if (window.showToast) window.showToast(t('editor.og_upload_success'), 'success');
                } else {
                    if (window.showToast) window.showToast('❌ ' + (data.error || t('common.error')), 'error');
                }
            } catch (e) {
                if (window.showToast) window.showToast('❌ ' + t('common.network_error'), 'error');
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<span class="material-symbols-outlined text-[16px]">cloud_upload</span><span>' + t('editor.og_btn_generate_upload') + '</span>';
                }
            }
        }, 'image/png');
    };

    window.openMediaPickerForInput = async function(targetInputId, previewImgId) {
        ensureModalDoms();
        const modal = document.getElementById('media-picker-standalone-modal');
        const grid = document.getElementById('media-picker-grid');
        if (!modal || !grid) return;

        modal.classList.remove('hidden');
        grid.innerHTML = '<div class="col-span-full py-8 text-center text-stone-400 text-xs">' + t('editor.media_picker_loading') + '</div>';

        try {
            const res = await fetch('/admin/media/api/list');
            const data = await res.json();
            const assets = (data.assets || []).filter(function(a) {
                return a.mime_type && a.mime_type.startsWith('image/');
            });

            if (assets.length === 0) {
                grid.innerHTML = '<div class="col-span-full py-8 text-center text-stone-400 text-xs">' + t('editor.media_picker_empty') + '</div>';
                return;
            }

            grid.innerHTML = '';
            assets.forEach(function(asset) {
                const item = document.createElement('div');
                item.className = 'group relative rounded-xl overflow-hidden border border-stone-200 dark:border-stone-700 aspect-video bg-stone-100 dark:bg-stone-900 cursor-pointer hover:border-amber-500 transition shadow-xs';
                item.innerHTML = `
                    <img src="${asset.public_url}" alt="${asset.file_name}" class="w-full h-full object-cover group-hover:scale-105 transition" />
                    <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center p-2 text-center">
                        <span class="text-white text-[10px] font-bold truncate max-w-full">${t('editor.media_picker_select')}</span>
                    </div>
                `;
                item.onclick = function() {
                    const targetInput = document.getElementById(targetInputId);
                    if (targetInput) targetInput.value = asset.public_url;
                    const previewImg = document.getElementById(previewImgId);
                    if (previewImg) {
                        previewImg.src = asset.public_url;
                        previewImg.classList.remove('hidden');
                    }
                    modal.classList.add('hidden');
                    if (window.showToast) window.showToast(t('editor.media_picker_selected'), 'success');
                };
                grid.appendChild(item);
            });
        } catch (e) {
            grid.innerHTML = '<div class="col-span-full py-8 text-center text-red-500 text-xs">' + t('editor.media_picker_error') + '</div>';
        }
    };

    window.openMediaPickerForOgBg = function() {
        window.openMediaPickerForInput('og-modal-bg-url');
        const bgUrlInp = document.getElementById('og-modal-bg-url');
        if (bgUrlInp) {
            const observer = new MutationObserver(function() {
                loadCustomBg(bgUrlInp.value);
            });
            observer.observe(bgUrlInp, { attributes: true });
        }
    };
})();
