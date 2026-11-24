import { preservePresetAnchor } from './preset-scroll-anchor.js';

const DURATION = 180;
const LIMIT = 16;
const SIZE = ['height', 'margin-top', 'margin-bottom', 'padding-top', 'padding-bottom', 'border-top-width', 'border-bottom-width'];
const VALUES = [...SIZE, 'opacity'];
const OVERRIDES = ['display', 'box-sizing', 'min-height', 'max-height', 'overflow-x', 'overflow-y', 'pointer-events', 'flex-grow', 'flex-shrink', 'flex-basis',
    ...VALUES, 'transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'];

// Keep native sortable rows as direct children. Animate only the small range
// visible in the scroll frame, with one shared layout flush instead of one per row.
export class PresetFoldMotion {
    constructor(list) {
        this.list = list;
        this.win = list.ownerDocument.defaultView;
        this.records = [];
    }

    snapshot() {
        let top = 0, bottom = this.win.innerHeight;
        for (let node = this.list.parentElement; node; node = node.parentElement) {
            if (!/auto|scroll|overlay|hidden|clip/.test(this.win.getComputedStyle(node).overflowY)) continue;
            const rect = node.getBoundingClientRect(); top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom);
        }
        return new Map([...this.list.children].map(node => {
            const rect = node.getBoundingClientRect(), visible = rect.height > 0 && rect.bottom > top && rect.top < bottom;
            const style = visible ? this.win.getComputedStyle(node) : null;
            return [node, { height: rect.height, visible, display: style?.display,
                values: style && Object.fromEntries(VALUES.map(key => [key, key === 'height' ? `${rect.height}px` : style.getPropertyValue(key)])) }];
        }));
    }

    update(anchor, update) {
        if (this.win.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            this.finish(); return preservePresetAnchor(anchor, update);
        }
        const before = this.snapshot();
        this.finish();
        preservePresetAnchor(anchor, () => {
            update();
            const after = this.snapshot(), zero = Object.fromEntries(VALUES.map(key => [key, key === 'opacity' ? '0' : '0px']));
            for (const [node, next] of after) {
                const previous = before.get(node);
                if (!previous || (!previous.visible && !next.visible) || Math.abs(previous.height - next.height) < 1) continue;
                if (this.records.length >= LIMIT) break;
                const hadStyle = node.hasAttribute('style');
                const saved = OVERRIDES.map(key => [key, node.style.getPropertyValue(key), node.style.getPropertyPriority(key)]);
                const set = (key, value) => node.style.setProperty(key, value, 'important');
                const start = previous.height ? previous.values : zero, end = next.height ? next.values : zero;
                if (!start || !end) continue;
                this.records.push({ node, saved, set, end, hadStyle });
                for (const [key, value] of Object.entries({ display: next.display || previous.display, 'box-sizing': 'border-box',
                    'min-height': '0', 'max-height': 'none', 'overflow-x': 'hidden', 'overflow-y': 'hidden', 'pointer-events': 'none',
                    'flex-grow': '0', 'flex-shrink': '0', 'flex-basis': 'auto', 'transition-property': 'none', ...start })) set(key, value);
            }
            if (!this.records.length) return;
            void this.list.offsetHeight;
            for (const { set, end } of this.records) {
                set('transition-property', VALUES.join(', '));
                set('transition-duration', `${DURATION}ms`);
                set('transition-timing-function', 'cubic-bezier(0.2, 0.8, 0.2, 1)');
                set('transition-delay', '0ms');
                for (const [key, value] of Object.entries(end)) set(key, value);
            }
            this.timer = this.win.setTimeout(() => this.finish(), DURATION + 32);
        });
    }

    finish() {
        this.win.clearTimeout(this.timer); this.timer = null;
        for (const { node, saved, hadStyle } of this.records) {
            node.style.setProperty('transition-property', 'none', 'important');
            for (const [key, value, priority] of saved) {
                if (value) node.style.setProperty(key, value, priority); else node.style.removeProperty(key);
            }
            if (!hadStyle && !node.style.length) node.removeAttribute('style');
        }
        this.records = [];
    }
}
