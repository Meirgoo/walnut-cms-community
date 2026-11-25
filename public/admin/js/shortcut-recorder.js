(function() {
    'use strict';

    const t = function(k, params) {
        const fn = window.__EDGE_I18N__ && window.__EDGE_I18N__.t;
        return typeof fn === 'function' ? fn(k, params) : k;
    };

    class WalnutShortcutRecorder extends HTMLElement {
        connectedCallback() {
            if (this._initialized) return;
            this._initialized = true;

            this._input = this.querySelector('[data-role="shortcut-input"]');
            this._box = this.querySelector('[data-role="recorder-box"]');
            this._badgesContainer = this.querySelector('[data-role="badges-container"]');
            this._statusText = this.querySelector('[data-role="status-text"]');
            this._recordBtn = this.querySelector('[data-role="record-btn"]');
            this._addBtn = this.querySelector('[data-role="add-btn"]');
            this._resetBtn = this.querySelector('[data-role="reset-btn"]');

            this._defaultVal = this.getAttribute('data-default') || 'alt+k,cmd+k';
            this._recording = false;
            this._recordMode = 'replace';
            this._shortcuts = this._parseList(this._input ? this._input.value : this._defaultVal);

            this._boundKeyDown = this._onKeyDown.bind(this);
            this._boundKeyUp = this._onKeyUp.bind(this);
            this._boundOutsideClick = this._onOutsideClick.bind(this);

            const self = this;
            if (this._box) {
                this._box.addEventListener('click', function(e) {
                    if (e.target.closest('[data-remove-shortcut]')) return;
                    e.preventDefault();
                    if (!self._recording) {
                        self._startRecording('replace');
                    }
                });
            }

            if (this._recordBtn) {
                this._recordBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    if (self._recording && self._recordMode === 'replace') {
                        self._stopRecording();
                    } else {
                        self._startRecording('replace');
                    }
                });
            }

            if (this._addBtn) {
                this._addBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    if (self._recording && self._recordMode === 'append') {
                        self._stopRecording();
                    } else {
                        self._startRecording('append');
                    }
                });
            }

            if (this._resetBtn) {
                this._resetBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    self._stopRecording();
                    self._shortcuts = self._parseList(self._defaultVal);
                    self._syncValue();
                    self._render();
                    if (window.showToast) {
                        window.showToast(t('settings.shortcut_reset_toast'), 'success');
                    }
                });
            }

            this._render();
        }

        disconnectedCallback() {
            this._stopRecording();
        }

        _parseList(raw) {
            return String(raw || '')
                .split(',')
                .map(function(s) { return s.trim().toLowerCase(); })
                .filter(Boolean);
        }

        _syncValue() {
            const joined = this._shortcuts.join(',');
            if (this._input) {
                this._input.value = joined;
                this._input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            if (window.__EDGE_RUNTIME__?.quickAction && typeof window.__EDGE_RUNTIME__?.quickAction.updateShortcut === 'function') {
                window.__EDGE_RUNTIME__?.quickAction.updateShortcut(joined);
            }
        }

        _formatKeyBadge(combo) {
            return combo
                .split('+')
                .map(function(p) {
                    const clean = p.trim().toLowerCase();
                    if (clean === 'cmd' || clean === 'meta') return '⌘ Cmd';
                    if (clean === 'alt' || clean === 'option') return '⌥ Alt';
                    if (clean === 'ctrl' || clean === 'control') return '⌃ Ctrl';
                    if (clean === 'shift') return '⇧ Shift';
                    return clean.toUpperCase();
                })
                .join(' + ');
        }

        _render() {
            if (!this._badgesContainer || !this._statusText) return;
            const self = this;
            this._badgesContainer.innerHTML = '';

            if (this._recording) {
                if (this._box) {
                    this._box.classList.add('ring-2', 'ring-amber-500/40', 'border-amber-500', 'bg-amber-50/30', 'dark:bg-amber-950/20');
                }
                if (this._recordBtn) {
                    this._recordBtn.textContent = this.getAttribute('data-recording-label') || t('settings.btn_recording_shortcut');
                    this._recordBtn.classList.remove('bg-[#B45309]', 'hover:bg-[#92400E]');
                    this._recordBtn.classList.add('bg-rose-600', 'hover:bg-rose-500', 'animate-pulse');
                }
                if (this._recordMode === 'append' && this._shortcuts.length > 0) {
                    this._shortcuts.forEach(function(sc) {
                        const chip = document.createElement('span');
                        chip.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-mono font-bold bg-stone-200/70 dark:bg-stone-800 text-stone-500 dark:text-stone-400 border border-stone-300 dark:border-stone-700';
                        chip.textContent = self._formatKeyBadge(sc);
                        self._badgesContainer.appendChild(chip);
                    });
                }
                this._statusText.className = 'text-xs font-mono font-bold text-amber-600 dark:text-amber-400 animate-pulse';
                this._statusText.textContent = this.getAttribute('data-recording-label') || t('settings.btn_recording_shortcut');
                return;
            }

            if (this._box) {
                this._box.classList.remove('ring-2', 'ring-amber-500/40', 'border-amber-500', 'bg-amber-50/30', 'dark:bg-amber-950/20');
            }
            if (this._recordBtn) {
                this._recordBtn.textContent = this.getAttribute('data-record-label') || t('settings.btn_record_shortcut');
                this._recordBtn.classList.remove('bg-rose-600', 'hover:bg-rose-500', 'animate-pulse');
                this._recordBtn.classList.add('bg-[#B45309]', 'hover:bg-[#92400E]');
            }

            if (this._shortcuts.length === 0) {
                this._statusText.className = 'text-xs font-mono text-stone-400 dark:text-stone-500';
                this._statusText.textContent = this.getAttribute('data-empty-hint') || t('settings.shortcut_empty_hint');
                return;
            }

            this._statusText.textContent = '';
            this._shortcuts.forEach(function(sc, idx) {
                const badge = document.createElement('span');
                badge.className = 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-mono font-semibold bg-[var(--admin-accent-soft)] text-[var(--admin-accent-text)] border border-[var(--admin-accent-border)]';

                const labelSpan = document.createElement('span');
                labelSpan.textContent = self._formatKeyBadge(sc);
                badge.appendChild(labelSpan);

                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.setAttribute('data-remove-shortcut', String(idx));
                removeBtn.className = 'text-stone-400 hover:text-rose-500 dark:hover:text-rose-400 transition cursor-pointer leading-none ml-0.5';
                removeBtn.textContent = '×';
                removeBtn.addEventListener('click', function(ev) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    self._shortcuts.splice(idx, 1);
                    if (self._shortcuts.length === 0) {
                        self._shortcuts = self._parseList(self._defaultVal);
                    }
                    self._syncValue();
                    self._render();
                });

                badge.appendChild(removeBtn);
                self._badgesContainer.appendChild(badge);
            });
        }

        _startRecording(mode) {
            this._recording = true;
            this._recordMode = mode || 'replace';
            (window.__EDGE_RUNTIME__ = window.__EDGE_RUNTIME__ || {}).recordingShortcut = true;
            this._render();
            if (this._box) this._box.focus();
            window.addEventListener('keydown', this._boundKeyDown, true);
            window.addEventListener('keyup', this._boundKeyUp, true);
            document.addEventListener('mousedown', this._boundOutsideClick, true);
        }

        _stopRecording() {
            if (!this._recording) return;
            this._recording = false;
            (window.__EDGE_RUNTIME__ = window.__EDGE_RUNTIME__ || {}).recordingShortcut = false;
            window.removeEventListener('keydown', this._boundKeyDown, true);
            window.removeEventListener('keyup', this._boundKeyUp, true);
            document.removeEventListener('mousedown', this._boundOutsideClick, true);
            this._render();
        }

        _onOutsideClick(e) {
            if (!this.contains(e.target)) {
                this._stopRecording();
            }
        }

        _normalizeKey(e) {
            const code = e.code || '';
            if (/^Key([A-Z])$/.test(code)) return code.slice(3).toLowerCase();
            if (/^Digit([0-9])$/.test(code)) return code.slice(5);
            if (/^Numpad([0-9])$/.test(code)) return code.slice(6);
            if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
            const codeMap = {
                Space: 'space',
                Slash: '/',
                Backslash: '\\',
                Period: '.',
                Comma: ',',
                Semicolon: ';',
                Quote: "'",
                Backquote: '`',
                Minus: '-',
                Equal: '=',
                BracketLeft: '[',
                BracketRight: ']',
                Enter: 'enter',
                Tab: 'tab',
                Backspace: 'backspace',
                Delete: 'delete',
                ArrowUp: 'up',
                ArrowDown: 'down',
                ArrowLeft: 'left',
                ArrowRight: 'right'
            };
            if (codeMap[code]) return codeMap[code];
            const rawKey = (e.key || '').toLowerCase();
            if (rawKey === ' ') return 'space';
            return rawKey;
        }

        _onKeyDown(e) {
            if (!this._recording) return;
            e.preventDefault();
            e.stopPropagation();

            if (e.key === 'Escape') {
                this._stopRecording();
                return;
            }

            const mods = [];
            if (e.ctrlKey) mods.push('ctrl');
            if (e.altKey) mods.push('alt');
            if (e.shiftKey) mods.push('shift');
            if (e.metaKey) mods.push('cmd');

            const isModifierOnly = ['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(e.key) ||
                /^(Control|Alt|Shift|Meta|OS)/.test(e.code || '');

            if (isModifierOnly) {
                if (this._statusText && mods.length > 0) {
                    this._statusText.textContent = this._formatKeyBadge(mods.join('+')) + ' + ...';
                }
                return;
            }

            const mainKey = this._normalizeKey(e);
            if (!mainKey) return;

            const isFunctionKey = /^f([1-9]|1[0-2])$/.test(mainKey);
            if (mods.length === 0 && !isFunctionKey) {
                if (window.showToast) {
                    window.showToast(t('settings.shortcut_need_modifier_warn'), 'warning');
                }
                return;
            }

            const combo = mods.concat([mainKey]).join('+');
            if (this._recordMode === 'append') {
                if (!this._shortcuts.includes(combo)) {
                    this._shortcuts.push(combo);
                }
            } else {
                this._shortcuts = [combo];
            }

            this._syncValue();
            this._stopRecording();

            if (window.showToast) {
                window.showToast(t('settings.shortcut_recorded_toast', { shortcut: this._formatKeyBadge(combo) }), 'success');
            }
        }

        _onKeyUp(e) {
            if (!this._recording) return;
            e.preventDefault();
            e.stopPropagation();
            const mods = [];
            if (e.ctrlKey) mods.push('ctrl');
            if (e.altKey) mods.push('alt');
            if (e.shiftKey) mods.push('shift');
            if (e.metaKey) mods.push('cmd');
            if (this._statusText) {
                if (mods.length > 0) {
                    this._statusText.textContent = this._formatKeyBadge(mods.join('+')) + ' + ...';
                } else {
                    this._statusText.textContent = this.getAttribute('data-recording-label') || t('settings.btn_recording_shortcut');
                }
            }
        }
    }

    if (!customElements.get('walnut-shortcut-recorder')) {
        customElements.define('walnut-shortcut-recorder', WalnutShortcutRecorder);
    }
})();
