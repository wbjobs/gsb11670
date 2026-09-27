# 大图批量解码性能对比实验室

纯原生（无框架）实现的大图批量加载与解码方案性能对比 Demo。

## 运行

Web Worker 需要 HTTP 环境，不能直接双击打开：

```bash
cd B
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

推荐使用 Chrome / Edge（内存统计 `performance.memory` 与 `longtask` 仅 Chromium 支持，其余浏览器自动降级显示）。

## 功能

- **批量加载大图**：程序化生成 3000×2000 ~ 9000×6000 的 JPEG/PNG/WebP 大图，也支持选择本地图片。
- **三种解码方案对比**：
  - `createImageBitmap`（主线程 / Web Worker 两种模式）
  - `Image + onload`
  - `img.decode()`
  - 选择「三种方案基准对比」可对同一批样本依次跑三种方案，自动汇总对照表。
- **可观测性**：FPS、JS 堆内存、长任务数量（PerformanceObserver）、每张解码耗时（performance.measure）、平均/最小/最大/P95 对照表。
- **控制**：取消解码（并发池协作式取消）、清空（释放内存）、重置。
- **渐进式加载**：先用 `createImageBitmap` 的 `resizeWidth/resizeHeight` 出低分辨率占位，再替换全分辨率。

## 关键约束的实现位置

| 约束 | 实现 |
| --- | --- |
| 大图不崩 | 逐张生成 + 让出主线程；解码后只绘制缩略尺寸到 Canvas |
| 解码失败降级 | `main.js` `decodeWithFallback`：换 createImageBitmap 重试 → 仍失败则绘制低分辨率占位图 |
| 并发解码正确 | `js/pool.js` 并发池限制并发数，任务与结果一一对应，取消令牌协作式退出 |
| 内存回收及时 | `ImageBitmap.close()`、`URL.revokeObjectURL`、清空时统一 `cleanup()`，占位图用完即释放 |
| 图片格式差异 | 启动时探测浏览器实际支持的编码格式，不支持的格式自动回退；混合模式轮换格式 |
| 降级低分辨率占位 | 渐进式占位 + 失败兜底占位（`drawFailurePlaceholder`） |

## 文件结构

```
index.html        页面与控件
css/style.css     样式
js/genimages.js   程序化大图生成 / 损坏样本注入 / 格式探测
js/pool.js        并发池 + 取消
js/strategies.js  三种解码方案 + Worker 变体
js/worker.js      Worker 内 createImageBitmap 解码
js/monitor.js     FPS / 内存 / 长任务监控，performance.measure 采样
js/main.js        编排：批量加载、降级链、指标汇总、内存回收
```
