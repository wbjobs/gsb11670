/* genimages.js — 程序化生成大图样本（离线可用），并支持构造损坏样本 */
(function (global) {
  'use strict';

  const FORMATS = ['image/jpeg', 'image/png', 'image/webp'];
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

  // 检测当前浏览器实际支持的编码格式（toBlob 不支持时会回退为 png）
  function detectSupportedFormats() {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return FORMATS.filter((t) => c.toDataURL(t).startsWith('data:' + t));
  }

  function pickFormat(choice, index, supported) {
    if (choice !== 'mixed') {
      return supported.includes(choice) ? choice : supported[0] || 'image/png';
    }
    return supported[index % supported.length] || 'image/png';
  }

  // 在画布上绘制高细节内容（渐变 + 网格 + 随机圆），让编码产物足够"重"
  function paintScene(ctx, w, h, seed) {
    const rand = mulberry32(seed);
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, `hsl(${rand() * 360},70%,45%)`);
    grad.addColorStop(0.5, `hsl(${rand() * 360},60%,35%)`);
    grad.addColorStop(1, `hsl(${rand() * 360},75%,50%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2;
    const step = Math.max(40, Math.floor(w / 60));
    for (let x = 0; x < w; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

    const circles = 400;
    for (let i = 0; i < circles; i++) {
      ctx.beginPath();
      ctx.fillStyle = `hsla(${rand() * 360},80%,60%,0.25)`;
      ctx.arc(rand() * w, rand() * h, 10 + rand() * (w / 40), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `${Math.floor(h / 12)}px sans-serif`;
    ctx.fillText(`#${seed} ${w}x${h}`, w * 0.05, h * 0.9);
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 失败: ' + type))), type, quality);
    });
  }

  /**
   * 生成一批大图样本。
   * @returns Promise<Array<{name, blob, format, width, height, corrupt}>>
   */
  async function generateSamples({ count, width, height, formatChoice, injectCorrupt }) {
    const supported = detectSupportedFormats();
    const samples = [];
    // 逐张生成并让出主线程，避免一次性卡顿
    for (let i = 0; i < count; i++) {
      const format = pickFormat(formatChoice, i, supported);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      paintScene(ctx, width, height, i + 1);
      const quality = format === 'image/png' ? undefined : 0.9;
      let blob = await canvasToBlob(canvas, format, quality);
      let corrupt = false;
      // 每 5 张注入 1 张截断的损坏数据，用于验证解码失败降级路径
      if (injectCorrupt && i % 5 === 4) {
        blob = blob.slice(0, Math.floor(blob.size / 2), blob.type);
        corrupt = true;
      }
      samples.push({
        name: `sample-${String(i + 1).padStart(2, '0')}.${EXT[format] || 'img'}`,
        blob, format, width, height, corrupt,
      });
      canvas.width = canvas.height = 0; // 及时释放源画布显存
      await new Promise((r) => setTimeout(r, 0));
    }
    return { samples, supported };
  }

  /** 把用户选择的本地文件包装成统一样本结构 */
  function filesToSamples(files) {
    return Array.from(files).map((f) => ({
      name: f.name, blob: f, format: f.type || '未知',
      width: 0, height: 0, corrupt: false,
    }));
  }

  global.GenImages = { generateSamples, filesToSamples, detectSupportedFormats };
})(window);
