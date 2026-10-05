import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'field-archaeology-digital:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 历史记录可能没有版本号或校核留痕，统一在读取边界补齐，后续逻辑只面对规整结构。
function normalize(row: EntryRow): EntryRow {
  return {
    ...row,
    version: typeof row.version === 'number' ? row.version : 0,
    verifiedBy: typeof row.verifiedBy === 'string' ? row.verifiedBy : undefined,
    verifiedAt: typeof row.verifiedAt === 'string' ? row.verifiedAt : undefined,
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = () => clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = fallback()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 存储里没有的模块仍以种子数据补齐；已存在的历史结论原样保留，不做任何重算。
    const merged: Record<string, EntryRow[]> = { ...fallback(), ...parsed }
    return Object.fromEntries(
      Object.entries(merged).map(([key, rows]) => [key, rows.map(normalize)]),
    )
  } catch {
    const seeded = fallback()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
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

// 乐观锁冲突：调用方持有的版本已过期，说明同一条记录已被别人先提交。
export class VersionConflictError extends Error {
  constructor(
    public readonly current: EntryRow,
    message: string,
  ) {
    super(message)
    this.name = 'VersionConflictError'
  }
}

// 同一条记录已有一个动作在途（尚未完成落库），第二个动作必须整体拒绝。
export class InFlightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InFlightError'
  }
}

export type CommitOptions = {
  // 调用方读到该记录时的版本；不传则跳过乐观锁（兼容旧调用点）。
  expectedVersion?: number
  // 是否属于需要并发互斥的结论性动作（如完成校核）。
  exclusive?: boolean
}

// 记录级在途锁：key 为模块，value 为当前正在提交的记录 id 集合。
const inFlight = new Map<string, Set<number>>()

// 事务性落库：先在内存里算好整条新记录，再一次性替换该模块数组并单次序列化写盘。
// 校验、构造、写入任一环节抛错都不会触碰缓存与 localStorage，因此不会留下半份字段。
export function commitRow(
  key: string,
  id: number,
  produce: (current: EntryRow) => EntryRow,
  options: CommitOptions = {},
): EntryRow {
  const locked = inFlight.get(key)
  const held = locked?.has(id) ?? false
  if (options.exclusive && held) {
    throw new InFlightError('该记录正在被另一个校核动作处理，请稍后查看最新结论')
  }
  try {
    if (options.exclusive) {
      if (!locked) {
        inFlight.set(key, new Set<number>())
      }
      inFlight.get(key)!.add(id)
    }

    const rows = listRows(key)
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      throw new Error(`没有找到编号为 ${id} 的记录`)
    }
    const current = rows[index]
    if (
      options.expectedVersion !== undefined &&
      (current.version ?? 0) !== options.expectedVersion
    ) {
      throw new VersionConflictError(current, '记录已被他人先一步更新')
    }

    // 在副本上生成新记录，原数组与缓存保持不变，直到全部字段就绪。
    const updated = normalize(produce(current))
    const stamped: EntryRow = { ...updated, version: (current.version ?? 0) + 1 }
    const nextRows = rows.map((row, rowIndex) => (rowIndex === index ? stamped : row))
    const nextCache = { ...allRows(), [key]: nextRows }

    // 单次序列化整体落盘；写盘失败（配额/隐私模式等）时缓存也不更新，整体退回。
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextCache))
    }
    cache = nextCache
    return stamped
  } finally {
    if (options.exclusive) {
      inFlight.get(key)?.delete(id)
    }
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows.map(normalize) }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? []).map(normalize)
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
