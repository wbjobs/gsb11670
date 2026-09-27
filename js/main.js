/* main.js — 编排：批量加载、并发控制、降级、指标采集、内存回收 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    strategy: $('strategy'), count: $('count'), size: $('size'), format: $('format'),
    concurrency: $('concurrency'), progressive: $('progressive'), injectCorrupt: $('injectCorrupt'),
    btnLoad: $('btnLoad'), btnCancel: $('btnCancel'), btnClear: $('btnClear'), btnReset: $('btnReset'),
    fileInput: $('fileInput'), grid: $('grid'), cardTpl: $('cardTpl'),
    statFps: $('statFps'), statMem: $('statMem'), statLongtask: $('statLongtask'),
    statDone: $('statDone'), statFailed: $('statFailed'), statElapsed: $('statElapsed'),
    perfTableBody: document.querySelector('#perfTable tbody'),
  };

  const monitor = new Monitor();
  const metrics = new Map(); // strategyKey -> number[]
  let pool = null;
  let running = false;
  let cards = []; // { el, handle, status }
  let stats = { total: 0, done: 0, failed: 0, degraded: 0, startTime: 0 };

  const THUMB_W = 440, THUMB_H = 280;

  /* ---------- 卡片 ---------- */
  function createCard(sample) {
    const node = els.cardTpl.content.firstElementChild.cloneNode(true);
    node.querySelector('.name').textContent = sample.name;
    node.querySelector('.info').textContent =
      `${sample.format}${sample.width ? ` · ${sample.width}×${sample.height}` : ''} · ${(sample.blob.size / 1048576).toFixed(2)} MB`;
    els.grid.appendChild(node);
    const card = { el: node, handle: null, status: 'pending' };
    cards.push(card);
    return card;
  }

  function setBadge(card, text, cls) {
    const badge = card.el.querySelector('.badge');
    badge.textContent = text;
    badge.className = 'badge' + (cls ? ' ' + cls : '');
  }

  function drawToCard(card, handle) {
    const thumb = card.el.querySelector('.thumb');
    thumb.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_W; canvas.height = THUMB_H;
    const ctx = canvas.getContext('2d');
    handle.draw(ctx, THUMB_W, THUMB_H);
    thumb.appendChild(canvas);
  }

  function releaseCard(card) {
    if (card.handle) { try { card.handle.cleanup(); } catch (_) {} card.handle = null; }
  }

  /** 解码彻底失败时的低分辨率占位图（降级兜底） */
  function drawFailurePlaceholder(card, reason) {
    const thumb = card.el.querySelector('.thumb');
    thumb.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_W; canvas.height = THUMB_H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2a2f45'; ctx.fillRect(0, 0, THUMB_W, THUMB_H);
    ctx.fillStyle = '#8b93a7'; ctx.font = '16px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('解码失败 · 低分辨率占位', THUMB_W / 2, THUMB_H / 2 - 8);
    ctx.font = '12px sans-serif';
    ctx.fillText(String(reason).slice(0, 40), THUMB_W / 2, THUMB_H / 2 + 16);
    thumb.appendChild(canvas);
  }

  /* ---------- 单张解码（含渐进式占位与失败降级） ---------- */
  async function decodeOne(sample, card, strategyKey, isCancelled) {
    const strategy = Strategies.STRATEGIES[strategyKey];
    setBadge(card, '解码中', 'loading');

    // 渐进式：先用 createImageBitmap 的 resize 选项出低分辨率占位，再全分辨率
    if (els.progressive.checked && strategy.supportResize) {
      try {
        const low = await strategy.fn(sample.blob, {
          isCancelled, resize: { width: THUMB_W, height: THUMB_H },
        });
        if (isCancelled()) { low.cleanup(); throw new CancelledError(); }
        drawToCard(card, low);
        low.cleanup(); // 占位图用完立即释放
        setBadge(card, '占位→全分辨率', 'loading');
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        // 低分辨率失败不阻断，继续尝试全分辨率
      }
    }

    const { result: handle, duration } = await measureDecode(strategyKey, sample.name, () =>
      strategy.fn(sample.blob, { isCancelled })
    );
    recordMetric(strategyKey, duration);

    // 释放上一张（渐进式占位已单独释放，这里防御性处理）
    releaseCard(card);
    card.handle = handle;
    drawToCard(card, handle);
    card.el.querySelector('.time').textContent = `${duration.toFixed(1)} ms`;
    setBadge(card, `完成 · ${handle.width}×${handle.height}`, 'ok');
  }

  /** 失败降级链：换 createImageBitmap 再试一次 → 仍失败则低分辨率占位 */
  async function decodeWithFallback(sample, card, strategyKey, isCancelled) {
    try {
      await decodeOne(sample, card, strategyKey, isCancelled);
      stats.done++;
    } catch (err) {
      if (err instanceof CancelledError) { setBadge(card, '已取消', 'cancelled'); return; }
      try {
        const handle = await Strategies.STRATEGIES.createImageBitmap.fn(sample.blob, { isCancelled });
        releaseCard(card);
        card.handle = handle;
        drawToCard(card, handle);
        setBadge(card, '降级解码成功', 'degraded');
        stats.degraded++;
      } catch (fallbackErr) {
        if (fallbackErr instanceof CancelledError) { setBadge(card, '已取消', 'cancelled'); return; }
        drawFailurePlaceholder(card, err.message);
        setBadge(card, '失败·已占位', 'failed');
        stats.failed++;
      }
    }
  }

  /* ---------- 指标 ---------- */
  function recordMetric(key, duration) {
    if (!metrics.has(key)) metrics.set(key, []);
    metrics.get(key).push(duration);
    renderPerfTable();
  }

  function percentile(arr, p) {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  }

  function renderPerfTable() {
    if (!metrics.size) {
      els.perfTableBody.innerHTML = '<tr><td colspan="7" class="empty">暂无数据，点击「开始批量加载」</td></tr>';
      return;
    }
    let bestAvg = Infinity;
    const rows = [...metrics.entries()].map(([key, arr]) => {
      const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
      bestAvg = Math.min(bestAvg, avg);
      return { key, arr, avg };
    });
    els.perfTableBody.innerHTML = rows.map(({ key, arr, avg }) => `
      <tr class="${avg === bestAvg && rows.length > 1 ? 'best' : ''}">
        <td>${Strategies.STRATEGIES[key].label}${avg === bestAvg && rows.length > 1 ? ' 🏆' : ''}</td>
        <td>${arr.length}</td>
        <td>${avg.toFixed(1)}</td>
        <td>${Math.min(...arr).toFixed(1)}</td>
        <td>${Math.max(...arr).toFixed(1)}</td>
        <td>${percentile(arr, 95).toFixed(1)}</td>
        <td>${arr.reduce((s, v) => s + v, 0).toFixed(0)}</td>
      </tr>`).join('');
  }

  /* ---------- 批量执行 ---------- */
  async function runBatch(samples, strategyKey) {
    pool = new DecodePool(Number(els.concurrency.value) || 3);
    stats.total += samples.length;
    const tasks = samples.map((sample) => {
      const card = createCard(sample);
      return pool.add((isCancelled) => decodeWithFallback(sample, card, strategyKey, isCancelled))
        .catch(() => {}); // 取消/失败已在卡片上体现
    });
    await Promise.all(tasks);
  }

  async function startLoad(fileSamples) {
    if (running) return;
    running = true;
    setLoadingUI(true);
    clearGrid();
    monitor.reset();
    stats = { total: 0, done: 0, failed: 0, degraded: 0, startTime: performance.now() };

    try {
      let samples = fileSamples;
      if (!samples) {
        const [w, h] = els.size.value.split('x').map(Number);
        setGlobalStatus('正在生成测试大图…');
        const gen = await GenImages.generateSamples({
          count: Number(els.count.value) || 12,
          width: w, height: h,
          formatChoice: els.format.value,
          injectCorrupt: els.injectCorrupt.checked,
        });
        samples = gen.samples;
      }

      const choice = els.strategy.value;
      if (choice === 'all' && !fileSamples) {
        // 基准模式：三种方案依次跑同一批样本，结果汇总到对照表
        for (const key of ['createImageBitmap', 'imageElement', 'imgDecode']) {
          if (!running) break;
          clearGrid();
          await runBatch(samples, key);
        }
      } else {
        const key = choice === 'all' ? 'createImageBitmap' : choice;
        await runBatch(samples, key);
      }
    } finally {
      stats.elapsed = performance.now() - stats.startTime;
      running = false;
      setLoadingUI(false);
    }
  }

  function setGlobalStatus() { /* 状态通过卡片与统计区体现，预留扩展 */ }

  /* ---------- 清空 / 重置 ---------- */
  function clearGrid() {
    if (pool) { pool.cancel(); pool = null; }
    cards.forEach(releaseCard); // 关闭 ImageBitmap / 回收 ObjectURL，及时释放内存
    cards = [];
    els.grid.innerHTML = '';
  }

  function resetAll() {
    clearGrid();
    metrics.clear();
    monitor.reset();
    stats = { total: 0, done: 0, failed: 0, degraded: 0, startTime: 0 };
    renderPerfTable();
    updateStats();
    els.statElapsed.textContent = '--';
  }

  function setLoadingUI(loading) {
    els.btnLoad.disabled = loading;
    els.btnCancel.disabled = !loading;
  }

  /* ---------- 统计刷新 ---------- */
  function updateStats() {
    els.statFps.textContent = monitor.fps || '--';
    const mem = monitor.sampleMemory();
    els.statMem.textContent = mem == null ? '不支持(非Chromium)' : `${mem.toFixed(1)} MB`;
    els.statLongtask.textContent = monitor.longtaskCount;
    els.statDone.textContent = `${stats.done} / ${stats.total}`;
    els.statFailed.textContent = `${stats.failed} / ${stats.degraded}`;
    if (!running && stats.elapsed) els.statElapsed.textContent = `${(stats.elapsed / 1000).toFixed(2)} s`;
  }
  setInterval(updateStats, 500);

  /* ---------- 事件 ---------- */
  els.btnLoad.addEventListener('click', () => startLoad(null));
  els.btnCancel.addEventListener('click', () => {
    if (pool) pool.cancel();
    running = false;
  });
  els.btnClear.addEventListener('click', () => { clearGrid(); });
  els.btnReset.addEventListener('click', () => { resetAll(); });
  els.fileInput.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files && files.length) startLoad(GenImages.filesToSamples(files));
    e.target.value = '';
  });

  renderPerfTable();
})();
