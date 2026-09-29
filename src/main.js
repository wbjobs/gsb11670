import { generateImages, releaseItems } from './images.js';
import { SCHEMES, decode, BitmapWorkerPool } from './decoders.js';
import { runPool } from './queue.js';
import { Monitor } from './monitor.js';

const $ = (s) => document.querySelector(s);

const els = {
  count: $('#opt-count'), size: $('#opt-size'), format: $('#opt-format'),
  concurrency: $('#opt-concurrency'), corrupt: $('#opt-corrupt'),
  btnGen: $('#btn-gen'), btnRunAll: $('#btn-run-all'), btnCancel: $('#btn-cancel'),
  btnClear: $('#btn-clear'), btnReset: $('#btn-reset'),
  genProgress: $('#gen-progress'), genProgressText: $('#gen-progress-text'),
  fps: $('#m-fps'), heap: $('#m-heap'), decoded: $('#m-decoded'),
  longtasks: $('#m-longtasks'), spark: $('#m-spark'),
  grid: $('#grid'), gridSummary: $('#grid-summary'), log: $('#log'),
};

const state = {
  items: [],
  pool: new BitmapWorkerPool(),
  running: false,
  token: null,
  liveBytes: 0,          // 驻留解码内存估算（全尺寸 RGBA）
  stats: {},             // schemeId -> 统计
};

// ---------- 工具 ----------

function fmtBytes(bytes) {
  if (bytes == null) return 'N/A';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function fmtMs(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`; }

function log(msg, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}.${String(Date.now() % 1000).padStart(3, '0')}] ${msg}`;
  els.log.prepend(line);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

// ---------- 监控 ----------

const heapHistory = [];
const sparkCtx = els.spark.getContext('2d');

function drawSpark() {
  const { width, height } = els.spark;
  sparkCtx.clearRect(0, 0, width, height);
  if (heapHistory.length < 2) return;
  const max = Math.max(...heapHistory, 1);
  sparkCtx.strokeStyle = '#4f8cff';
  sparkCtx.lineWidth = 1.5;
  sparkCtx.beginPath();
  heapHistory.forEach((v, i) => {
    const x = (i / (heapHistory.length - 1)) * width;
    const y = height - (v / max) * (height - 4) - 2;
    i === 0 ? sparkCtx.moveTo(x, y) : sparkCtx.lineTo(x, y);
  });
  sparkCtx.stroke();
}

const monitor = new Monitor(({ fps, heap, longtasks }) => {
  els.fps.textContent = fps;
  els.heap.textContent = heap == null ? 'N/A（仅 Chromium）' : fmtBytes(heap);
  els.longtasks.textContent = longtasks;
  if (heap != null) {
    heapHistory.push(heap);
    if (heapHistory.length > 120) heapHistory.shift();
    drawSpark();
  }
});
monitor.start();

function updateDecoded() {
  els.decoded.textContent = fmtBytes(state.liveBytes);
}

// ---------- 图片卡片 ----------

function renderGrid() {
  els.grid.innerHTML = '';
  for (const item of state.items) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <canvas width="320" height="200"></canvas>
      <div class="meta">
        <span class="name" title="${item.name}">${item.name} · ${fmtBytes(item.size)}</span>
        <span class="badge ready">待解码</span>
      </div>
      <div class="meta"><span class="time"></span></div>`;
    els.grid.appendChild(card);
    item.el = {
      canvas: card.querySelector('canvas'),
      badge: card.querySelector('.badge'),
      time: card.querySelector('.time'),
    };
    drawPlaceholder(item);
  }
  updateGridSummary();
}

function updateGridSummary() {
  const total = state.items.length;
  const size = state.items.reduce((s, it) => s + it.size, 0);
  els.gridSummary.textContent = total
    ? `共 ${total} 张 · ${state.items[0].width}×${state.items[0].height} · 编码体积 ${fmtBytes(size)} · 单张解码约 ${fmtBytes(state.items[0].width * state.items[0].height * 4)}`
    : '';
}

function setStatus(item, status, text) {
  const labels = {
    ready: '待解码', decoding: '解码中…', done: '完成',
    fallback: '已降级', cancelled: '已取消', error: '失败',
  };
  item.el.badge.className = `badge ${status}`;
  item.el.badge.textContent = labels[status] || status;
  if (text !== undefined) item.el.time.textContent = text;
}

function drawPlaceholder(item) {
  const ctx = item.el.canvas.getContext('2d');
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0, item.el.canvas.width, item.el.canvas.height);
  img.src = item.placeholder; // 低分辨率占位，天然模糊
}

function drawSource(item, source) {
  const ctx = item.el.canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, item.el.canvas.width, item.el.canvas.height);
}

// 解码失败降级：展示低分辨率占位图
async function applyFallback(item) {
  drawPlaceholder(item);
}

// ---------- 解码执行 ----------

async function runScheme(schemeId) {
  if (!state.items.length) { log('请先生成图片', 'warn'); return false; }

  const token = { cancelled: false };
  state.token = token;
  const stat = {
    times: [], failures: 0, fallbacks: 0, cancelled: 0,
    wallMs: 0, heapStart: monitor.heap, heapPeak: null,
  };
  state.stats[schemeId] = stat;
  monitor.resetPeak();

  const limit = Math.max(1, Math.min(8, +els.concurrency.value || 3));
  log(`[${schemeId}] 开始解码 ${state.items.length} 张，并发 ${limit}`);

  const t0 = performance.now();
  const tasks = state.items.map((item) => async () => {
    if (token.cancelled) { stat.cancelled++; setStatus(item, 'cancelled', ''); return; }
    setStatus(item, 'decoding');
    try {
      const r = await decode(schemeId, item, token, state.pool);
      if (token.cancelled) { r.release(); stat.cancelled++; setStatus(item, 'cancelled', ''); return; }

      // 驻留解码内存估算：全尺寸 RGBA，绘制后立即释放
      state.liveBytes += item.width * item.height * 4;
      updateDecoded();
      drawSource(item, r.source);
      r.release();
      state.liveBytes -= item.width * item.height * 4;
      updateDecoded();

      stat.times.push(r.durationMs);
      setStatus(item, 'done', `${fmtMs(r.durationMs)}${r.note ? ' · ' + r.note : ''}`);
      if (r.note) log(`[${schemeId}] ${item.name}: ${r.note}`, 'warn');
    } catch (err) {
      if (err && err.cancelled) {
        stat.cancelled++;
        setStatus(item, 'cancelled', '');
      } else {
        // 解码失败 → 降级到低分辨率占位图
        stat.failures++;
        stat.fallbacks++;
        await applyFallback(item);
        setStatus(item, 'fallback', `失败已降级（${err.message}）`);
        log(`[${schemeId}] ${item.name} 解码失败，已降级占位图：${err.message}`, 'err');
      }
    }
    stat.heapPeak = monitor.peakHeap;
  });

  await runPool(tasks, limit);
  stat.wallMs = performance.now() - t0;

  const ok = stat.times.length;
  log(`[${schemeId}] 结束：成功 ${ok}，失败降级 ${stat.fallbacks}，取消 ${stat.cancelled}，总耗时 ${fmtMs(stat.wallMs)}`, ok ? 'ok' : 'warn');
  renderStats();
  return !token.cancelled;
}

function setRunning(running) {
  state.running = running;
  els.btnGen.disabled = running;
  els.btnRunAll.disabled = running || !state.items.length;
  els.btnCancel.disabled = !running;
  document.querySelectorAll('[data-run]').forEach((b) => { b.disabled = running || !state.items.length; });
}

async function guardedRun(fn) {
  if (state.running) return;
  setRunning(true);
  try { await fn(); } finally { setRunning(false); }
}

// ---------- 统计渲染 ----------

function renderStats() {
  const avgs = {};
  for (const s of SCHEMES) {
    const st = state.stats[s.id];
    if (st && st.times.length) avgs[s.id] = st.times.reduce((a, b) => a + b, 0) / st.times.length;
  }
  const maxAvg = Math.max(...Object.values(avgs), 1);

  for (const s of SCHEMES) {
    const card = document.querySelector(`.scheme-card[data-scheme="${s.id}"]`);
    const dl = card.querySelector('.stats');
    const fill = card.querySelector('.bar-fill');
    const label = card.querySelector('.bar-label');
    const st = state.stats[s.id];

    if (!st) { dl.innerHTML = '<div><dt>—</dt><dd>尚未运行</dd></div>'; continue; }

    const sorted = [...st.times].sort((a, b) => a - b);
    const avg = st.times.length ? st.times.reduce((a, b) => a + b, 0) / st.times.length : 0;
    const heapDelta = (st.heapPeak != null && st.heapStart != null) ? st.heapPeak - st.heapStart : null;

    dl.innerHTML = `
      <div><dt>平均解码</dt><dd>${st.times.length ? fmtMs(avg) : '—'}</dd></div>
      <div><dt>P95</dt><dd>${st.times.length ? fmtMs(percentile(sorted, 95)) : '—'}</dd></div>
      <div><dt>最小 / 最大</dt><dd>${st.times.length ? `${fmtMs(sorted[0])} / ${fmtMs(sorted[sorted.length - 1])}` : '—'}</dd></div>
      <div><dt>总耗时（墙钟）</dt><dd>${fmtMs(st.wallMs)}</dd></div>
      <div><dt>成功 / 降级 / 取消</dt><dd>${st.times.length} / ${st.fallbacks} / ${st.cancelled}</dd></div>
      <div><dt>堆增量峰值</dt><dd>${heapDelta != null ? fmtBytes(heapDelta) : 'N/A'}</dd></div>`;

    if (avgs[s.id] != null) {
      fill.style.width = `${(avgs[s.id] / maxAvg) * 100}%`;
      fill.style.background = avgs[s.id] === Math.min(...Object.values(avgs)) ? 'var(--ok)' : 'var(--accent)';
      label.textContent = `平均 ${fmtMs(avgs[s.id])}`;
    }
  }
}

// ---------- 按钮动作 ----------

els.btnGen.addEventListener('click', () => guardedRun(async () => {
  releaseItems(state.items);
  state.items = [];
  state.stats = {};
  renderStats();
  els.grid.innerHTML = '';

  const [w, h] = els.size.value.split('x').map(Number);
  const count = Math.max(1, Math.min(60, +els.count.value || 6));
  const estBytes = w * h * 4 * Math.min(8, +els.concurrency.value || 3);
  log(`开始生成 ${count} 张 ${w}×${h}（${els.format.value}），并发峰值解码内存估算 ${fmtBytes(estBytes)}`);

  els.genProgress.classList.remove('hidden');
  try {
    state.items = await generateImages({
      count, width: w, height: h,
      mime: els.format.value,
      corruptOne: els.corrupt.checked,
      onProgress: (done, total) => { els.genProgressText.textContent = `${done}/${total}`; },
    });
  } finally {
    els.genProgress.classList.add('hidden');
  }
  renderGrid();
  const corrupted = state.items.find((it) => it.corrupted);
  log(`生成完成：${state.items.map((it) => it.mime.replace('image/', '')).join(', ')}${corrupted ? `；已注入损坏文件 ${corrupted.name}` : ''}`, 'ok');
}));

els.btnRunAll.addEventListener('click', () => guardedRun(async () => {
  for (const s of SCHEMES) {
    const finished = await runScheme(s.id);
    if (!finished) { log('已取消，终止后续方案', 'warn'); break; }
    // 方案间留出空闲，让 GC 有机会回收，保证对照公平
    await new Promise((r) => setTimeout(r, 400));
  }
}));

document.querySelectorAll('[data-run]').forEach((btn) => {
  btn.addEventListener('click', () => guardedRun(() => runScheme(btn.dataset.run)));
});

els.btnCancel.addEventListener('click', () => {
  if (state.token) state.token.cancelled = true;
  state.pool.terminateAll(); // 终止 Worker，立即释放其解码内存
  log('已请求取消：进行中的解码将被丢弃', 'warn');
});

els.btnClear.addEventListener('click', () => {
  if (state.running) return;
  state.stats = {};
  state.liveBytes = 0;
  updateDecoded();
  for (const item of state.items) {
    setStatus(item, 'ready', '');
    item.el.time.textContent = '';
    drawPlaceholder(item);
  }
  renderStats();
  log('已清空解码结果与统计（图片资源保留）');
});

els.btnReset.addEventListener('click', () => {
  if (state.running) return;
  releaseItems(state.items);
  state.items = [];
  state.stats = {};
  state.liveBytes = 0;
  updateDecoded();
  els.grid.innerHTML = '';
  updateGridSummary();
  renderStats();
  els.btnRunAll.disabled = true;
  document.querySelectorAll('[data-run]').forEach((b) => { b.disabled = true; });
  log('已重置：释放全部 ObjectURL 与解码资源', 'ok');
});

renderStats();
