import { SortableBridge } from './sortable-bridge.js';

export function createPresetDragAdapter() {
    return new SortableBridge({
        lists: '[id$="prompt_manager_list"]',
        itemSelector: '[data-pm-identifier][class*="prompt_manager_prompt_draggable"]',
        handleSelector: '.drag-handle',
        label: '预设提示词',
    });
}
