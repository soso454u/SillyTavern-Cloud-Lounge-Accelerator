const SETTLE_MS = 180;

// Reserve chat scrolling (including momentum after pointerup) for the browser.
// This gates only our code discovery/highlighting, not native rendering or
// other extensions. No per-scroll geometry reads, DOM writes or animation loop.
export class ChatScrollActivity {
    constructor({
        getChatElement, onIdle, documentRef = globalThis.document,
        setTimer = (...args) => setTimeout(...args),
        clearTimer = handle => clearTimeout(handle),
    }) {
        Object.assign(this, { getChatElement, onIdle, document: documentRef, setTimer, clearTimer });
        this.timer = null;
        this.started = false;
        this.scrollEvents = 0;
        this.onScroll = event => {
            if (event.target === this.getChatElement()) this.defer();
        };
        this.onWheel = event => {
            const chat = this.getChatElement();
            if (chat && (event.target === chat || chat.contains?.(event.target))) this.defer();
        };
        this.onVisibilityChange = () => {
            this.reset();
            if (!this.document.hidden && this.started) this.onIdle();
        };
    }

    get active() { return this.timer !== null; }

    start() {
        if (this.started) return;
        this.started = true;
        for (const [name, handler] of this.handlers()) {
            this.document.addEventListener(name, handler, { capture: true, passive: true });
        }
    }

    handlers() {
        return [['scroll', this.onScroll], ['wheel', this.onWheel], ['visibilitychange', this.onVisibilityChange]];
    }

    defer() {
        if (!this.started || this.document.hidden) return;
        this.scrollEvents++;
        this.reset();
        this.timer = this.setTimer(() => {
            this.timer = null;
            if (this.started) this.onIdle();
        }, SETTLE_MS);
    }

    reset() {
        if (this.timer !== null) this.clearTimer(this.timer);
        this.timer = null;
    }

    stop() {
        this.started = false;
        this.reset();
        for (const [name, handler] of this.handlers()) this.document.removeEventListener(name, handler, true);
    }

    getReport() { return { active: this.active, scrollEvents: this.scrollEvents, settleMs: SETTLE_MS }; }
}
