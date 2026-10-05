<template>
  <section class="page" data-module="drawing">
    <header class="page-head">
      <div>
        <h2>实测绘图管理</h2>
        <p class="page-desc">维护实测图纸，围绕图纸编号、绘图对象、绘图类型、比例尺做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记实测图纸</button>
        <button class="btn" type="button" @click="exportRows">导出实测绘图清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>所绘地层校核结论</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ stratumConclusion(row) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无实测绘图数据，可先登记实测图纸</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条实测绘图记录</span>
      <span v-if="errorMessage" class="error-text" :class="{ conflict: lastConflict }">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { getStratumCheck } from '@/api/verification'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('drawing')
const columns = ["图纸编号", "绘图对象", "绘图类型", "比例尺", "绘图人", "校核人", "校核时间", "图纸状态"]
const actions = ["提交校核", "确认校核", "退回修改"]
const statuses = ["绘制中", "待校核", "已校核", "已数字化", "需修改"]

const session = useSessionStore()
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const lastConflict = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: "图纸总数", value: rows.value.length },
  { label: "已校核数", value: rows.value.filter((row) => String(row.status) === "已校核").length },
  { label: "待校核数", value: rows.value.filter((row) => String(row.status) === "待校核").length },
])

// 跨模块读取：与地层记录页走同一个共享校核服务，结论不可能再出现两边相反。
function stratumConclusion(row: EntryRow): string {
  const drawingObject = String(row['绘图对象'] ?? '')
  const check = getStratumCheck(drawingObject)
  if (!check.linked) {
    return '未关联地层'
  }
  const labelMap: Record<string, string> = {
    verified: `地层已校核（${check.status}）`,
    rework: `地层${check.status}`,
    archived: `地层已归档（${check.status}）`,
    unverified: `地层${check.status}（未校核）`,
  }
  return labelMap[check.outcome] ?? check.status
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '实测图纸登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  lastConflict.value = false
  const result = applyAction(meta.key, Number(row.id), action, {
    operator: session.operator,
    expectedVersion: Number(row.__version ?? 0),
  })
  if (!result.ok) {
    errorMessage.value = result.message
    lastConflict.value = Boolean(result.conflict)
    reload()
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  lastConflict.value = false
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '实测绘图列表读取失败'
  }
}

onMounted(reload)
</script>
