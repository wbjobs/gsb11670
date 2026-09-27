/* worker.js — 在 Worker 线程中用 createImageBitmap 解码，bitmap 以零拷贝转回主线程 */
'use strict';

self.onmessage = async (e) => {
  const { id, blob, resize } = e.data;
  try {
    const options = {};
    if (resize && resize.width && resize.height) {
      options.resizeWidth = resize.width;
      options.resizeHeight = resize.height;
      options.resizeQuality = 'low';
    }
    const bitmap = await createImageBitmap(blob, options);
    self.postMessage({ id, ok: true, bitmap, width: bitmap.width, height: bitmap.height }, [bitmap]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
