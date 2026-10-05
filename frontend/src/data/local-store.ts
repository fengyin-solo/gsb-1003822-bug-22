import { MODULES } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'field-archaeology-digital:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 读取时自愈：历史版本只写了内部 status、没回写业务镜像字段（记录状态/图纸状态），
 * 会出现“地层页显示已记录、绘图入口认为已校核”的相反结论。
 * 这里以 status 为唯一权威结论，把镜像字段、版本号、待处理标记对齐；
 * 绝不改动 status，所以已校核/需补录/已归档的原结论原样保留。
 * 返回是否发生过修复，供调用方决定是否回写一次存储。
 */
function normalizeSnapshot(data: Record<string, EntryRow[]>): boolean {
  let changed = false
  for (const meta of MODULES) {
    const rows = data[meta.key]
    if (!Array.isArray(rows)) {
      continue
    }
    const boundary = meta.verification
      ? meta.statuses.indexOf(meta.verification.verifiedStatus)
      : -1
    for (const row of rows) {
      if (typeof row.__version !== 'number' || Number.isNaN(row.__version)) {
        row.__version = 0
        changed = true
      }
      if (meta.statusField) {
        const mirror = row[meta.statusField]
        if (mirror === undefined || String(mirror) !== String(row.status)) {
          row[meta.statusField] = String(row.status)
          changed = true
        }
      }
      if (meta.verification) {
        const index = meta.statuses.indexOf(String(row.status))
        const expectedPending =
          index >= 0 && boundary >= 0 ? index < boundary : Boolean(row.pending)
        if (Boolean(row.pending) !== expectedPending) {
          row.pending = expectedPending
          changed = true
        }
      }
    }
  }
  return changed
}

/** 存储驱动可注入，测试里换成内存对象，浏览器里默认走 localStorage。 */
export interface StorageDriver {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

let driver: StorageDriver | null = null

function getDriver(): StorageDriver | null {
  if (driver) {
    return driver
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    driver = window.localStorage
  }
  return driver
}

/** 仅供测试/初始化使用：换一套存储后端，并清空内存缓存。 */
export function setStorageDriver(custom: StorageDriver | null): void {
  driver = custom
  cache = null
}

function seedSnapshot(): Record<string, EntryRow[]> {
  return clone(SEED_ROWS)
}

function readStorage(): Record<string, EntryRow[]> {
  const active = getDriver()
  if (!active) {
    const fallback = seedSnapshot()
    normalizeSnapshot(fallback)
    return fallback
  }
  const raw = active.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = seedSnapshot()
    normalizeSnapshot(seeded)
    active.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  let data: Record<string, EntryRow[]>
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 新播种的模块要能出现在老存档里，所以用种子兜底，存档覆盖同名模块。
    data = { ...seedSnapshot(), ...parsed }
  } catch {
    const fallback = seedSnapshot()
    normalizeSnapshot(fallback)
    active.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  // 发现历史分叉就按权威结论愈合，并回写一次，之后刷新两个入口看到的就是同一份结论。
  if (normalizeSnapshot(data)) {
    active.setItem(STORAGE_KEY, JSON.stringify(data))
  }
  return data
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/** 丢弃内存缓存：另一个标签页提交后，本标签页必须重新从存储读，不能拿旧快照做判断。 */
export function invalidateCache(): void {
  cache = null
}

if (typeof window !== 'undefined' && window.addEventListener) {
  // 跨标签页/双窗口（同一地层被两人同时操作）：谁先提交，另一窗口立刻失效旧快照。
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      invalidateCache()
    }
  })
}

export function rowVersion(row: EntryRow | undefined): number {
  return Number(row?.__version ?? 0)
}

/** 并发冲突：提交时携带的版本与存储里的最新版本不一致，说明已有人先完成了操作。 */
export class CommitConflict extends Error {
  constructor(
    public readonly key: string,
    public readonly id: number,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`记录 ${id} 已被他人先完成操作（版本 ${expected} → ${actual}）`)
    this.name = 'CommitConflict'
  }
}

/**
 * 单模块事务：基于整模块快照做修改，提交时一次性写入。
 * - mutate 必须在传入的草稿数组上原地计算，先全部改完再统一落库；
 * - expectedVersions 里每条记录都会做乐观锁校验，任一版本不符就整体抛出 CommitConflict，不落任何字段；
 * - 写入本身失败（配额/序列化/存储异常）也不会更新内存缓存，已有的旧数据原样保留，不留半份字段。
 */
export function commitModuleTransaction(
  key: string,
  mutate: (draft: EntryRow[]) => void,
  expectedVersions: Record<number, number> = {},
): EntryRow[] {
  // 永远基于存储里的最新快照做校验，避免本标签页缓存把别人的提交盖掉。
  const latest = readStorage()[key] ?? []
  for (const [id, expected] of Object.entries(expectedVersions)) {
    const current = latest.find((row) => Number(row.id) === Number(id))
    if (rowVersion(current) !== Number(expected)) {
      throw new CommitConflict(key, Number(id), Number(expected), rowVersion(current))
    }
  }

  const draft = clone(latest)
  mutate(draft)

  const snapshot = readStorage()
  const next = { ...snapshot, [key]: draft }
  const serialized = JSON.stringify(next)

  const active = getDriver()
  if (active) {
    // 这一步是事务提交点：要么整份写入成功，要么抛错，调用方与缓存都维持原状。
    active.setItem(STORAGE_KEY, serialized)
  }
  // 只有提交成功之后才允许更新内存视图。
  cache = active ? next : (next as Record<string, EntryRow[]>)
  return clone(draft)
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitModuleTransaction(key, (draft) => {
    draft.length = 0
    draft.push(...clone(rows))
  })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
