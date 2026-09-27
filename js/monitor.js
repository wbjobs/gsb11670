/* monitor.js — FPS 采样、JS 堆内存采样、PerformanceObserver 长任务监控 */
(function (global) {
  'use strict';

  class Monitor {
    constructor() {
      this.fps = 0;
      this.longtaskCount = 0;
      this.memoryMB = null;
      this.memorySupported = !!(performance.memory && performance.memory.usedJSHeapSize);
      this.#startFpsLoop();
      this.#startLongtaskObserver();
    }

    #startFpsLoop() {
      let frames = 0;
      let last = performance.now();
      const tick = (now) => {
        frames++;
        if (now - last >= 1000) {
          this.fps = Math.round((frames * 1000) / (now - last));
          frames = 0;
          last = now;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    #startLongtaskObserver() {
      if (!('PerformanceObserver' in window)) return;
      try {
        const obs = new PerformanceObserver((list) => {
          this.longtaskCount += list.getEntries().length;
        });
        obs.observe({ entryTypes: ['longtask'] });
      } catch (_) { /* 浏览器不支持 longtask 时静默降级 */ }
    }

    sampleMemory() {
      if (!this.memorySupported) return null;
      this.memoryMB = performance.memory.usedJSHeapSize / 1048576;
      return this.memoryMB;
    }

    reset() { this.longtaskCount = 0; }
  }

  /** 用 performance.mark/measure 记录单次解码耗时 */
  function measureDecode(strategyKey, seq, fn) {
    const start = `${strategyKey}-start-${seq}`;
    const end = `${strategyKey}-end-${seq}`;
    performance.mark(start);
    return Promise.resolve()
      .then(fn)
      .then((res) => {
        performance.mark(end);
        performance.measure(`decode:${strategyKey}`, start, end);
        const entries = performance.getEntriesByName(`decode:${strategyKey}`);
        const duration = entries.length ? entries[entries.length - 1].duration : 0;
        performance.clearMarks(start); performance.clearMarks(end);
        performance.clearMeasures(`decode:${strategyKey}`);
        return { result: res, duration };
      })
      .catch((err) => {
        performance.clearMarks(start); performance.clearMarks(end);
        throw err;
      });
  }

  global.Monitor = Monitor;
  global.measureDecode = measureDecode;
})(window);
