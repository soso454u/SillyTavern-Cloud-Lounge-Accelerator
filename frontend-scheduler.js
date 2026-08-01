const PRIORITY_COUNT = 5;

function clampBudget(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(12, Math.max(6, number)) : 10;
}

export class FrameBudgetScheduler {
    constructor({ budgetMs = 10, onError = null } = {}) {
        this.budgetMs = clampBudget(budgetMs);
        this.onError = typeof onError === 'function' ? onError : null;
        this.queues = Array.from({ length: PRIORITY_COUNT }, () => []);
        this.frameId = null;
        this.paused = false;
        this.pauseFrames = 0;
        this.generation = 0;
    }

    setBudget(budgetMs) {
        this.budgetMs = clampBudget(budgetMs);
    }

    schedule(callback, { priority = 2, signal = null } = {}) {
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

    pause() {
        this.paused = true;
    }

    resume() {
        this.paused = false;
        this.#requestFrame();
    }

    pauseNextFrame() {
        this.pauseFrames = Math.max(this.pauseFrames, 1);
        this.#requestFrame();
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
        this.paused = true;
    }

    get pendingCount() {
        return this.queues.reduce((total, queue) => total + queue.length, 0);
    }

    #requestFrame() {
        if (this.frameId !== null || this.paused || this.pendingCount === 0) return;
        this.frameId = requestAnimationFrame(timestamp => this.#flush(timestamp));
    }

    #nextTask() {
        for (const queue of this.queues) {
            if (queue.length) return queue.shift();
        }
        return null;
    }

    #flush() {
        this.frameId = null;
        if (this.paused) return;
        if (this.pauseFrames > 0) {
            this.pauseFrames -= 1;
            this.#requestFrame();
            return;
        }

        const startedAt = performance.now();
        while (this.pendingCount > 0 && performance.now() - startedAt < this.budgetMs) {
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

export function budgetForIntensity(intensity) {
    return { balanced: 8, strong: 10, extreme: 12 }[intensity] || 10;
}
