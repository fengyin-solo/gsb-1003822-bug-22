import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  commitRow,
  InFlightError,
  listRows,
  resetRows,
  saveRows,
  VersionConflictError,
} from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 全模块通用的归档冻结态：结论已归档的历史记录禁止再被任何动作改动。
const DEFAULT_FROZEN_STATUSES = ['已归档']

// 会给出「校核/审核」结论的动作：只有这些动作需要并发互斥与校核留痕。
function isVerifyAction(action: string): boolean {
  return action.includes('校核') || action.includes('复核') || action.includes('审核')
}

// 目标状态是否为正式结论（终态）。显式清单优先，未配置时回退到状态表最后一项。
function settledStatusesOf(meta: ModuleMeta): Set<string> {
  if (meta.settledStatuses && meta.settledStatuses.length > 0) {
    return new Set(meta.settledStatuses)
  }
  return new Set([meta.statuses[meta.statuses.length - 1]])
}

function frozenStatusesOf(meta: ModuleMeta): Set<string> {
  return new Set(meta.frozenStatuses ?? DEFAULT_FROZEN_STATUSES)
}

export type RunActionOptions = {
  operator?: string
  // 调用方页面所持记录版本，用于两人同时校核时的乐观锁。
  expectedVersion?: number
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  options: RunActionOptions = {},
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const current = rows.find((row) => Number(row.id) === id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  const settled = settledStatusesOf(meta)
  const frozen = frozenStatusesOf(meta)
  const presentStatus = String(current.status)

  const verify = isVerifyAction(action) && settled.has(target)
  const abnormal = NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))

  // 校核类并发：只要调用方版本过期，就按冲突拒绝（即使两人目标状态相同），
  // 让后完成者明确知道结论已被先完成者锁定，而不是含糊地报「重复操作」。
  if (
    verify &&
    options.expectedVersion !== undefined &&
    (current.version ?? 0) !== options.expectedVersion
  ) {
    const winner = current.verifiedBy
    return {
      ok: false,
      message: winner
        ? `校核冲突：该${meta.entity}已由 ${winner} 先完成校核（当前状态「${current.status}」），本次操作已拒绝，请刷新后查看`
        : `校核冲突：该${meta.entity}已被他人先一步处理（当前状态「${current.status}」），本次操作已拒绝，请刷新后查看`,
    }
  }

  if (frozen.has(presentStatus) && target !== presentStatus) {
    return {
      ok: false,
      message: `该${meta.entity}已处于「${presentStatus}」，历史结论按原样保留，不能再执行「${action}」`,
    }
  }
  if (presentStatus === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  try {
    commitRow(
      key,
      id,
      (row) => {
        const fields: EntryRow = {
          ...row,
          status: target,
          // status 与 pending 由同一份终态清单推导，结论一次算清，不再各说各话。
          pending: !settled.has(target),
          abnormal,
        }
        if (verify) {
          fields.verifiedBy = options.operator ?? '值班管理员'
          fields.verifiedAt = new Date().toISOString()
        } else {
          // 离开校核结论时清掉旧留痕，避免下一轮结论沿用上一位校核人。
          fields.verifiedBy = undefined
          fields.verifiedAt = undefined
        }
        return fields
      },
      { expectedVersion: options.expectedVersion, exclusive: verify },
    )
  } catch (error) {
    if (error instanceof VersionConflictError) {
      const winner = error.current.verifiedBy
      return {
        ok: false,
        message: winner
          ? `校核冲突：该${meta.entity}已由 ${winner} 先完成校核（当前状态「${error.current.status}」），本次操作已拒绝，请刷新后查看`
          : `校核冲突：该${meta.entity}已被他人先一步处理（当前状态「${error.current.status}」），本次操作已拒绝，请刷新后查看`,
      }
    }
    if (error instanceof InFlightError) {
      return {
        ok: false,
        message: `校核冲突：另一个校核动作正在处理该${meta.entity}，本次操作已整体拒绝，请稍后重试`,
      }
    }
    // 任何落库失败都已整体退回，没有半份字段写入。
    return { ok: false, message: `操作未完成，数据已整体退回：${(error as Error).message}` }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
