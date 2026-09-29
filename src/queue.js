// 并发受限任务池：最多 limit 个任务同时执行，保证并发解码数量可控。
export async function runPool(tasks, limit) {
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      await task();
    }
  }
  const lanes = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: lanes }, worker));
}
