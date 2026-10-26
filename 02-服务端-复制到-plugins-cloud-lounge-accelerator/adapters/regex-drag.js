import { SortableBridge } from './sortable-bridge.js';

const TYPE_KEYS = Object.freeze({
    saved_regex_scripts: 'GLOBAL',
    saved_scoped_scripts: 'SCOPED',
    saved_preset_scripts: 'PRESET',
});

export function createRegexDragAdapter() {
    return new SortableBridge({
        lists: '#saved_regex_scripts, #saved_scoped_scripts, #saved_preset_scripts',
        itemSelector: '*',
        handleSelector: '.drag-handle',
        label: '正则脚本',
        onCommit: async ({ list }) => {
            const engine = await import('../../../regex/engine.js');
            const type = engine.SCRIPT_TYPES?.[TYPE_KEYS[list.id]];
            if (type === undefined) return;
            const oldScripts = engine.getScriptsByType?.(type) || [];
            const ordered = [...list.children]
                .map(element => oldScripts.find(script => String(script.id) === element.id))
                .filter(Boolean);
            await engine.saveScriptsByType?.(ordered, type);
            const api = await import('../../../../../script.js');
            api.saveSettingsDebounced?.();
            list.dispatchEvent(new CustomEvent('cla-regex-dirty', { bubbles: true }));
        },
    });
}
