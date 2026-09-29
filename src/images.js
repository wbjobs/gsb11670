// 大图生成：在 Canvas 上绘制确定性场景并编码为 JPEG / PNG / WebP。
// 同时产出低分辨率占位图（用于解码失败时的降级展示）。

const FORMAT_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// 简单可复现的伪随机数（同一种子同一张图，便于公平对比）
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawScene(ctx, w, h, index) {
  const rand = mulberry32(index * 9973 + 7);
  const hue = (index * 47) % 360;

  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, `hsl(${hue}, 60%, 32%)`);
  grad.addColorStop(1, `hsl(${(hue + 120) % 360}, 55%, 18%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // 大量圆形与线条，制造真实的解码负担
  const circles = Math.round((w * h) / 90000);
  for (let i = 0; i < circles; i++) {
    ctx.beginPath();
    ctx.fillStyle = `hsla(${Math.floor(rand() * 360)}, 70%, ${40 + rand() * 40}%, ${0.12 + rand() * 0.3})`;
    ctx.arc(rand() * w, rand() * h, 20 + rand() * (w / 14), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineWidth = Math.max(2, w / 1200);
  for (let i = 0; i < 60; i++) {
    ctx.strokeStyle = `hsla(${Math.floor(rand() * 360)}, 80%, 70%, 0.25)`;
    ctx.beginPath();
    ctx.moveTo(rand() * w, rand() * h);
    ctx.bezierCurveTo(rand() * w, rand() * h, rand() * w, rand() * h, rand() * w, rand() * h);
    ctx.stroke();
  }
  // 文字标注（占图很小，不影响编码体积公平性）
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `${Math.round(w / 28)}px sans-serif`;
  ctx.fillText(`#${index}  ${w}×${h}`, w * 0.04, h * 0.12);
}

function toBlob(canvas, mime, quality) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), mime, quality));
}

// 低分辨率占位图（宽 48px 的模糊缩略图，dataURL 便于直接绘制）
function makePlaceholder(sourceCanvas) {
  const pw = 48;
  const ph = Math.max(1, Math.round((sourceCanvas.height / sourceCanvas.width) * pw));
  const c = document.createElement('canvas');
  c.width = pw; c.height = ph;
  c.getContext('2d').drawImage(sourceCanvas, 0, 0, pw, ph);
  return c.toDataURL('image/jpeg', 0.5);
}

export function checkFormatSupport(mime) {
  try {
    return document.createElement('canvas').toDataURL(mime).startsWith(`data:${mime}`);
  } catch {
    return false;
  }
}

/**
 * 批量生成大图。
 * @returns items: { uid, name, blob, url, placeholder, width, height, mime, size, corrupted }
 */
export async function generateImages({ count, width, height, mime, corruptOne, onProgress }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const mimes = mime === 'mixed' ? ['image/jpeg', 'image/png', 'image/webp'] : [mime];
  const items = [];

  for (let i = 0; i < count; i++) {
    const wanted = mimes[i % mimes.length];
    drawScene(ctx, width, height, i);

    // 格式差异处理：浏览器不支持目标格式时回退 PNG
    let actualMime = wanted;
    let blob = checkFormatSupport(wanted) ? await toBlob(canvas, wanted, 0.92) : null;
    if (!blob || blob.type !== wanted) {
      actualMime = 'image/png';
      blob = await toBlob(canvas, 'image/png');
    }

    // 注入损坏文件：截掉文件头，保证解码必然失败，用于验证降级链路
    const corrupted = corruptOne && i === count - 1;
    if (corrupted) blob = blob.slice(200);

    items.push({
      uid: i,
      name: `img-${String(i).padStart(2, '0')}.${FORMAT_EXT[actualMime] || 'bin'}`,
      blob,
      url: URL.createObjectURL(blob),
      placeholder: makePlaceholder(canvas),
      width,
      height,
      mime: actualMime,
      size: blob.size,
      corrupted,
    });

    onProgress?.(i + 1, count);
    await new Promise((r) => setTimeout(r)); // 让出主线程，避免生成阶段卡死 UI
  }
  return items;
}

export function releaseItems(items) {
  for (const it of items) URL.revokeObjectURL(it.url);
}
