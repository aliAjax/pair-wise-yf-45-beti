<script setup lang="ts">
import dayjs from "dayjs";
import { ElMessage } from "element-plus";
import { useScheduleStore } from "../stores/schedule";
import { FIELD_LABELS } from "../lib/merge";
import type { PendingMerge } from "../types";

const store = useScheduleStore();

function sceneName(id: string) {
  const scene = store.scenes.find((item) => item.id === id);
  return scene ? `${scene.code} ${scene.title}` : id;
}

function valueText(item: PendingMerge, which: "official" | "draft") {
  const value = which === "official" ? item.officialValue : item.draftValue;
  return store.formatFieldValue(item.field, value);
}

function resolve(item: PendingMerge, decision: "保留正式" | "采用草稿") {
  const result = store.resolvePendingMerge(item.id, decision);
  if (result.ok) ElMessage.success(`已${decision}，场次变化已触发冲突重算`);
  else ElMessage.error(result.reason ?? "处理失败");
}
</script>

<template>
  <section class="page">
    <!-- 合并待处理：同字段双方都改 / 锁定字段覆盖，只有制片能定夺 -->
    <section class="panel">
      <div class="panel-head">
        <div><h2>合并待处理</h2><small class="muted">同一字段双方都改时默认保留正式内容；锁定场次的演员、场地、器材仅制片可确认覆盖</small></div>
        <span class="status">{{ store.openPendingMerges.length }} 项待制片处理</span>
      </div>
      <el-empty v-if="!store.openPendingMerges.length" description="没有待处理的合并冲突" />
      <article v-for="item in store.openPendingMerges" :key="item.id" class="conflict pending">
        <span class="seal" :class="item.kind === '锁定覆盖' ? 'lock' : ''">{{ item.kind === '锁定覆盖' ? '锁定' : '冲突' }}</span>
        <div class="pending-body">
          <b>{{ item.sceneCode }} · {{ FIELD_LABELS[item.field] }}</b>
          <p class="compare">
            <span class="side official"><label>正式（当前保留）</label>{{ valueText(item, 'official') }}<small v-if="item.officialModifiedAt">制片改于 {{ dayjs(item.officialModifiedAt).format("MM-DD HH:mm:ss") }}</small></span>
            <span class="side draft"><label>场记草稿</label>{{ valueText(item, 'draft') }}<small>场记改于 {{ dayjs(item.draftModifiedAt).format("MM-DD HH:mm:ss") }}</small></span>
          </p>
        </div>
        <div class="actions column">
          <button class="primary" :disabled="store.role !== '制片'" @click="resolve(item, '采用草稿')">制片确认覆盖</button>
          <button class="secondary" :disabled="store.role !== '制片'" @click="resolve(item, '保留正式')">维持正式</button>
          <small v-if="store.role !== '制片'" class="muted">仅制片可操作</small>
        </div>
      </article>
    </section>

    <!-- 资源冲突：合并或处理后立即重算的最新结果 -->
    <section class="panel">
      <div class="panel-head">
        <div><h2>资源冲突中心</h2>
          <small class="muted">按日期和时间段检查演员、场地、器材与转场间隔；最近重算 {{ dayjs(store.conflictsRecalculatedAt).format("MM-DD HH:mm:ss") }}（第 {{ store.conflictsVersion }} 次）</small>
        </div>
        <span class="status">{{ store.conflicts.length }} 项资源冲突</span>
      </div>
      <article v-for="item in store.conflicts" :key="item.id" class="conflict">
        <span class="seal">{{ item.severity }}</span>
        <div><b>{{ item.type }}</b><p>{{ item.message }}</p><small>{{ item.sceneIds.map(sceneName).join(" ↔ ") }}</small></div>
        <button class="secondary" :disabled="store.role === '场记'" @click="store.exempt(item.id)">负责人豁免</button>
      </article>
      <el-empty v-if="!store.conflicts.length" description="当前没有未处理资源冲突" />
    </section>
  </section>
</template>
