const LIST_SELECTOR = '[id$="prompt_manager_list"]';
const BODY_CLASS = 'cla-preset-drag-guard';
const HANDLE = '.drag-handle';
const START_EVENTS = ['pointerdown', 'mousedown', 'touchstart'];

// Keep the native sortable and its update/save callbacks. Configure it before
// the list's mouse/touch handlers run, including after a native list rerender.
export class PresetDragGuard {
    constructor({ documentRef = globalThis.document, getJQuery = () => globalThis.jQuery || globalThis.$ } = {}) {
        this.document = documentRef;
        this.getJQuery = getJQuery;
        this.records = new Map();
        this.started = false;
        this.onStart = this.onStart.bind(this);
    }

    start() {
        if (this.started) return true;
        if (!this.document?.body) return false;
        this.started = true;
        this.document.body.classList.add(BODY_CLASS);
        for (const type of START_EVENTS) {
            this.document.addEventListener(type, this.onStart, { capture: true, passive: true });
        }
        for (const list of this.document.querySelectorAll(LIST_SELECTOR)) this.protect(list);
        return true;
    }

    getInstance(list) {
        const jquery = this.getJQuery();
        if (!jquery?.fn?.sortable) return null;
        try {
            return jquery(list).sortable('instance') || null;
        } catch {
            return null;
        }
    }

    onStart(event) {
        if (!this.started || event.button > 0) return;
        const list = event.target?.closest?.(LIST_SELECTOR);
        if (list) this.protect(list);
    }

    protect(list) {
        for (const element of this.records.keys()) {
            if (!element.isConnected) this.records.delete(element);
        }
        if (!list.isConnected) return;
        const instance = this.getInstance(list);
        if (!instance?.options || instance.dragging || instance.options.disabled) return;
        let record = this.records.get(list);
        if (record?.instance !== instance) {
            record = { instance, original: {}, applied: {} };
            this.records.set(list, record);
        }
        const options = {
            handle: HANDLE,
            distance: Math.max(10, Number(instance.options.distance) || 0),
            delay: Math.max(150, Number(instance.options.delay) || 0),
        };
        const changes = {};
        for (const [key, value] of Object.entries(options)) {
            // Native render may reset only some options on the same instance.
            if (!(key in record.applied) || instance.options[key] !== record.applied[key]) {
                record.original[key] = instance.options[key];
            }
            if (instance.options[key] !== value) changes[key] = value;
            record.applied[key] = value;
        }
        if (Object.keys(changes).length) instance.option(changes);
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        for (const type of START_EVENTS) this.document.removeEventListener(type, this.onStart, true);
        this.document.body?.classList.remove(BODY_CLASS);
        for (const [list, record] of this.records) {
            if (!list.isConnected || this.getInstance(list) !== record.instance) continue;
            const restore = {};
            for (const [key, value] of Object.entries(record.original)) {
                // Do not overwrite options subsequently changed by another extension.
                if (record.instance.options[key] === record.applied[key]) restore[key] = value;
            }
            if (Object.keys(restore).length) record.instance.option(restore);
        }
        this.records.clear();
    }
}
