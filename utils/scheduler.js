const PRIORITY_COUNT = 5;
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
        const queueIndex = Math.min(PRIORITY_COUNT - 1, Math.max(0, Number(priority) || 0));
        const generation = this.generation;
        return new Promise((resolve, reject) => {
            this.queues[queueIndex].push({ callback, resolve, reject, signal, generation });
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

    #nextTask() {
        for (const queue of this.queues) if (queue.length) return queue.shift();
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
        this.flushing = true;
        try {
            while (performance.now() < deadline) {
                const task = this.#nextTask();
                if (!task) break;
                if (task.generation !== this.generation || task.signal?.aborted) {
                    task.reject(task.signal?.reason || new DOMException('任务已取消', 'AbortError'));
                    continue;
                }
                try {
                    // Callbacks can check the same deadline between small units of work.
                    Promise.resolve(task.callback(deadline)).then(task.resolve, error => {
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
