/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  /** 乐观锁版本号：每次成功落库 +1，缺失视为 0。跨标签页/两人同时操作靠它做冲突检测。 */
  __version?: number
  /** 结论落库时间（ISO 字符串），只有到达终态结论（已校核/已归档/已入库…）时写入。 */
  __verifiedAt?: string
  /** 结论落库的操作人。 */
  __verifier?: string
  [field: string]: string | number | boolean | undefined
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /** 列表里与内部 status 保持一致的业务镜像字段，如地层的「记录状态」、图纸的「图纸状态」。 */
  statusField?: string
  /** 走共享校核闭环的动作：前置状态、目标结论、归档冻结都由校核服务统一校验。 */
  verification?: {
    /** 允许发起校核的状态，处于其他状态一律拒绝。 */
    readyStatus: string
    /** 校核通过后的结论状态。 */
    verifiedStatus: string
  }
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  /** 被拒绝的原因是不是并发冲突（两人抢同一结论）。 */
  conflict?: boolean
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
