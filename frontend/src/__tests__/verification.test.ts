import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runAction } from '@/api/local-service'
import { getStratumCheck, submitVerification } from '@/api/verification'
import {
  invalidateCache,
  listRows,
  setStorageDriver,
  storageKey,
  type StorageDriver,
} from '@/data/local-store'
import type { EntryRow } from '@/data/types'

/** 内存版 localStorage：每个用例一套，避免污染浏览器真实存储。 */
function memoryStorage(): StorageDriver & { read: () => Record<string, EntryRow[]> } {
  let data: Record<string, unknown> = {}
  return {
    getItem: (key: string) => (key in data ? String(data[key]) : null),
    setItem: (key: string, value: string) => {
      data[key] = value
    },
    read: () => JSON.parse(String(data[storageKey()] ?? '{}')) as Record<string, EntryRow[]>,
  }
}

let store: ReturnType<typeof memoryStorage>

beforeEach(() => {
  store = memoryStorage()
  setStorageDriver(store)
  invalidateCache()
})

afterEach(() => {
  setStorageDriver(null)
  invalidateCache()
  vi.restoreAllMocks()
})

function stratum(id: number): EntryRow {
  const row = listRows('stratum').find((item) => Number(item.id) === id)
  if (!row) {
    throw new Error(`缺少地层 ${id}`)
  }
  return row
}

describe('地层完成校核：一次事务性落库', () => {
  it('已记录的地层完成校核后，status 与记录状态、校核人、校核时间、版本号同时落库，刷新后结论不变', () => {
    const before = stratum(2)
    expect(before.status).toBe('已记录')
    expect(before['记录状态']).toBe('已记录')

    const result = runAction('stratum', 2, '完成校核', {
      operator: '校核员甲',
      expectedVersion: Number(before.__version ?? 0),
    })
    expect(result.ok).toBe(true)

    // 模拟刷新：丢掉内存缓存，重新从持久化存储读。
    invalidateCache()
    const after = stratum(2)
    expect(after.status).toBe('已校核')
    // 关键修复点：两份字段以前会分叉，刷新后各说各话；现在必须一致。
    expect(after['记录状态']).toBe('已校核')
    expect(after.pending).toBe(false)
    expect(after.abnormal).toBe(false)
    expect(after['校核人']).toBe('校核员甲')
    expect(after['校核时间']).not.toBe('')
    expect(after.__version).toBe(Number(before.__version ?? 0) + 1)
  })

  it('落库失败时整体退回，存储里不留下半份字段', () => {
    const before = stratum(2)
    const snapshotBefore = JSON.stringify(before)

    const failing: StorageDriver = {
      getItem: (key: string) => store.getItem(key),
      setItem: () => {
        throw new Error('配额已满')
      },
    }
    setStorageDriver(failing)
    invalidateCache()

    const result = runAction('stratum', 2, '完成校核', { operator: '校核员甲' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('已整体退回')

    // 存储驱动仍是失败的，只允许读取来核验；底层存储始终没被写入新值。
    const persisted = store.read().stratum?.find((row) => Number(row.id) === 2)
    expect(persisted).toBeDefined()
    expect(JSON.stringify(persisted)).toBe(snapshotBefore)
    expect(persisted?.status).toBe('已记录')
    expect(persisted?.['记录状态']).toBe('已记录')
    expect(persisted?.__verifier ?? '').toBe('')
  })
})

describe('实测绘图入口：跨模块读取与地层页是同一个结论', () => {
  it('地层校核前后，绘图入口读到的结论同步翻转，且两边一致', () => {
    // DRAW-0002 的绘图对象是「地层 STRA-0002 平剖面图」，对应地层 id=2。
    const before = getStratumCheck('地层 STRA-0002 平剖面图')
    expect(before.linked).toBe(true)
    expect(before.outcome).toBe('unverified')
    expect(before.status).toBe('已记录')

    runAction('stratum', 2, '完成校核', { operator: '校核员甲' })

    invalidateCache()
    const after = getStratumCheck('地层 STRA-0002 平剖面图')
    expect(after.outcome).toBe('verified')
    expect(after.status).toBe('已校核')
    expect(after.verifier).toBe('校核员甲')

    // 地层页看到的 status 与绘图入口读到的 status 必须严格相等。
    expect(stratum(2).status).toBe(after.status)
  })

  it('绘图确认校核与地层完成校核走同一个共享校验，字段同样一次落齐', () => {
    const drawing = listRows('drawing').find((row) => Number(row.id) === 2)
    expect(drawing?.status).toBe('待校核')

    const result = runAction('drawing', 2, '确认校核', {
      operator: '绘图校核员',
      expectedVersion: Number(drawing?.__version ?? 0),
    })
    expect(result.ok).toBe(true)

    invalidateCache()
    const after = listRows('drawing').find((row) => Number(row.id) === 2)
    expect(after?.status).toBe('已校核')
    expect(after?.['图纸状态']).toBe('已校核')
    expect(after?.['校核人']).toBe('绘图校核员')
    expect(after?.pending).toBe(false)
  })

  it('绘图对象未携带可识别地层编号时标记未关联，不误报已校核', () => {
    expect(getStratumCheck('遗迹 F007 平面图').linked).toBe(false)
  })
})

describe('历史记录：已校核/需补录的原结论保留', () => {
  it('已校核的历史记录再次校核被拒绝，结论原样保留', () => {
    const before = stratum(3)
    expect(before.status).toBe('已校核')
    const versionBefore = Number(before.__version ?? 0)

    const result = submitVerification('stratum', 3, true, {
      operator: '后来者',
      expectedVersion: versionBefore,
    })
    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('历史记录不应允许重复校核')
    }
    expect(result.conflict).toBe(false)
    expect(result.message).toContain('按原结论保留')

    invalidateCache()
    const after = stratum(3)
    expect(after.status).toBe('已校核')
    expect(after['记录状态']).toBe('已校核')
    expect(Number(after.__version ?? 0)).toBe(versionBefore)
  })

  it('退回补录的记录保留需补录结论，不能被直接再次校核', () => {
    runAction('stratum', 2, '退回补录', { operator: '校核员甲' })
    invalidateCache()
    const rework = stratum(2)
    expect(rework.status).toBe('需补录')
    expect(rework['记录状态']).toBe('需补录')
    expect(rework.abnormal).toBe(true)
    expect(rework.pending).toBe(false)

    const retry = submitVerification('stratum', 2, true, {
      operator: '校核员乙',
      expectedVersion: Number(rework.__version ?? 0),
    })
    expect(retry.ok).toBe(false)
    if (retry.ok) {
      throw new Error('需补录记录不应允许直接再次校核')
    }
    expect(retry.message).toContain('按原结论保留')
    expect(stratum(2).status).toBe('需补录')
  })
})

describe('两人同时校核同一地层：只接受先完成的一项', () => {
  it('后完成者携带旧版本提交时被拒绝，并说明先完成的冲突方', () => {
    // 两人打开同一条「已记录」地层，各自拿到相同的起始版本。
    const startVersion = Number(stratum(2).__version ?? 0)

    const first = submitVerification('stratum', 2, true, {
      operator: '校核员甲',
      expectedVersion: startVersion,
    })
    expect(first.ok).toBe(true)

    // 第二人仍拿着打开时的旧版本提交。
    const second = submitVerification('stratum', 2, true, {
      operator: '校核员乙',
      expectedVersion: startVersion,
    })
    expect(second.ok).toBe(false)
    if (second.ok) {
      throw new Error('并发提交不应成功')
    }
    expect(second.conflict).toBe(true)
    expect(second.message).toContain('已被他人先完成校核')
    expect(second.message).toContain('校核员甲')

    // 最终结论只属于先完成的一方。
    invalidateCache()
    const finalRow = stratum(2)
    expect(finalRow.status).toBe('已校核')
    expect(finalRow['校核人']).toBe('校核员甲')
    expect(Number(finalRow.__version ?? 0)).toBe(startVersion + 1)
  })
})

describe('历史存档自愈：刷新后两份相反结论愈合', () => {
  it('老存档里记录状态与 status 相反时，读取即以权威结论对齐，原已校核结论不被推翻', () => {
    // 先触发一次播种，让内存存储里有完整数据，再模拟旧版本程序留下的分叉存档。
    listRows('stratum')
    const legacy = store.read()
    const target = legacy.stratum?.find((row) => Number(row.id) === 2)
    if (target) {
      target.status = '已校核'
      target['记录状态'] = '已记录'
      target.pending = true
      delete target.__version
    }
    let raw = JSON.stringify(legacy)
    const forked: StorageDriver = {
      getItem: (key: string) => (key === storageKey() ? raw : null),
      setItem: (key: string, value: string) => {
        raw = value
      },
    }
    setStorageDriver(forked)
    invalidateCache()

    const healed = stratum(2)
    expect(healed.status).toBe('已校核') // 权威结论保留
    expect(healed['记录状态']).toBe('已校核') // 镜像愈合，不再相反
    expect(healed.pending).toBe(false)
    expect(healed.__version).toBe(0)

    // 绘图入口与地层页结论一致。
    expect(getStratumCheck('地层 STRA-0002 平剖面图').status).toBe('已校核')
  })
})
