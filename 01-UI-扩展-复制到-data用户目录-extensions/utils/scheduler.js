const PRIORITY_COUNT = 5;

export class FrameScheduler {
    constructor({ budgetMs = 9, onError = null } = {}) {
        this.budgetMs = Math.min(12, Math.max(6, Number(budgetMs) || 9));
        this.onError = typeof onError === 'function' ? onError : null;
        this.queues = Array.from({ length: PRIORITY_COUNT }, () => []);
        this.frameId = null;
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
        const error = new DOMException(reason, 'AbortError');
        for (const queue of this.queues) {
            for (const task of queue.splice(0)) task.reject(error);
        }
    }

    destroy() {
        this.cancelAll('调度器已关闭');
        if (this.frameId !== null) cancelAnimationFrame(this.frameId);
        this.frameId = null;
        this.destroyed = true;
    }

    get pendingCount() {
        return this.queues.reduce((total, queue) => total + queue.length, 0);
    }

    #requestFrame() {
        if (this.frameId !== null || this.destroyed || this.pendingCount === 0) return;
        this.frameId = requestAnimationFrame(() => this.#flush());
    }

    #nextTask() {
        for (const queue of this.queues) if (queue.length) return queue.shift();
        return null;
    }

    #flush() {
        this.frameId = null;
        const startedAt = performance.now();
        while (this.pendingCount && performance.now() - startedAt < this.budgetMs) {
            const task = this.#nextTask();
            if (!task) break;
            if (task.generation !== this.generation || task.signal?.aborted) {
                task.reject(task.signal?.reason || new DOMException('任务已取消', 'AbortError'));
                continue;
            }
            try {
                Promise.resolve(task.callback()).then(task.resolve, error => {
                    task.reject(error);
                    this.onError?.(error);
                });
            } catch (error) {
                task.reject(error);
                this.onError?.(error);
            }
        }
        this.#requestFrame();
    }
}
