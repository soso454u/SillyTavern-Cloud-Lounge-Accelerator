const TYPE_BY_LIST_ID = Object.freeze({
    saved_regex_scripts: 'GLOBAL',
    saved_scoped_scripts: 'SCOPED',
    saved_preset_scripts: 'PRESET',
});

function recordsOnlyAffectChat(records) {
    return records.length > 0 && records.every(record => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        return Boolean(target?.closest?.('#chat'));
    });
}

function parseOptionalInteger(value) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function getTypeKey(element) {
    const list = element?.closest?.('#saved_regex_scripts, #saved_scoped_scripts, #saved_preset_scripts');
    return list ? TYPE_BY_LIST_ID[list.id] : null;
}

function readEditorDraft(editor, id, previous = {}) {
    const checkedPlacements = [...editor.querySelectorAll('input[name="replace_position"]:checked')]
        .map(input => Number(input.value))
        .filter(Number.isFinite);
    return {
        ...previous,
        id,
        scriptName: String(editor.querySelector('.regex_script_name')?.value || '').trim(),
        findRegex: String(editor.querySelector('.find_regex')?.value || ''),
        replaceString: String(editor.querySelector('.regex_replace_string')?.value || ''),
        trimStrings: String(editor.querySelector('.regex_trim_strings')?.value || '').split('\n').filter(Boolean),
        placement: checkedPlacements,
        disabled: Boolean(editor.querySelector('input[name="disabled"]')?.checked),
        markdownOnly: Boolean(editor.querySelector('input[name="only_format_display"]')?.checked),
        promptOnly: Boolean(editor.querySelector('input[name="only_format_prompt"]')?.checked),
        runOnEdit: Boolean(editor.querySelector('input[name="run_on_edit"]')?.checked),
        substituteRegex: Number(editor.querySelector('select[name="substitute_regex"]')?.value || 0),
        minDepth: parseOptionalInteger(editor.querySelector('input[name="min_depth"]')?.value),
        maxDepth: parseOptionalInteger(editor.querySelector('input[name="max_depth"]')?.value),
    };
}

export class RegexUiAdapter {
    constructor({ onSaved = null } = {}) {
        this.onSaved = onSaved;
        this.started = false;
        this.engine = null;
        this.popupApi = null;
        this.scriptApi = null;
        this.editorContext = null;
        this.saveQueue = Promise.resolve();
        this.observer = null;
        this.onClick = this.onClick.bind(this);
        this.onInput = this.onInput.bind(this);
    }

    async start() {
        if (this.started) return true;
        try {
            [this.engine, this.popupApi, this.scriptApi] = await Promise.all([
                import('../../../regex/engine.js'),
                import('../../../../popup.js'),
                import('../../../../../script.js'),
            ]);
        } catch (error) {
            console.debug('[Cloud Lounge Accelerator] 正则界面最小刷新适配不可用', error);
            return false;
        }
        this.started = true;
        document.addEventListener('click', this.onClick, true);
        document.addEventListener('input', this.onInput, true);
        this.observer = new MutationObserver(records => {
            if (recordsOnlyAffectChat(records)) return;
            if (document.querySelector('.regex_editor')) {
                if (this.editorContext) this.editorContext.opened = true;
            } else if (this.editorContext?.opened && !document.querySelector('.popup[closing] .regex_editor')) {
                this.editorContext = null;
            }
        });
        this.observer.observe(document.body, { childList: true, subtree: true });
        return true;
    }

    getType(typeKey) {
        return typeKey ? this.engine?.SCRIPT_TYPES?.[typeKey] : undefined;
    }

    enqueue(task) {
        this.saveQueue = this.saveQueue.then(task, task).catch(error => {
            console.error('[Cloud Lounge Accelerator] 正则保存适配失败', error);
            globalThis.toastr?.error?.('正则保存失败，已保留编辑窗口', '云酒馆加速器');
        });
        return this.saveQueue;
    }

    onClick(event) {
        if (!this.started || !(event.target instanceof Element)) return;
        const target = event.target;
        const editButton = target.closest('.edit_existing_regex');
        if (editButton) {
            const label = editButton.closest('.regex-script-label[id]');
            const typeKey = getTypeKey(editButton);
            this.editorContext = label && typeKey ? { id: label.id, typeKey, opened: false } : null;
            return;
        }

        if (target.closest('#open_regex_editor, #open_scoped_editor, #open_preset_editor')) {
            this.editorContext = null;
            return;
        }

        const saveButton = target.closest('.popup-button-ok');
        const popup = saveButton?.closest('.popup');
        const editor = popup?.querySelector('.regex_editor');
        const popupInstance = this.popupApi.Popup?.util?.popups?.find(item => item.dlg === popup);
        if (saveButton && popup && editor && this.editorContext && popupInstance) {
            event.preventDefault();
            event.stopImmediatePropagation();
            this.enqueue(() => this.saveExistingEditor({ popupInstance, editor, context: this.editorContext }));
            return;
        }

        const toggleIcon = target.closest('.regex-toggle-on, .regex-toggle-off');
        if (toggleIcon) {
            const disabled = toggleIcon.classList.contains('regex-toggle-on');
            event.preventDefault();
            event.stopImmediatePropagation();
            const checkbox = toggleIcon.closest('.regex-script-label')?.querySelector('.disable_regex');
            if (checkbox) checkbox.checked = disabled;
            this.enqueue(() => this.saveToggle(toggleIcon, disabled));
            return;
        }

        const bulkButton = target.closest('#bulk_enable_regex, #bulk_disable_regex');
        if (bulkButton) {
            const selected = [...document.querySelectorAll('#regex_container .regex-script-label:has(.regex_bulk_checkbox:checked)')];
            if (!selected.length) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            this.enqueue(() => this.saveBulkToggle(selected, bulkButton.id === 'bulk_disable_regex'));
        }
    }

    onInput(event) {
        if (!this.started || !(event.target instanceof HTMLInputElement)) return;
        if (!event.target.matches('.disable_regex')) return;
        event.stopImmediatePropagation();
        this.enqueue(() => this.saveToggle(event.target, event.target.checked));
    }

    async persistScripts(type, scripts) {
        await this.engine.saveScriptsByType(scripts, type);
        if (type === this.engine.SCRIPT_TYPES.SCOPED) {
            this.engine.allowScopedScripts?.(this.scriptApi.characters?.[this.scriptApi.this_chid]);
        } else if (type === this.engine.SCRIPT_TYPES.PRESET) {
            this.engine.allowPresetScripts?.(this.engine.getCurrentPresetAPI?.(), this.engine.getCurrentPresetName?.());
        }
        this.engine.RegexProvider?.instance?.clear?.();
        this.scriptApi.saveSettingsDebounced?.();
    }

    async saveExistingEditor({ popupInstance, editor, context }) {
        const type = this.getType(context.typeKey);
        const scripts = [...(this.engine.getScriptsByType?.(type) || [])];
        const index = scripts.findIndex(script => String(script.id) === String(context.id));
        if (type === undefined || index < 0) throw new Error('找不到正在编辑的正则');
        const draft = readEditorDraft(editor, context.id, scripts[index]);
        if (!draft.scriptName) {
            globalThis.toastr?.error?.('正则名称不能为空', '云酒馆加速器');
            return;
        }
        scripts[index] = draft;
        await this.persistScripts(type, scripts);
        const labelName = document.getElementById(context.id)?.querySelector('.regex_script_name');
        if (labelName) {
            labelName.textContent = draft.scriptName;
            labelName.title = draft.scriptName;
        }
        this.onSaved?.();
        await popupInstance.completeCancelled();
        this.editorContext = null;
    }

    async saveToggle(element, disabled) {
        const label = element.closest('.regex-script-label[id]');
        const type = this.getType(getTypeKey(element));
        if (!label || type === undefined) return;
        const scripts = [...(this.engine.getScriptsByType?.(type) || [])];
        const index = scripts.findIndex(script => String(script.id) === label.id);
        if (index < 0 || Boolean(scripts[index].disabled) === Boolean(disabled)) return;
        scripts[index] = { ...scripts[index], disabled: Boolean(disabled) };
        await this.persistScripts(type, scripts);
        const checkbox = label.querySelector('.disable_regex');
        if (checkbox) checkbox.checked = Boolean(disabled);
        this.onSaved?.();
    }

    async saveBulkToggle(labels, disabled) {
        const grouped = new Map();
        for (const label of labels) {
            const type = this.getType(getTypeKey(label));
            if (type === undefined) continue;
            if (!grouped.has(type)) grouped.set(type, new Set());
            grouped.get(type).add(label.id);
        }
        let changed = false;
        for (const [type, ids] of grouped) {
            const current = this.engine.getScriptsByType?.(type) || [];
            const scripts = current.map(script => ids.has(String(script.id))
                ? { ...script, disabled: Boolean(disabled) }
                : script);
            if (scripts.some((script, index) => script !== current[index] && Boolean(current[index].disabled) !== Boolean(disabled))) {
                await this.persistScripts(type, scripts);
                changed = true;
            }
        }
        labels.forEach(label => {
            const checkbox = label.querySelector('.disable_regex');
            if (checkbox) checkbox.checked = Boolean(disabled);
        });
        if (changed) this.onSaved?.();
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        document.removeEventListener('click', this.onClick, true);
        document.removeEventListener('input', this.onInput, true);
        this.observer?.disconnect();
        this.observer = null;
        this.editorContext = null;
        this.engine = null;
        this.popupApi = null;
        this.scriptApi = null;
    }
}
