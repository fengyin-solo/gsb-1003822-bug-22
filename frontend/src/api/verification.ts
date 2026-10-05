import { MODULE_BY_KEY } from '@/data/modules'
import {
  CommitConflict,
  commitModuleTransaction,
  invalidateCache,
  listRows,
  rowVersion,
} from '@/data/local-store'
import type { EntryRow, ModuleMeta } from '@/data/types'

/**
 * 共享校核闭环：地层记录的「完成校核」与实测绘图的「确认校核」走的是同一套校验与落库逻辑，
 * 两个入口对“某条记录是否已校核”只能拿到同一个结论。
 */

export type VerificationOutcome = 'unverified' | 'verified' | 'rework' | 'archived'

export type StratumCheck = {
  outcome: VerificationOutcome
  /** 规范化后的当前结论，两个入口都只认这一份，不再各读各的字段。 */
  status: string
  verifier?: string
  verifiedAt?: string
  /** 绘图对象在该模块里找不到对应地层时为 false。 */
  linked: boolean
}

export type SubmitVerificationOptions = {
  operator?: string
  /** 页面上这条记录被打开时的版本号，用于拒绝并发覆盖。 */
  expectedVersion?: number
  now?: () => string
}

const STRATUM_KEY = 'stratum'
const ARCHIVED_STATUS = '已归档'

/** 终态结论统一判定：已校核=通过，需补录/需修改/需重测=退回，已归档=历史归档。 */
function outcomeOf(status: string): VerificationOutcome {
  if (status === '已校核') {
    return 'verified'
  }
  if (status === ARCHIVED_STATUS) {
    return 'archived'
  }
  if (['需补录', '需修改', '需重测', '需复查'].includes(status)) {
    return 'rework'
  }
  return 'unverified'
}

/**
 * 唯一的结论读取口径：以内部 status 为准，并顺手纠正业务镜像字段与内部字段的历史分叉。
 * 注意：这里不修改任何数据；镜像字段若与内部结论分叉，会在落库动作里随事务一起愈合。
 */
export function canonicalStatus(row: EntryRow): string {
  return String(row.status ?? '')
}

/** 绘图对象 → 对应地层：按地层编号做关联（绘图对象里携带地层编号，如 STRA-0002）。 */
function findStratumByObject(drawingObject: string): EntryRow | undefined {
  const target = drawingObject.trim()
  if (!target) {
    return undefined
  }
  return listRows(STRATUM_KEY).find((row) => {
    const code = String(row['地层编号'] ?? '').trim()
    return code !== '' && target.includes(code)
  })
}

/** 跨模块读取路径：实测绘图入口通过这里判断所绘地层是否已校核，与地层页看到的结论严格一致。 */
export function getStratumCheck(drawingObject: string): StratumCheck {
  const row = findStratumByObject(drawingObject)
  if (!row) {
    return { outcome: 'unverified', status: '', linked: false }
  }
  return {
    outcome: outcomeOf(canonicalStatus(row)),
    status: canonicalStatus(row),
    verifier: row.__verifier ? String(row.__verifier) : undefined,
    verifiedAt: row.__verifiedAt ? String(row.__verifiedAt) : undefined,
    linked: true,
  }
}

function verificationMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  if (!meta.verification || !meta.statusField) {
    throw new Error(`${meta.name}没有接入共享校核闭环`)
  }
  return meta
}

function conflictResult(meta: ModuleMeta, winner: EntryRow | undefined): SubmitResult {
  const winnerText = winner?.__verifier ? `（先完成：${String(winner.__verifier)}）` : ''
  return {
    ok: false,
    conflict: true,
    message: `该${meta.entity}已被他人先完成校核${winnerText}，本次提交被拒绝以避免覆盖既有结论`,
  }
}

export type SubmitResult =
  | { ok: true; row: EntryRow; version: number }
  | { ok: false; conflict: boolean; message: string }

/**
 * 提交校核结论（通过或退回）。
 * 一次事务性落库：status / 业务镜像字段 / pending / abnormal / 校核人 / 校核时间 / 版本号
 * 在同一次 commit 里生成，任一环节失败整体退回，绝不下半份字段。
 */
export function submitVerification(
  key: string,
  id: number,
  approve: boolean,
  options: SubmitVerificationOptions = {},
): SubmitResult {
  const meta = verificationMeta(key)
  const { readyStatus, verifiedStatus } = meta.verification as {
    readyStatus: string
    verifiedStatus: string
  }
  const reworkStatus = meta.statuses.find((status) => status.startsWith('需'))
  const target = approve ? verifiedStatus : reworkStatus
  if (!target) {
    return { ok: false, conflict: false, message: `${meta.entity}没有登记退回结论状态` }
  }

  const rows = listRows(key)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, conflict: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  const expected =
    options.expectedVersion === undefined ? rowVersion(row) : Number(options.expectedVersion)

  // 并发冲突优先判定：提交者持有的是打开页面时的快照版本，版本已变说明有人先完成了操作。
  // 必须放在状态前置校验之前——否则后完成者看到的是新状态，拿不到“被谁抢先”的冲突说明。
  if (options.expectedVersion !== undefined && rowVersion(row) !== expected) {
    invalidateCache()
    const winner = listRows(key).find((item) => Number(item.id) === id)
    return conflictResult(meta, winner)
  }

  const current = canonicalStatus(row)
  // 历史记录保护：已校核或已归档的结论按原结论保留，不允许再点一次覆盖；
  // 需补录/需修改也保留原结论，必须重新提交回到就绪状态才能再次校核。
  if (current === verifiedStatus || current === ARCHIVED_STATUS || current === reworkStatus) {
    return {
      ok: false,
      conflict: false,
      message: `该${meta.entity}当前为「${current}」，属于已有结论的记录，按原结论保留，不能再次校核`,
    }
  }
  if (current !== readyStatus) {
    return {
      ok: false,
      conflict: false,
      message: `该${meta.entity}当前为「${current}」，需先到「${readyStatus}」才能校核`,
    }
  }

  const operator = options.operator ?? ''
  const timestamp = options.now ? options.now() : new Date().toISOString()

  try {
    const saved = commitModuleTransaction(
      key,
      (draft) => {
        const index = draft.findIndex((item) => Number(item.id) === id)
        if (index < 0) {
          throw new Error(`没有找到编号为 ${id} 的${meta.entity}`)
        }
        const prev = draft[index]
        // 所有结论字段一起生成、一次提交：杜绝 status 已改而镜像字段还是旧值的半份状态。
        const updated: EntryRow = {
          ...prev,
          status: target,
          [meta.statusField as string]: target,
          // 到达或退回结论都不再算待处理；退回类动作在看板上以异常态提示。
          pending: false,
          abnormal: !approve,
          __version: rowVersion(prev) + 1,
          __verifier: approve ? operator : '',
          __verifiedAt: approve ? timestamp : '',
        }
        // 业务字段「校核人/校核时间」存在时一并写进同一事务，列表导出与内部结论同源。
        if (meta.fields.includes('校核人')) {
          updated['校核人'] = approve ? operator : ''
        }
        if (meta.fields.includes('校核时间')) {
          updated['校核时间'] = approve ? timestamp : ''
        }
        draft[index] = updated
      },
      { [id]: expected },
    )
    const updated = saved.find((item) => Number(item.id) === id) as EntryRow
    return { ok: true, row: updated, version: rowVersion(updated) }
  } catch (error) {
    if (error instanceof CommitConflict) {
      // 两人同时校核同一地层：只接受先完成的一项，后完成的在这里被拒绝并说明冲突。
      invalidateCache()
      const winner = listRows(key).find((item) => Number(item.id) === id)
      return conflictResult(meta, winner)
    }
    // 落库失败：事务整体退回，存储与缓存都保持操作前的完整状态。
    return {
      ok: false,
      conflict: false,
      message: `校核结论落库失败，已整体退回：${error instanceof Error ? error.message : '未知错误'}`,
    }
  }
}
