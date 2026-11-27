// lib/desktop-badges.ts
//
// 桌面图标红点（未读角标）的通用登记表。
//
// 背景：在此之前只有自定义 APP 能在桌面图标上显示红点，走的是
// lib/custom-app-host-api.ts 里的 CUSTOM_APP_BADGES_KEY（键是自定义 APP 的 appId）。
// 内置 APP 图标在桌面渲染里恒为 0，所以聊天、备忘录、手记这些内容有更新时桌面毫无提示。
//
// 这里补一层"按桌面图标 id 记账"的通用红点表：任何内置 APP 在产生新内容时调用
// markDesktopBadge(iconId)，桌面渲染时读 desktopBadges[iconId]；用户点开该 APP 时
// 由 shell 调 clearDesktopBadge(iconId) 清掉。
//
// 设计约束（照做才不会出现"红点点了还在"或"刷新后红点乱闪"）：
// 1. 只记时间戳与条数，不存内容，避免把业务数据复制到第二个地方。
// 2. 写入即广播 DESKTOP_BADGES_UPDATED_EVENT，桌面 shell 监听后刷新 React 状态，
//    所以不需要轮询，也不会漏掉"APP 在后台产生内容"的场景。
// 3. 值存 kv-db（和桌面布局同一套持久层），刷新/重启后红点仍在，
//    直到用户真的点开过对应 APP。
// 4. clearedAt 记录"用户最后一次点开该 APP 的时间"，各业务模块可据此判断
//    "打开之后又来了新内容"（例如文案类应用按 updatedAt > clearedAt 判定）。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { DesktopIconId } from "./desktop-config";

const DESKTOP_BADGES_KEY = "ai_phone_desktop_badges_v1";

registerKvMigration(DESKTOP_BADGES_KEY);

/** 红点表变化时广播；detail 为最新整表快照。 */
export const DESKTOP_BADGES_UPDATED_EVENT = "ai-phone-desktop-badges-updated";

export type DesktopBadgeEntry = {
  /** 未读条数；countOnly=false 时也用来画数字角标 */
  count: number;
  /** 最近一次产生新内容的时间（ISO） */
  updatedAt: string;
  /** 用户最后一次点开该 APP 的时间（ISO）；没有则视为从未打开 */
  clearedAt?: string;
};

export type DesktopBadgeMap = Record<string, DesktopBadgeEntry>;

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeCount(value: unknown): number {
  const count = Math.floor(Number(value) || 0);
  return Math.max(0, Math.min(999, count));
}

function sanitizeEntry(raw: unknown): DesktopBadgeEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const count = sanitizeCount(record.count);
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : "";
  if (count <= 0 || !updatedAt) return null;
  const clearedAt = typeof record.clearedAt === "string" && record.clearedAt ? record.clearedAt : undefined;
  return { count, updatedAt, ...(clearedAt ? { clearedAt } : {}) };
}

/** 读取整张红点表；损坏数据自动剔除，count<=0 的条目不会返回。 */
export function loadDesktopBadges(): DesktopBadgeMap {
  if (!isBrowser()) return {};
  try {
    const raw = kvGet(DESKTOP_BADGES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: DesktopBadgeMap = {};
    for (const [iconId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = sanitizeEntry(value);
      if (entry) result[iconId] = entry;
    }
    return result;
  } catch {
    return {};
  }
}

function saveDesktopBadges(map: DesktopBadgeMap): DesktopBadgeMap {
  if (!isBrowser()) return map;
  kvSet(DESKTOP_BADGES_KEY, JSON.stringify(map));
  window.dispatchEvent(new CustomEvent(DESKTOP_BADGES_UPDATED_EVENT, { detail: { badges: map } }));
  return map;
}

/** 单图标未读条数；桌面渲染直接用它。 */
export function getDesktopBadgeCount(iconId: DesktopIconId | string): number {
  const entry = loadDesktopBadges()[iconId];
  return entry ? entry.count : 0;
}

// ── 前台抑制：用户正开着的 APP 不打红点 ──
//
// 用户在 APP 里自己写一条备忘录、写一篇日记、发一条朋友圈，写完后关掉 APP 不该冒出红点。
// 业务存储层（memo/diary/moments/...）无法知道"APP 是不是正开着"，所以由桌面 shell
// 在切换 activeApp 时把当前图标登记进来，markDesktopBadge 对前台图标只更新 clearedAt、不累计红点。
let _foregroundIconId: string | null = null;

/** 由桌面 shell 调用：登记当前正在前台的桌面图标（null = 回到桌面）。 */
export function setForegroundDesktopIcon(iconId: DesktopIconId | string | null): void {
  _foregroundIconId = iconId || null;
}

export function getForegroundDesktopIcon(): string | null {
  return _foregroundIconId;
}

/**
 * 标记某个桌面图标"有新内容"。
 *
 * @param iconId   桌面图标 id（内置图标是 "chat" / "memo" / "diary" 等）
 * @param options  count: 增量条数（默认 1）；absolute: 直接设定总数（给"按未读数同步"的场景用）；
 *                 ignoreForeground: 前台抑制对本图标的这次调用不生效
 */
export function markDesktopBadge(
  iconId: DesktopIconId | string,
  options: { count?: number; absolute?: boolean; ignoreForeground?: boolean } = {},
): number {
  if (!isBrowser() || !iconId) return 0;
  // 用户正看着这个 APP：把这次更新视为已读，不亮红点。
  // 聊天类应用传 ignoreForeground：它们的已读判定已经由会话 unreadCount 表达，
  // 不需要桌面这一层再猜。
  if (!options.ignoreForeground && _foregroundIconId === iconId) {
    clearDesktopBadge(iconId);
    return 0;
  }
  const map = loadDesktopBadges();
  const current = map[iconId];
  const delta = Math.floor(Number(options.count ?? 1) || 0);
  const nextCount = sanitizeCount(options.absolute ? delta : (current?.count ?? 0) + delta);
  if (nextCount <= 0) {
    // 归零等价于清除，保留 clearedAt 语义
    return clearDesktopBadge(iconId);
  }
  map[iconId] = {
    count: nextCount,
    updatedAt: nowIso(),
    ...(current?.clearedAt ? { clearedAt: current.clearedAt } : {}),
  };
  saveDesktopBadges(map);
  return nextCount;
}

/**
 * 清除某个桌面图标的红点（用户点开该 APP 时调用）。
 * 保留一条 clearedAt 记录，供业务模块判断"点开之后是否又更新过"。
 */
export function clearDesktopBadge(iconId: DesktopIconId | string): number {
  if (!isBrowser() || !iconId) return 0;
  const map = loadDesktopBadges();
  const clearedAt = nowIso();
  if (map[iconId]) {
    delete map[iconId];
  }
  // clearedAt 单独存一行，不占用 badges 表的有效条目（count 必须 > 0 才保留）
  const cleared = loadDesktopBadgeClears();
  cleared[iconId] = clearedAt;
  saveDesktopBadgeClears(cleared);
  saveDesktopBadges(map);
  return 0;
}

// ── clearedAt 单独一张表：避免"清掉红点后连点开时间也一起丢了" ──

const DESKTOP_BADGE_CLEARS_KEY = "ai_phone_desktop_badge_clears_v1";
registerKvMigration(DESKTOP_BADGE_CLEARS_KEY);

export type DesktopBadgeClearMap = Record<string, string>;

export function loadDesktopBadgeClears(): DesktopBadgeClearMap {
  if (!isBrowser()) return {};
  try {
    const raw = kvGet(DESKTOP_BADGE_CLEARS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: DesktopBadgeClearMap = {};
    for (const [iconId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value) result[iconId] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function saveDesktopBadgeClears(map: DesktopBadgeClearMap): void {
  if (!isBrowser()) return;
  kvSet(DESKTOP_BADGE_CLEARS_KEY, JSON.stringify(map));
}

/** 某图标最后一次被点开的时间（毫秒）；从未打开过返回 0。 */
export function getDesktopBadgeClearedAt(iconId: DesktopIconId | string): number {
  const value = loadDesktopBadgeClears()[iconId];
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 同 clearedAt，但用 ISO 字符串返回；便于与各业务存储里的 updatedAt 直接比较。 */
export function getDesktopBadgeClearedAtIso(iconId: DesktopIconId | string): string {
  return loadDesktopBadgeClears()[iconId] ?? "";
}

/**
 * "内容型"应用（备忘录、手记等）通用上报：与本图标上次点开时间比较，
 * 只有当 latestUpdatedAt 比 clearedAt 更新时才点亮红点。
 *
 * 这样即使调用方在上报后不清红点，用户点开过之后也不会又冒出旧红点。
 */
export function markDesktopBadgeIfNewer(
  iconId: DesktopIconId | string,
  latestUpdatedAt: string | number | undefined,
  options: { count?: number } = {},
): number {
  if (!isBrowser() || !iconId) return 0;
  const latest = typeof latestUpdatedAt === "number"
    ? latestUpdatedAt
    : Date.parse(String(latestUpdatedAt ?? ""));
  if (!Number.isFinite(latest) || latest <= 0) return getDesktopBadgeCount(iconId);
  const clearedAt = getDesktopBadgeClearedAt(iconId);
  if (latest <= clearedAt) return getDesktopBadgeCount(iconId);
  return markDesktopBadge(iconId, { count: options.count ?? 1, absolute: true });
}