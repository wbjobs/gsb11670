// 运行时监控：FPS（rAF 计帧）、JS 堆内存（performance.memory，Chromium）、
// 长任务（PerformanceObserver / longtask）。
export class Monitor {
  constructor(onSample) {
    this.onSample = onSample;
    this.fps = 0;
    this.heap = null;       // 最新 usedJSHeapSize（字节），不支持时为 null
    this.peakHeap = null;   // 采样期间堆峰值
    this.longtasks = 0;
    this._frames = 0;
    this._lastSample = performance.now();
    this._raf = 0;

    try {
      this._po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'longtask') this.longtasks++;
        }
      });
      this._po.observe({ entryTypes: ['longtask'] });
    } catch {
      this._po = null; // 浏览器不支持 longtask 观察，静默降级
    }
  }

  start() {
    const loop = () => {
      this._frames++;
      const now = performance.now();
      const elapsed = now - this._lastSample;
      if (elapsed >= 500) {
        this.fps = Math.round((this._frames * 1000) / elapsed);
        this._frames = 0;
        this._lastSample = now;
        if (performance.memory) {
          this.heap = performance.memory.usedJSHeapSize;
          this.peakHeap = Math.max(this.peakHeap ?? 0, this.heap);
        }
        this.onSample({ fps: this.fps, heap: this.heap, longtasks: this.longtasks });
      }
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  resetPeak() { this.peakHeap = this.heap; }

  stop() { cancelAnimationFrame(this._raf); this._po?.disconnect(); }
}
