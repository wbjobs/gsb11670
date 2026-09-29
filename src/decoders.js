// 三种解码方案的统一实现。
// 每个 decode* 返回 { source, durationMs, release(), note? }：
//   source     可直接传给 ctx.drawImage 的解码结果
//   durationMs 解码耗时（performance.now 计量，并写入 performance.measure）
//   release()  释放解码资源（bitmap.close() / 断开 img.src），保证内存及时回收

export const SCHEMES = [
  { id: 'bitmap', name: 'createImageBitmap' },
  { id: 'decode', name: 'img.decode()' },
  { id: 'image', name: 'Image onload' },
];

export function cancelledError() {
  return Object.assign(new Error('cancelled'), { cancelled: true });
}

// ---- createImageBitmap（Web Worker 版） ------------------------------------

export class BitmapWorkerPool {
  constructor() { this._spawn(); }

  _spawn() {
    this.worker = new Worker(new URL('./decodeWorker.js', import.meta.url));
    this.pending = new Map();
    this.worker.onmessage = (e) => {
      const { id, ok, bitmap, error } = e.data;
      const p = this.pending.get(id);
      if (!p) { bitmap?.close?.(); return; } // 已被取消：立即回收 bitmap
      this.pending.delete(id);
      if (ok) p.res(bitmap);
      else p.rej(new Error(error || 'worker decode failed'));
    };
    this.worker.onerror = () => {
      for (const p of this.pending.values()) p.rej(new Error('worker error'));
      this.pending.clear();
    };
  }

  decode(id, blob) {
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.worker.postMessage({ id, blob });
    });
  }

  // 取消：拒绝所有挂起请求并终止 Worker（立即释放 Worker 内解码内存），再重建
  terminateAll() {
    for (const p of this.pending.values()) p.rej(cancelledError());
    this.pending.clear();
    this.worker.terminate();
    this._spawn();
  }
}

let seq = 0;

async function decodeBitmap(item, token, pool) {
  // 能力检测：环境不支持 createImageBitmap 时降级到 img.decode
  if (typeof createImageBitmap !== 'function') {
    const r = await decodeImgDecode(item, token);
    r.note = 'createImageBitmap 不可用，已降级 img.decode';
    return r;
  }
  const t0 = performance.now();
  const bitmap = await pool.decode(`${item.uid}-${seq++}`, item.blob);
  if (token.cancelled) { bitmap.close(); throw cancelledError(); }
  const durationMs = performance.now() - t0;
  performance.measure(`decode:bitmap:${item.name}`, { startTime: t0, duration: durationMs });
  return { source: bitmap, durationMs, release: () => bitmap.close() };
}

// ---- img.decode() ----------------------------------------------------------

function decodeImgDecode(item, token) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const t0 = performance.now();
    const finish = () => {
      if (token.cancelled) { img.src = ''; reject(cancelledError()); return; }
      const durationMs = performance.now() - t0;
      performance.measure(`decode:decode:${item.name}`, { startTime: t0, duration: durationMs });
      resolve({ source: img, durationMs, release: () => { img.onload = img.onerror = null; img.src = ''; } });
    };
    const fail = (e) => { img.src = ''; reject(e instanceof Error ? e : new Error('img.decode failed')); };

    if (typeof img.decode === 'function') {
      img.src = item.url;
      img.decode().then(finish, fail);
    } else {
      // 能力检测：老浏览器无 decode()，降级 onload
      img.onload = finish;
      img.onerror = fail;
      img.src = item.url;
    }
  });
}

// ---- Image onload ----------------------------------------------------------

function decodeImageOnload(item, token) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const t0 = performance.now();
    img.onload = () => {
      if (token.cancelled) { img.src = ''; reject(cancelledError()); return; }
      const durationMs = performance.now() - t0;
      performance.measure(`decode:image:${item.name}`, { startTime: t0, duration: durationMs });
      resolve({ source: img, durationMs, release: () => { img.onload = img.onerror = null; img.src = ''; } });
    };
    img.onerror = () => { img.src = ''; reject(new Error('Image onerror')); };
    img.src = item.url;
  });
}

/**
 * 统一解码入口。
 * @param schemeId 'bitmap' | 'decode' | 'image'
 * @param token    { cancelled: boolean } 协作式取消令牌
 */
export function decode(schemeId, item, token, pool) {
  if (token.cancelled) return Promise.reject(cancelledError());
  switch (schemeId) {
    case 'bitmap': return decodeBitmap(item, token, pool);
    case 'decode': return decodeImgDecode(item, token);
    case 'image':  return decodeImageOnload(item, token);
    default:       return Promise.reject(new Error(`未知方案: ${schemeId}`));
  }
}
