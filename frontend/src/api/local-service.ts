import { MODULE_BY_KEY } from '@/data/modules'
import {
  CommitConflict,
  allRows,
  commitModuleTransaction,
  listRows,
  resetRows,
  rowVersion,
} from '@/data/local-store'
import { submitVerification } from '@/api/verification'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export type RunActionOptions = {
  operator?: string
  /** 页面渲染该记录时的版本号，携带后由存储层做乐观锁冲突检测。 */
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

/** 校核闭环模块以「已校核」为分界：结论之前算待处理，结论（含退回）之后不算。 */
function pendingAfterTransition(meta: ModuleMeta, target: string): boolean {
  if (meta.verification) {
    const boundary = meta.statuses.indexOf(meta.verification.verifiedStatus)
    const index = meta.statuses.indexOf(target)
    return index >= 0 && boundary >= 0 ? index < boundary : true
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  return target !== lastStatus
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

  // 校核类动作（通过/退回）统一走共享校核闭环：同一套前置校验、结论保护与事务落库。
  if (meta.verification) {
    const reworkStatus = meta.statuses.find((status) => status.startsWith('需'))
    if (target === meta.verification.verifiedStatus) {
      const result = submitVerification(key, id, true, {
        operator: options.operator,
        expectedVersion: options.expectedVersion,
      })
      return result.ok
        ? { ok: true, message: `${meta.entity}已${action}，当前状态「${result.row.status}」` }
        : { ok: false, conflict: result.conflict, message: result.message }
    }
    if (reworkStatus && target === reworkStatus) {
      const result = submitVerification(key, id, false, {
        operator: options.operator,
        expectedVersion: options.expectedVersion,
      })
      return result.ok
        ? { ok: true, message: `${meta.entity}已${action}，当前状态「${result.row.status}」` }
        : { ok: false, conflict: result.conflict, message: result.message }
    }
  }

  const rows = listRows(key)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(row.status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const expected =
    options.expectedVersion === undefined ? rowVersion(row) : Number(options.expectedVersion)
  const abnormal = NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))

  try {
    // 普通流转同样整模块事务提交：status 与业务镜像字段、版本号一起改，一起成功或一起不动。
    commitModuleTransaction(
      key,
      (draft) => {
        const index = draft.findIndex((item) => Number(item.id) === id)
        if (index < 0) {
          throw new Error(`没有找到编号为 ${id} 的${meta.entity}`)
        }
        const prev = draft[index]
        draft[index] = {
          ...prev,
          status: target,
          ...(meta.statusField ? { [meta.statusField]: target } : {}),
          pending: pendingAfterTransition(meta, target),
          abnormal,
          __version: rowVersion(prev) + 1,
          __verifier: '',
          __verifiedAt: '',
        }
      },
      { [id]: expected },
    )
  } catch (error) {
    if (error instanceof CommitConflict) {
      return {
        ok: false,
        conflict: true,
        message: `该${meta.entity}已被他人先完成操作，当前「${action}」被拒绝，请刷新后重试`,
      }
    }
    return {
      ok: false,
      message: `操作落库失败，已整体退回：${error instanceof Error ? error.message : '未知错误'}`,
    }
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
