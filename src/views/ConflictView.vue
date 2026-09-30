<script setup lang="ts">
import { computed } from "vue";
import dayjs from "dayjs";
import { ElMessage } from "element-plus";
import { useScheduleStore } from "../stores/schedule";
import type { PendingConflict } from "../types";

const store = useScheduleStore();
const isProducer = computed(() => store.role === "制片");

function sceneName(id: string) {
  const scene = store.scenes.find((item) => item.id === id);
  return scene ? `${scene.code} ${scene.title}` : id;
}

const pendingItems = computed(() => store.mergeConflicts.filter((item) => item.status === "pending"));
const resolvedItems = computed(() => store.mergeConflicts.filter((item) => item.status === "resolved"));

function resolve(item: PendingConflict, action: "keep-formal" | "use-draft" | "override" | "reject") {
  const r = store.resolveConflict(item.id, action);
  if (r.ok) ElMessage.success("已处理并重新计算资源冲突");
  else ElMessage.warning(r.reason ?? "处理失败");
}

function fieldLabel(field: string) {
  return field === "talentIds" ? "演员阵容" : field === "locationId" ? "场地" : field === "equipmentIds" ? "器材清单" : field === "code" ? "场次编号" : field === "title" ? "场次名称" : field === "day" ? "拍摄日" : field === "start" ? "开始时间" : field === "end" ? "结束时间" : field;
}
</script>

<template>
  <section class="page">
    <section class="panel">
      <div class="panel-head"><div><h2>资源冲突中心</h2><small class="muted">系统按日期和时间段检查演员、场地、器材与转场间隔</small></div><span class="status">{{ store.conflicts.length }} 项待处理</span></div>
      <article v-for="item in store.conflicts" :key="item.id" class="conflict">
        <span class="seal">{{ item.severity }}</span>
        <div><b>{{ item.type }}</b><p>{{ item.message }}</p><small>{{ item.sceneIds.map(sceneName).join(" ↔ ") }}</small></div>
        <button class="secondary" :disabled="!isProducer" @click="store.exempt(item.id)">负责人豁免</button>
      </article>
      <el-empty v-if="!store.conflicts.length" description="当前没有未处理资源冲突" />
    </section>

    <section class="panel">
      <div class="panel-head"><div><h2>待处理合并冲突</h2><small class="muted">离线草稿与正式通告改了同一字段：默认保留正式内容，制片可决定是否采用草稿</small></div><span class="status">{{ pendingItems.filter((item) => item.kind === 'both-changed').length }} 项待处理</span></div>
      <article v-for="item in pendingItems.filter((entry) => entry.kind === 'both-changed')" :key="item.id" class="conflict merge">
        <span class="seal">合并</span>
        <div>
          <b>{{ item.sceneCode }} · {{ fieldLabel(item.field) }}</b>
          <p>草稿（{{ dayjs(item.draftTime).format("MM-DD HH:mm") }}）：{{ store.formatFieldValue(item.field, item.draftValue) }}<br />正式（{{ item.formalTime ? dayjs(item.formalTime).format("MM-DD HH:mm") : '未记录' }}）：{{ store.formatFieldValue(item.field, item.formalValue) }}</p>
        </div>
        <div class="actions">
          <button class="secondary" :disabled="!isProducer" @click="resolve(item, 'keep-formal')">保留正式</button>
          <button class="primary" :disabled="!isProducer" @click="resolve(item, 'use-draft')">采用草稿</button>
        </div>
      </article>
      <el-empty v-if="!pendingItems.some((item) => item.kind === 'both-changed')" description="没有同字段双方修改" />
    </section>

    <section class="panel">
      <div class="panel-head"><div><h2>锁定场次覆盖</h2><small class="muted">锁定场次的演员、场地、器材不接受普通修改，仅制片可确认覆盖</small></div><span class="status">{{ pendingItems.filter((item) => item.kind === 'locked-override').length }} 项待确认</span></div>
      <article v-for="item in pendingItems.filter((entry) => entry.kind === 'locked-override')" :key="item.id" class="conflict override">
        <span class="seal">锁定</span>
        <div>
          <b>{{ item.sceneCode }} · {{ fieldLabel(item.field) }}</b>
          <p>草稿要求改为：{{ store.formatFieldValue(item.field, item.draftValue) }}（{{ dayjs(item.draftTime).format("MM-DD HH:mm") }}）<br />当前正式：{{ store.formatFieldValue(item.field, item.formalValue) }}</p>
        </div>
        <div class="actions">
          <button class="secondary" :disabled="!isProducer" @click="resolve(item, 'reject')">拒绝</button>
          <button class="primary" :disabled="!isProducer" @click="resolve(item, 'override')">确认覆盖</button>
        </div>
      </article>
      <el-empty v-if="!pendingItems.some((item) => item.kind === 'locked-override')" description="没有锁定场次覆盖请求" />
    </section>

    <section v-if="resolvedItems.length" class="panel">
      <div class="panel-head"><div><h2>已处理</h2><small class="muted">本次合并中已处理的条目</small></div></div>
      <div class="history">
        <div v-for="item in resolvedItems" :key="item.id" class="history-row">
          <span class="muted">{{ dayjs(item.draftTime).format("MM-DD HH:mm") }}</span>
          <b>{{ item.sceneCode }} · {{ fieldLabel(item.field) }}</b>
          <span>{{ item.resolution === 'use-draft' ? '采用草稿' : item.resolution === 'override' ? '确认覆盖' : item.resolution === 'keep-formal' ? '保留正式' : '拒绝' }}</span>
        </div>
      </div>
    </section>
  </section>
</template>
