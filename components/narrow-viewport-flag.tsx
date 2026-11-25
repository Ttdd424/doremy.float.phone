"use client";

import { useLayoutEffect } from "react";

/**
 * 窄屏布局标记器。
 *
 * 为什么需要它：窄屏全屏布局原本只靠 CSS 的 `@media (max-width: 500px)` 生效。
 * 部分安卓 WebView（华为自带浏览器 / 夸克 / APK 壳）实测布局视口为 372~373，
 * 宽度条件本应成立，线上却仍出现「外壳还在、整页可上下左右拖动、四周白边」，
 * 说明那个媒体查询块在设备上没有生效。而 `html, body { overflow: hidden }`
 * 只存在于该块内部（styles/base.css 的 html/body 规则不含 overflow），
 * 整页可拖动正好反过来证明该块未生效。
 *
 * 因此这里不再依赖媒体查询是否命中：按真实布局视口宽度给 <html> 打
 * `data-narrow-viewport="1"`，由 styles/phone-shell.css 末尾的属性选择器
 * 兜底把同一套声明再写一遍。属性选择器特异性高于 base.css 的
 * `.app-root` / `html, body`，因此既覆盖「媒体查询没命中」也覆盖
 * 「被后续样式覆盖」两种情况。
 *
 * 边界：只写一个 data 属性，幂等；不改尺寸数值、不写业务状态、不碰存储与原生桥接。
 * 桌面端（innerWidth > 500）会移除该属性，行为与改动前完全一致。
 */
const NARROW_MAX_WIDTH = 500;

function applyNarrowViewportFlag() {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const root = document.documentElement;
  // 用布局视口宽度判断：软键盘弹出只改变高度，不影响宽度，
  // 因此键盘开合不会让标记来回翻转。
  const width = window.innerWidth || window.visualViewport?.width || 0;
  if (width > 0 && width <= NARROW_MAX_WIDTH) {
    if (root.dataset.narrowViewport !== "1") {
      root.dataset.narrowViewport = "1";
    }
  } else if (root.dataset.narrowViewport) {
    delete root.dataset.narrowViewport;
  }
}

export function NarrowViewportFlag() {
  // 用 layout effect：首帧绘制前就打好标记，避免先闪一帧 390×844 的外壳形态。
  useLayoutEffect(() => {
    applyNarrowViewportFlag();
    window.addEventListener("resize", applyNarrowViewportFlag);
    window.addEventListener("orientationchange", applyNarrowViewportFlag);
    window.visualViewport?.addEventListener("resize", applyNarrowViewportFlag);
    return () => {
      window.removeEventListener("resize", applyNarrowViewportFlag);
      window.removeEventListener("orientationchange", applyNarrowViewportFlag);
      window.visualViewport?.removeEventListener("resize", applyNarrowViewportFlag);
    };
  }, []);
  return null;
}