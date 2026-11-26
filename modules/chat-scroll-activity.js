const SETTLE_MS = 180;

// Reserve chat scrolling (including momentum after pointerup) for the browser.
// This gates only our code discovery/highlighting, not native rendering or
// other extensions. No per-scroll geometry reads, DOM writes or animation loop.
export class ChatScrollActivity {
    constructor({
        onIdle, documentRef = globalThis.document,
        now = () => globalThis.performance.now(),
        setTimer = (...args) => setTimeout(...args),
        clearTimer = handle => clearTimeout(handle),
    }) {
        Object.assign(this, { onIdle, document: documentRef, now, setTimer, clearTimer });
        this.chat = null;
        this.timer = null;
        this.started = false;
        this.scrollEvents = 0;
        this.onScroll = event => {
            if (event.target === this.chat) this.defer();
        };
        this.onWheel = () => this.defer();
        this.onVisibilityChange = () => {
            this.reset();
            if (!this.document.hidden && this.started) this.onIdle();
        };
    }

    get active() { return this.timer !== null; }

    start(chat) {
        if (this.started) return;
        this.started = true;
        this.document.addEventListener('visibilitychange', this.onVisibilityChange);
        this.bind(chat);
    }

    bind(chat) {
        if (!this.started || chat === this.chat) return;
        this.chat?.removeEventListener('scroll', this.onScroll);
        this.chat?.removeEventListener('wheel', this.onWheel);
        this.reset();
        this.chat = chat;
        this.chat?.addEventListener('scroll', this.onScroll, { passive: true });
        this.chat?.addEventListener('wheel', this.onWheel, { passive: true });
    }

    defer() {
        if (!this.started || this.document.hidden) return;
        this.scrollEvents++;
        this.idleAt = this.now() + SETTLE_MS;
        if (this.timer !== null) return;
        const settle = () => {
            const remaining = this.idleAt - this.now();
            if (remaining > 0) {
                this.timer = this.setTimer(settle, remaining);
                return;
            }
            this.timer = null;
            if (this.started) this.onIdle();
        };
        this.timer = this.setTimer(settle, SETTLE_MS);
    }

    reset() {
        if (this.timer !== null) this.clearTimer(this.timer);
        this.timer = null;
    }

    stop() {
        if (!this.started) return;
        this.bind(null);
        this.started = false;
        this.document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }

    getReport() { return { active: this.active, scrollEvents: this.scrollEvents, settleMs: SETTLE_MS }; }
}
