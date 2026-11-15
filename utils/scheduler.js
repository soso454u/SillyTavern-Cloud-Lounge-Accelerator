const PRIORITY_COUNT = 5;
const BACKGROUND_PRIORITY = 2;
const DEFAULT_FRAME_MS = 1000 / 60;

export class FrameScheduler {
    constructor({ budgetMs = 9, onError = null } = {}) {
        this.budgetMs = Math.min(12, Math.max(6, Number(budgetMs) || 9));
        this.onError = typeof onError === 'function' ? onError : null;
        this.queues = Array.from({ length: PRIORITY_COUNT }, () => []);
        this.frameId = null;
        this.flushing = false;
        this.timeoutFrame = false;
        this.lastFrameTime = null;
        this.frameInterval = DEFAULT_FRAME_MS;
        this.generation = 0;
        this.destroyed = false;
    }

    schedule(callback, { priority = 2, signal = null } = {}) {
        if (this.destroyed) return Promise.reject(new DOMException('调度器已关闭', 'AbortError'));
        if (signal?.aborted) return Promise.reject(signal.reason);
        const queueIndex = Math.min(PRIORITY_COUNT - 1, Math.max(0, Math.trunc(Number(priority)) || 0));
        const generation = this.generation;
        return new Promise((resolve, reject) => {
            this.queues[queueIndex].push({ callback, resolve, reject, signal, generation, priority: queueIndex });
            this.#requestFrame();
        });
    }

    yield(priority = 2, signal = null) {
        return this.schedule(() => undefined, { priority, signal });
    }

    cancelAll(reason = '任务已取消') {
        this.generation += 1;
        if (this.frameId !== null) {
            if (this.timeoutFrame) clearTimeout(this.frameId);
            else cancelAnimationFrame(this.frameId);
        }
        this.frameId = this.lastFrameTime = null;
        const error = new DOMException(reason, 'AbortError');
        for (const queue of this.queues) {
            for (const task of queue.splice(0)) task.reject(error);
        }
    }

    destroy() {
        this.cancelAll('调度器已关闭');
        this.destroyed = true;
    }

    get pendingCount() {
        return this.queues.reduce((total, queue) => total + queue.length, 0);
    }

    #requestFrame() {
        if (this.frameId !== null || this.flushing || this.destroyed || this.pendingCount === 0) return;
        const requestedAt = performance.now();
        this.timeoutFrame = Boolean(globalThis.document?.hidden);
        if (this.timeoutFrame) {
            this.frameId = setTimeout(() => this.#flush(null, requestedAt), DEFAULT_FRAME_MS);
        } else {
            this.frameId = requestAnimationFrame(time => this.#flush(time, requestedAt));
        }
    }

    #nextTask(allowBackground) {
        const limit = allowBackground ? PRIORITY_COUNT : BACKGROUND_PRIORITY;
        for (let index = 0; index < limit; index++) {
            const queue = this.queues[index];
            if (queue.length) return queue.shift();
        }
        return null;
    }

    #flush(frameTime, requestedAt) {
        this.frameId = null;
        const startedAt = performance.now();
        if (this.lastFrameTime !== null && frameTime !== null) {
            const interval = frameTime - this.lastFrameTime;
            if (interval >= 4 && interval <= DEFAULT_FRAME_MS + 2) {
                this.frameInterval += (interval - this.frameInterval) / 4;
            }
        }
        this.lastFrameTime = frameTime;
        const delayed = startedAt - requestedAt > this.frameInterval * 1.5;
        const budget = Math.min(this.budgetMs, this.frameInterval * (delayed ? 0.25 : 0.55));
        const deadline = startedAt + Math.max(2, budget);
        const backgroundDeadline = startedAt + Math.max(2, budget * 0.55);
        this.flushing = true;
        try {
            for (let now = performance.now(); now < deadline; now = performance.now()) {
                const task = this.#nextTask(now < backgroundDeadline);
                if (!task) break;
                if (task.generation !== this.generation || task.signal?.aborted) {
                    task.reject(task.signal?.reason || new DOMException('任务已取消', 'AbortError'));
                    continue;
                }
                try {
                    // Callbacks can check the same deadline between small units of work.
                    const taskDeadline = task.priority < BACKGROUND_PRIORITY ? deadline : backgroundDeadline;
                    Promise.resolve(task.callback(taskDeadline)).then(task.resolve, error => {
                        task.reject(error);
                        this.onError?.(error);
                    });
                } catch (error) {
                    task.reject(error);
                    this.onError?.(error);
                }
            }
        } finally {
            this.flushing = false;
            this.#requestFrame();
        }
    }
}
