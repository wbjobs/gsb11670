/* pool.js — 带取消能力的并发池，保证并发解码数量受控且结果与任务正确对应 */
(function (global) {
  'use strict';

  class DecodePool {
    constructor(concurrency) {
      this.concurrency = Math.max(1, concurrency | 0);
      this.queue = [];
      this.active = 0;
      this.cancelled = false;
    }

    /** task: async (isCancelled) => result；返回的 promise 在取消时以 CancelledError 拒绝 */
    add(task) {
      return new Promise((resolve, reject) => {
        this.queue.push({ task, resolve, reject });
        this.#pump();
      });
    }

    #pump() {
      while (!this.cancelled && this.active < this.concurrency && this.queue.length) {
        const item = this.queue.shift();
        this.active++;
        const isCancelled = () => this.cancelled;
        Promise.resolve()
          .then(() => item.task(isCancelled))
          .then((res) => {
            this.active--;
            isCancelled() ? item.reject(new CancelledError()) : item.resolve(res);
            this.#pump();
          })
          .catch((err) => {
            this.active--;
            item.reject(err);
            this.#pump();
          });
      }
    }

    /** 取消：清空队列中未开始的任务，进行中的任务通过 isCancelled 协作式退出 */
    cancel() {
      this.cancelled = true;
      const pending = this.queue.splice(0);
      pending.forEach((item) => item.reject(new CancelledError()));
    }

    get pendingCount() { return this.queue.length + this.active; }
  }

  class CancelledError extends Error {
    constructor() { super('已取消'); this.name = 'CancelledError'; }
  }

  global.DecodePool = DecodePool;
  global.CancelledError = CancelledError;
})(window);
