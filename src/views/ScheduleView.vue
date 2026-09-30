<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import dayjs from "dayjs";
import { ElMessage } from "element-plus";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useScheduleStore } from "../stores/schedule";
import type { Scene, SceneStatus } from "../types";

const store = useScheduleStore();
const saving = ref(false);
const dragging = ref<number | null>(null);
const form = reactive({ code: "", title: "", day: "2026-10-08", start: "08:00", end: "10:00", locationId: "l1", talentIds: [] as string[], equipmentIds: [] as string[] });
const schema = toTypedSchema(z.object({
  code: z.string().min(2, "请输入场次编号"),
  title: z.string().min(2, "请输入场次名称"),
  day: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  locationId: z.string().min(1)
}));
const { errors, validate } = useForm({ validationSchema: schema });

const editable = computed(() => (store.role === "制片" || store.role === "导演" || !store.online));
const isOffline = computed(() => !store.online);
const currentStatus = (status: string) => status as SceneStatus;

const editingId = ref<string | null>(null);
const editForm = reactive({ code: "", title: "", day: "", start: "", end: "", locationId: "l1", talentIds: [] as string[], equipmentIds: [] as string[] });
const editingScene = computed(() => store.displayScenes.find((item) => item.id === editingId.value));
/** 在线时锁定场次的资源字段不接受普通修改（禁用）；离线时允许填写，合并时转为覆盖请求。 */
const lockResource = computed(() => (editingScene.value?.locked ?? false) && store.online);
const lockedTip = computed(() => editingScene.value?.locked ?? false);

onMounted(() => store.loadDraft());

async function submit() {
  const result = await validate({ values: form } as any);
  if (!result.valid) return;
  saving.value = true;
  const r = store.addScene({ code: form.code, title: form.title, day: form.day, start: form.start, end: form.end, locationId: form.locationId, talentIds: [...form.talentIds], equipmentIds: [...form.equipmentIds] });
  if (r.ok) {
    Object.assign(form, { code: "", title: "", day: "2026-10-08", start: "08:00", end: "10:00", locationId: "l1", talentIds: [], equipmentIds: [] });
    if (isOffline.value) ElMessage.success("已写入离线草稿，同步时合并");
  } else {
    ElMessage.warning(r.reason ?? "新增失败");
  }
  setTimeout(() => { saving.value = false; }, 240);
}

function openEdit(scene: Scene) {
  editingId.value = scene.id;
  Object.assign(editForm, { code: scene.code, title: scene.title, day: scene.day, start: scene.start, end: scene.end, locationId: scene.locationId, talentIds: [...scene.talentIds], equipmentIds: [...scene.equipmentIds] });
}

function saveEdit() {
  if (!editingId.value) return;
  const r = store.updateScene(editingId.value, {
    code: editForm.code,
    title: editForm.title,
    day: editForm.day,
    start: editForm.start,
    end: editForm.end,
    locationId: editForm.locationId,
    talentIds: [...editForm.talentIds],
    equipmentIds: [...editForm.equipmentIds]
  });
  if (r.ok) {
    ElMessage.success(isOffline.value ? "已记入离线草稿，待同步合并" : "已保存到正式通告");
    editingId.value = null;
  } else {
    ElMessage.warning(r.reason ?? "保存失败");
  }
}

function drop(index: number) {
  if (dragging.value !== null && editable.value) store.moveScene(dragging.value, index);
  dragging.value = null;
}

async function handleSync() {
  const result = store.syncDraft();
  if (result.ok) ElMessage.success(`同步完成：${result.summary}`);
  else ElMessage.error(result.reason ?? "同步失败，原草稿已保留，可重试");
}

function sceneChangedInDraft(id: string) {
  return isOffline.value && store.draft?.changes.some((item) => item.sceneId === id);
}
</script>

<template>
  <section class="page">
    <div class="metrics">
      <article class="metric"><span>通告场次</span><strong>{{ store.scenes.length }}</strong></article>
      <article class="metric"><span>待处理冲突</span><strong>{{ store.openConflictCount }}</strong></article>
      <article class="metric"><span>已确认</span><strong>{{ store.scenes.filter((item: Scene) => item.status === '已确认').length }}</strong></article>
      <article class="metric"><span>版本快照</span><strong>{{ store.versions.length }}</strong></article>
    </div>
    <div v-if="store.draft" class="draft-banner">
      <span>发现 {{ dayjs(store.draft.savedAt).format("MM-DD HH:mm") }} 的离线草稿，共 {{ store.draft.scenes.length }} 个场次、{{ store.draft.changes.length }} 项字段变更。</span>
      <div class="actions">
        <button class="secondary" @click="handleSync">{{ isOffline ? "尝试同步（离线将失败）" : "同步到正式通告" }}</button>
      </div>
    </div>
    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><h2>新增场次</h2><button class="secondary" @click="store.saveDraft">保存离线草稿</button></div>
        <form class="form-grid" @submit.prevent="submit">
          <label class="field"><span>场次编号</span><input v-model="form.code" placeholder="C-018" /><small>{{ errors.code }}</small></label>
          <label class="field"><span>场次名称</span><input v-model="form.title" placeholder="例如：雨夜追踪" /><small>{{ errors.title }}</small></label>
          <label class="field"><span>拍摄日</span><input v-model="form.day" type="date" /></label>
          <label class="field"><span>场地</span><select v-model="form.locationId"><option v-for="item in store.locations" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <label class="field"><span>开始</span><input v-model="form.start" type="time" /></label>
          <label class="field"><span>结束</span><input v-model="form.end" type="time" /></label>
          <label class="field wide"><span>演员档期</span><select v-model="form.talentIds" multiple><option v-for="item in store.talents" :key="item.id" :value="item.id">{{ item.name }} · {{ item.role }}</option></select></label>
          <label class="field wide"><span>器材借用</span><select v-model="form.equipmentIds" multiple><option v-for="item in store.equipment" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <div class="actions wide"><button class="primary" :disabled="saving || !editable">保存为草稿</button><RouterLink class="secondary" to="/conflicts">检查冲突</RouterLink></div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>{{ isOffline ? "离线草稿顺序" : "当日通告顺序" }}</h2><small class="muted">{{ isOffline ? "离线编辑仅写入草稿，同步时按字段合并" : "拖拽调整拍摄顺序，版本快照后可随时恢复" }}</small></div><button class="primary" :disabled="!editable || isOffline" @click="store.snapshot()">保存版本</button></div>
        <div class="scene-list">
          <article v-for="(scene,index) in store.sortedScenes" :key="scene.id" class="scene" :class="{ locked: scene.locked, dragging: dragging === index, changed: sceneChangedInDraft(scene.id) }" draggable="true" @dragstart="dragging=index" @dragover.prevent @drop="drop(index)">
            <b>{{ index + 1 }}</b>
            <div class="scene-code">{{ scene.code }}</div>
            <div class="scene-title"><b>{{ scene.title }}<em v-if="sceneChangedInDraft(scene.id)" class="dot-changed" title="草稿已修改">已改</em></b><small>{{ scene.start }}–{{ scene.end }} · {{ store.locationName(scene.locationId) }}</small></div>
            <span class="status" :class="scene.status">{{ scene.status }}</span>
            <div class="actions">
              <button class="secondary" @click="openEdit(scene)">编辑</button>
              <button class="secondary" :disabled="!editable || scene.locked || isOffline" @click="store.updateStatus(scene.id, currentStatus(scene.status === '草稿' ? '已确认' : scene.status === '已确认' ? '拍摄中' : scene.status === '拍摄中' ? '已完成' : '已完成'))">推进</button>
              <button class="secondary" :disabled="!editable || isOffline" @click="store.toggleLock(scene.id)">{{ scene.locked ? "解锁" : "锁定" }}</button>
            </div>
            <div class="scene-meta wide">
              <small>演员：{{ store.talentNames(scene.talentIds).join("、") || "待定" }} · 器材：{{ store.equipmentNames(scene.equipmentIds).join("、") || "无" }}</small>
            </div>
          </article>
        </div>
      </section>
    </div>

    <el-dialog v-model="editingId" :title="`编辑场次 ${editingScene?.code ?? ''}`" width="560px">
      <div v-if="editingScene" class="form-grid">
        <label class="field"><span>场次编号</span><input v-model="editForm.code" /></label>
        <label class="field"><span>场次名称</span><input v-model="editForm.title" /></label>
        <label class="field"><span>拍摄日</span><input v-model="editForm.day" type="date" /></label>
        <label class="field"><span>场地</span><select v-model="editForm.locationId" :disabled="lockResource"><option v-for="item in store.locations" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
        <label class="field"><span>开始</span><input v-model="editForm.start" type="time" /></label>
        <label class="field"><span>结束</span><input v-model="editForm.end" type="time" /></label>
        <label class="field wide"><span>演员阵容</span><select v-model="editForm.talentIds" multiple :disabled="lockResource"><option v-for="item in store.talents" :key="item.id" :value="item.id">{{ item.name }} · {{ item.role }}</option></select></label>
        <label class="field wide"><span>器材清单</span><select v-model="editForm.equipmentIds" multiple :disabled="lockResource"><option v-for="item in store.equipment" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      </div>
      <p v-if="lockedTip" class="lock-tip">
        <template v-if="isOffline">该场次已锁定，演员、场地、器材的修改不会直接生效，将作为覆盖请求列入冲突中心，由制片确认覆盖。</template>
        <template v-else>该场次已锁定，演员、场地、器材不接受普通修改；如需调整，请由制片在冲突中心确认覆盖。</template>
      </p>
      <template #footer>
        <button class="secondary" @click="editingId = null">取消</button>
        <button class="primary" @click="saveEdit">保存</button>
      </template>
    </el-dialog>
  </section>
</template>
