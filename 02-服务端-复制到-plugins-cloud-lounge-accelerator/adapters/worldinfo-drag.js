import { SortableBridge } from './sortable-bridge.js';

export function createWorldInfoDragAdapter() {
    return new SortableBridge({
        lists: '#world_popup_entries_list',
        itemSelector: '.world_entry',
        handleSelector: '.drag-handle',
        label: '世界书条目',
    });
}
