# 大图批量解码性能对比工具

纯原生 JavaScript（无框架）实现的大图批量加载与解码方案性能对照 Demo。

## 运行

需要通过 HTTP 服务访问（Web Worker 与 ES Module 不支持 file://）：

```bash
cd 本目录
python3 -m http.server 8080
# 打开 http://localhost:8080
```

推荐使用 Chrome / Edge（`performance.memory` 与 `longtask` 仅 Chromium 提供；其他浏览器对应指标显示 N/A，功能不受影响）。

## 功能

- **批量生成大图**：客户端用 Canvas 生成 2.5K~8K 测试图，支持 JPEG / PNG / WebP / 混合格式；不支持的格式自动回退 PNG。
- **三种解码方案对照**：
  - `createImageBitmap`：Blob 传入 Web Worker 解码，ImageBitmap 以 transferable 零拷贝转回主线程；
  - `img.decode()`：主线程 Promise 等待解码完成；
  - `Image onload`：传统事件回调。
- **实时监控**：FPS（rAF 计帧）、JS 堆内存及走势图、驻留解码内存估算、长任务计数（PerformanceObserver）。
- **性能对照**：每方案输出平均 / P95 / 最小 / 最大解码耗时、墙钟总耗时、堆增量峰值，并以条形图直观对比。
- **取消 / 清空 / 重置**：取消会终止 Worker 立即释放解码内存；清空保留图片仅清结果；重置释放全部 ObjectURL。
- **异常与降级**：
  - 可注入损坏文件验证解码失败 → 自动降级为低分辨率模糊占位图；
  - `createImageBitmap` / `img.decode` 不可用时自动降级到下一方案；
  - 并发数可调（1~8），任务池保证并发解码数量正确可控；
  - 每张图绘制后立即 `bitmap.close()` / 断开 `img.src`，内存及时回收。

## 目录结构

```
index.html          页面骨架
styles.css          样式
src/main.js         编排：生成、运行、取消、统计渲染
src/images.js       大图生成、格式回退、占位图
src/decoders.js     三种解码方案 + Worker 池
src/decodeWorker.js createImageBitmap Worker
src/queue.js        并发受限任务池
src/monitor.js      FPS / 堆内存 / 长任务监控
```
