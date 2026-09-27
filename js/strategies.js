/* strategies.js — 三种解码方案 + Worker 变体，统一返回 {draw, width, height, cleanup} */
(function (global) {
  'use strict';

  let worker = null;
  let workerSeq = 0;
  const workerCallbacks = new Map();

  function getWorker() {
    if (!worker) {
      worker = new Worker('js/worker.js');
      worker.onmessage = (e) => {
        const { id, ok, bitmap, width, height, error } = e.data;
        const cb = workerCallbacks.get(id);
        if (!cb) { if (bitmap) bitmap.close(); return; }
        workerCallbacks.delete(id);
        ok ? cb.resolve({ bitmap, width, height }) : cb.reject(new Error(error || 'Worker 解码失败'));
      };
      worker.onerror = (e) => {
        workerCallbacks.forEach((cb) => cb.reject(new Error(e.message || 'Worker 异常')));
        workerCallbacks.clear();
      };
    }
    return worker;
  }

  function decodeViaWorker(blob, resize) {
    return new Promise((resolve, reject) => {
      const id = ++workerSeq;
      workerCallbacks.set(id, { resolve, reject });
      getWorker().postMessage({ id, blob, resize });
    });
  }

  function assertNotCancelled(isCancelled) {
    if (isCancelled && isCancelled()) throw new CancelledError();
  }

  /** 方案一：createImageBitmap（主线程） */
  async function viaCreateImageBitmap(blob, { isCancelled, resize } = {}) {
    const options = resize ? { resizeWidth: resize.width, resizeHeight: resize.height, resizeQuality: 'low' } : undefined;
    const bitmap = await createImageBitmap(blob, options);
    assertNotCancelled(isCancelled);
    return {
      width: bitmap.width, height: bitmap.height,
      draw: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h),
      cleanup: () => bitmap.close(), // 关键：显式释放解码后的位图内存
    };
  }

  /** 方案一变体：createImageBitmap 放到 Web Worker，避免阻塞主线程 */
  async function viaWorker(blob, { isCancelled, resize } = {}) {
    const { bitmap, width, height } = await decodeViaWorker(blob, resize);
    assertNotCancelled(isCancelled);
    return {
      width, height,
      draw: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h),
      cleanup: () => bitmap.close(),
    };
  }

  /** 方案二：Image 元素 + onload（经典方式） */
  function viaImageElement(blob, { isCancelled } = {}) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      let settled = false;
      const fail = (err) => {
        if (settled) return; settled = true;
        URL.revokeObjectURL(url);
        reject(err);
      };
      img.onload = () => {
        if (settled) return; settled = true;
        if (isCancelled && isCancelled()) return fail(new CancelledError());
        resolve({
          width: img.naturalWidth, height: img.naturalHeight,
          draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
          cleanup: () => { img.onload = img.onerror = null; img.src = ''; URL.revokeObjectURL(url); },
        });
      };
      img.onerror = () => fail(new Error('Image onload 解码失败（格式不支持或数据损坏）'));
      img.src = url;
    });
  }

  /** 方案三：img.decode() —— 显式异步解码，避免首绘时的同步解码卡顿 */
  function viaImgDecode(blob, { isCancelled } = {}) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      img.decode().then(() => {
        if (isCancelled && isCancelled()) {
          img.src = ''; URL.revokeObjectURL(url);
          return reject(new CancelledError());
        }
        resolve({
          width: img.naturalWidth, height: img.naturalHeight,
          draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
          cleanup: () => { img.src = ''; URL.revokeObjectURL(url); },
        });
      }).catch((err) => {
        img.src = ''; URL.revokeObjectURL(url);
        reject(new Error('img.decode() 失败: ' + ((err && err.message) || err)));
      });
    });
  }

  const STRATEGIES = {
    createImageBitmap: { label: 'createImageBitmap', fn: viaCreateImageBitmap, supportResize: true },
    createImageBitmapWorker: { label: 'createImageBitmap (Worker)', fn: viaWorker, supportResize: true },
    imageElement: { label: 'Image + onload', fn: viaImageElement, supportResize: false },
    imgDecode: { label: 'img.decode()', fn: viaImgDecode, supportResize: false },
  };

  global.Strategies = { STRATEGIES };
})(window);
