import { entryStatus } from './transfer-reader-stats.js';

// A pane keeps one filtered result and one search string per snapshot entry.
// No repeated JSON serialization while selecting rows or updating controls.
export class TransferListFilter {
    constructor() { this.clear(); }
    clear() { this.last = null; this.texts = new WeakMap(); this.cachedChars = 0; }
    filter(items, kind, query = '', status = 'all') {
        query = query.toLocaleLowerCase().trim();
        const previous = this.last;
        if (previous?.items === items && previous.kind === kind && previous.query === query && previous.status === status) return previous.result;
        if (previous && previous.items !== items) { this.texts = new WeakMap(); this.cachedChars = 0; }
        const result = !query && (!status || status === 'all') ? items : items.filter(item => {
            if (status && status !== 'all' && entryStatus(kind, item) !== status) return false;
            if (!query) return true;
            let text = this.texts.get(item.value);
            if (text === undefined) {
                text = JSON.stringify(item.value).toLocaleLowerCase();
                if (this.cachedChars + text.length <= 2000000) {
                    this.texts.set(item.value, text); this.cachedChars += text.length;
                }
            }
            return text.includes(query);
        });
        this.last = { items, kind, query, status, result };
        return result;
    }
}

export function transferPage(items, index = 0, size = 40) {
    const pages = Math.max(1, Math.ceil(items.length / size));
    index = Math.min(pages - 1, Math.max(0, Math.trunc(index) || 0));
    const start = index * size;
    return { items: items.slice(start, start + size), index, pages, start, end: Math.min(items.length, start + size), total: items.length };
}
