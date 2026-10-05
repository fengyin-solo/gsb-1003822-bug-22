<template>
  <section class="page" data-module="stratum">
    <header class="page-head">
      <div>
        <h2>地层记录管理</h2>
        <p class="page-desc">维护地层，围绕地层编号、所属探方、层位序号、土质描述做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记地层</button>
        <button class="btn" type="button" @click="exportRows">导出地层记录清单</button>
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
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无地层记录数据，可先登记地层</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条地层记录记录</span>
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
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('stratum')
const columns = ["地层编号", "所属探方", "层位序号", "土质描述", "土色描述", "包含物特征", "记录人", "校核人", "校核时间", "记录状态"]
const actions = ["提交记录", "完成校核", "退回补录"]
const statuses = ["已划分", "已记录", "已校核", "需补录"]

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
// 指标直接按当前数据计算，刷新后与表格、与实测绘图入口读到的结论保持一致。
const stats = computed(() => [
  { label: "地层总数", value: rows.value.length },
  { label: "已校核层数", value: rows.value.filter((row) => String(row.status) === "已校核").length },
  { label: "待记录层数", value: rows.value.filter((row) => String(row.status) !== "已校核" && String(row.status) !== "需补录").length },
])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '地层登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  lastConflict.value = false
  // 携带页面渲染时的版本号：两人同时校核同一地层时，后完成者会被存储层拒绝。
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
    errorMessage.value = error instanceof Error ? error.message : '地层记录列表读取失败'
  }
}

onMounted(reload)
</script>
