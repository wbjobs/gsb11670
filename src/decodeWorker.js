// createImageBitmap 解码 Worker：接收 Blob，解码后将 ImageBitmap 以
// transferable 方式零拷贝转回主线程，解码过程完全不阻塞主线程。
self.onmessage = async (e) => {
  const { id, blob } = e.data;
  try {
    const bitmap = await createImageBitmap(blob);
    self.postMessage(
      { id, ok: true, bitmap, width: bitmap.width, height: bitmap.height },
      [bitmap]
    );
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
