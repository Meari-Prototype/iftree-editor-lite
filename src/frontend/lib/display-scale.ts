// 显示器/界面缩放 → canvas 出图密度。
// 两层背景：
// 1. Electron 的 webContents zoomFactor 只放大布局，不改变渲染层的 devicePixelRatio——
//    DOM 文字矢量重排依然锐利，但 canvas 位图会被按 zoomFactor 拉伸发虚。出图密度必须
//    是 dpr × zoomFactor；zoomFactor 只能经主进程 IPC（iftree.getDisplayMetrics）拿到。
// 2. DPR=1 的 1080p 屏幕是重灾区：1:1 出图时，缩放 <100% 位图被放大、~125% 落在 0.8
//    降采样的"尴尬区"（缩放不足、平滑不够）——两端都糊，而矢量 PDF 查看器（福昕等）
//    按最终尺寸直接出矢量所以永远锐利。pdf.js canvas 没有 ClearType，可行的对策是
//    统一 ≥2× 超采样，让合成器永远只做高质量降采样——与高分屏清晰的原理一致。

import { useEffect, useState } from 'react';

export interface DisplayScaleInfo {
  /** canvas 出图应乘的总倍率：下限 2×（DPR=1 屏幕的超采样对策），封顶 3（防位图显存爆炸）。 */
  outputScale: number;
  /** 渲染层 devicePixelRatio（随系统缩放/跨屏变化）。 */
  dpr: number;
  /** Electron 界面缩放（webContents zoomFactor；Web 模式恒 1）。 */
  zoomFactor: number;
  /** 主进程报的显示器缩放（诊断展示用；Web 模式为 0）。 */
  scaleFactor: number;
}

interface IftreeDisplayMetrics {
  zoomFactor?: number;
  scaleFactor?: number;
}

function readDpr(): number {
  return Math.max(1, Number(globalThis.devicePixelRatio) || 1);
}

function readBridge(): (() => Promise<IftreeDisplayMetrics>) | null {
  const bridge = (globalThis as { iftree?: { getDisplayMetrics?: () => Promise<IftreeDisplayMetrics> } }).iftree;
  return typeof bridge?.getDisplayMetrics === 'function' ? bridge.getDisplayMetrics.bind(bridge) : null;
}

export function useDisplayScale(): DisplayScaleInfo {
  const [dpr, setDpr] = useState(readDpr);
  const [metrics, setMetrics] = useState<{ zoomFactor: number; scaleFactor: number }>({ zoomFactor: 1, scaleFactor: 0 });

  useEffect(() => {
    if (typeof globalThis.matchMedia !== 'function') return () => {};
    const query = globalThis.matchMedia(`(resolution: ${readDpr()}dppx)`);
    const onChange = () => setDpr(readDpr());
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [dpr]);

  useEffect(() => {
    const getMetrics = readBridge();
    if (!getMetrics) return () => {}; // Web 模式：zoomFactor 概念不存在，保持 1
    let alive = true;
    const read = () => {
      getMetrics().then((m) => {
        if (!alive || !m) return;
        setMetrics({
          zoomFactor: Math.max(0.25, Number(m.zoomFactor) || 1),
          scaleFactor: Number(m.scaleFactor) || 0
        });
      }).catch(() => {});
    };
    read();
    // zoomFactor 运行时可被用户改（Ctrl+±），没有推送事件；聚焦时 + 轻轮询兜底。
    globalThis.addEventListener?.('focus', read);
    const timer = setInterval(read, 3000);
    return () => {
      alive = false;
      globalThis.removeEventListener?.('focus', read);
      clearInterval(timer);
    };
  }, []);

  return {
    // 下限 2×：保证任何缩放档位下位图都超采样，合成器只做降采样（发糊的唯一来源是放大/欠采样）。
    outputScale: Math.min(3, Math.max(2, dpr * metrics.zoomFactor)),
    dpr,
    zoomFactor: metrics.zoomFactor,
    scaleFactor: metrics.scaleFactor
  };
}
