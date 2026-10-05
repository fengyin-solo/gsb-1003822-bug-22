/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  // 每次成功落库自增，用于并发校核时的乐观锁；历史数据缺省视为 0。
  version?: number
  // 终态结论的留痕，冲突拒绝时用来指明先完成的一方。
  verifiedBy?: string
  verifiedAt?: string
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
  // 已落定的终态：处于这些状态时 pending=false。不配置时回退为「状态表最后一项」。
  settledStatuses?: string[]
  // 结论需原样保留、禁止再被动作改动的冻结态（如已归档）。
  frozenStatuses?: string[]
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
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
