<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import dayjs from "dayjs";
import { ElMessage, ElMessageBox } from "element-plus";
import { useRouter } from "vue-router";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useScheduleStore } from "../stores/schedule";
import { FIELD_LABELS, LOCKED_PROTECTED_FIELDS } from "../lib/merge";
import type { Scene, SceneField, SceneStatus } from "../types";

const store = useScheduleStore();
const router = useRouter();
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

/** 场记离线工作；制片/导演/演员统筹在线维护正式通告 */
const offlineMode = computed(() => !!store.draft);
const canEditOfficial = computed(() => store.role === "制片" || store.role === "导演");
const canEditDraft = computed(() => store.role === "场记" || store.role === "制片");
const currentStatus = (status: string) => status as SceneStatus;

onMounted(() => store.loadDraft());

async function submit() {
  const result = await validate({ values: form } as any);
  if (!result.valid) return;
  saving.value = true;
  const payload = { code: form.code, title: form.title, day: form.day, start: form.start, end: form.end, locationId: form.locationId, talentIds: [...form.talentIds], equipmentIds: [...form.equipmentIds] };
  if (offlineMode.value) {
    store.ensureDraft();
    store.addDraftScene(payload);
    ElMessage.success("场次已记入离线草稿，同步时并入正式通告");
  } else if (canEditOfficial.value) {
    store.addScene(payload);
  }
  Object.assign(form, { code: "", title: "", day: "2026-10-08", start: "08:00", end: "10:00", locationId: "l1", talentIds: [], equipmentIds: [] });
  setTimeout(() => { saving.value = false; }, 240);
}

function drop(index: number) {
  if (dragging.value !== null && canEditOfficial.value && !offlineMode.value) store.moveScene(dragging.value, index);
  dragging.value = null;
}

// ---------------------------------------------------------------- 离线草稿

async function startOffline() {
  await ElMessageBox.confirm(
    "将以当前正式通告为基线创建离线草稿，场记可离线修改；恢复联网后做字段级三方合并，不会整份覆盖。",
    "开始离线改稿",
    { confirmButtonText: "创建草稿", cancelButtonText: "取消", type: "info" }
  ).catch(() => null);
  store.beginOfflineDraft();
  ElMessage.success(`已基于 ${dayjs().format("HH:mm")} 的正式通告创建离线草稿`);
}

async function retrySync() {
  const result = store.syncDraft();
  if (result.ok) {
    ElMessage.success("同步成功：已写入正式通告并记录操作历史，冲突已重算");
    await router.push("/conflicts");
  } else {
    ElMessage.warning(`同步失败，原草稿已保留：${result.reason}。恢复联网后可重试。`);
  }
}

async function discard() {
  await ElMessageBox.confirm("放弃后草稿中的全部离线修改都会丢失，确定吗？", "放弃离线草稿", { type: "warning" }).catch(() => null);
  store.discardDraft();
}

/** 演示：场记离线期间，制片在线修改同一批场次 */
function producerTouches() {
  const result = store.simulateProducerChanges();
  if (result.ok) ElMessage.success("已模拟制片在你离线期间修改 A-012、锁定并改动 A-013");
}

// ---------------------------------------------------------------- 字段编辑弹窗

interface EditTarget {
  sceneId: string;
  code: string;
  field: SceneField;
  locked: boolean;
  draft: boolean;
}
const editing = ref<EditTarget | null>(null);
const editVisible = computed({
  get: () => editing.value !== null,
  set: (open: boolean) => { if (!open) editing.value = null; }
});
const editValue = ref<string | string[]>("");

const ARRAY_FIELDS: SceneField[] = ["talentIds", "equipmentIds"];

function openEdit(scene: Scene, field: SceneField, inDraft: boolean) {
  if (inDraft) {
    if (!canEditDraft.value) return;
  } else if (!canEditOfficial.value || offlineMode.value) {
    return;
  }
  const protectedLocked = scene.locked && LOCKED_PROTECTED_FIELDS.includes(field);
  if (!inDraft && protectedLocked) {
    ElMessage.error("锁定场次的演员/场地/器材不接受普通修改，只有制片可在冲突中心确认覆盖");
    return;
  }
  editing.value = { sceneId: scene.id, code: scene.code, field, locked: scene.locked, draft: inDraft };
  editValue.value = Array.isArray(scene[field]) ? [...(scene[field] as string[])] : String(scene[field]);
}

function commitEdit() {
  if (!editing.value) return;
  const target = editing.value;
  const value = ARRAY_FIELDS.includes(target.field)
    ? (Array.isArray(editValue.value) ? editValue.value : [])
    : String(editValue.value);
  if (target.draft) {
    store.editDraftScene(target.sceneId, target.field, value);
    ElMessage.success(`草稿字段「${FIELD_LABELS[target.field]}」已记录字段名、修改时间与基线`);
  } else {
    const result = store.updateSceneField(target.sceneId, target.field, value);
    if (!result.ok) ElMessage.error(result.reason ?? "修改失败");
    else ElMessage.success("正式通告已更新，资源冲突已重算");
  }
  editing.value = null;
}

const fieldChip = (field: SceneField) => FIELD_LABELS[field];
</script>

<template>
  <section class="page">
    <div class="metrics">
      <article class="metric"><span>通告场次</span><strong>{{ store.scenes.length }}</strong></article>
      <article class="metric"><span>资源冲突</span><strong>{{ store.conflicts.length }}</strong></article>
      <article class="metric"><span>合并待处理</span><strong>{{ store.openPendingMerges.length }}</strong></article>
      <article class="metric"><span>版本快照</span><strong>{{ store.versions.length }}</strong></article>
    </div>

    <div v-if="store.draft" class="draft-banner">
      <div>
        <b>离线草稿进行中</b>
        <small class="muted">
          基线 {{ dayjs(store.draft.beganAt).format("MM-DD HH:mm") }} · 最近保存 {{ dayjs(store.draft.savedAt).format("HH:mm") }}
          · {{ Object.values(store.draft.changes).reduce((n, list) => n + list.length, 0) }} 个字段变更 · {{ store.draft.addedScenes.length }} 个新增场次
          <el-tag v-if="store.draft.syncState === '同步失败'" type="danger" size="small">同步失败，可重试</el-tag>
          <el-tag v-else type="warning" size="small">待同步</el-tag>
        </small>
        <small v-if="store.draft.lastError" class="muted">上次失败：{{ store.draft.lastError.reason }}（{{ dayjs(store.draft.lastError.time).format("HH:mm:ss") }}）</small>
      </div>
      <div class="actions">
        <button class="secondary" @click="producerTouches">模拟制片在线改同批场次</button>
        <button class="primary" @click="retrySync">{{ store.draft.syncState === '同步失败' ? '重试同步' : '同步合并' }}</button>
        <button class="danger" @click="discard">放弃草稿</button>
      </div>
    </div>
    <div v-else class="draft-banner" style="background:#eef6ff;border-color:#a9cdf0">
      <div><b>正式通告在线</b><small class="muted">场记离场改稿前先创建离线草稿，同步按字段合并，不同字段各自保留。</small></div>
      <div class="actions">
        <button class="secondary" :disabled="store.role !== '场记' && store.role !== '制片'" @click="startOffline">场记开始离线改稿</button>
      </div>
    </div>

    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><h2>{{ offlineMode ? '离线登记场次' : '新增场次' }}</h2>
          <button v-if="offlineMode" class="secondary" @click="store.saveDraft">保存草稿</button>
        </div>
        <form class="form-grid" @submit.prevent="submit">
          <label class="field"><span>场次编号</span><input v-model="form.code" placeholder="C-018" /><small>{{ errors.code }}</small></label>
          <label class="field"><span>场次名称</span><input v-model="form.title" placeholder="例如：雨夜追踪" /><small>{{ errors.title }}</small></label>
          <label class="field"><span>拍摄日</span><input v-model="form.day" type="date" /></label>
          <label class="field"><span>场地</span><select v-model="form.locationId"><option v-for="item in store.locations" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <label class="field"><span>开始</span><input v-model="form.start" type="time" /></label>
          <label class="field"><span>结束</span><input v-model="form.end" type="time" /></label>
          <label class="field wide"><span>演员档期</span><select v-model="form.talentIds" multiple style="height:92px"><option v-for="item in store.talents" :key="item.id" :value="item.id">{{ item.name }} · {{ item.role }}</option></select></label>
          <label class="field wide"><span>器材借用</span><select v-model="form.equipmentIds" multiple style="height:92px"><option v-for="item in store.equipment" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <div class="actions wide">
            <button class="primary" :disabled="saving || (!offlineMode && !canEditOfficial)">{{ offlineMode ? '记入草稿' : '保存为草稿' }}</button>
            <RouterLink class="secondary" to="/conflicts">检查冲突</RouterLink>
          </div>
        </form>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div><h2>{{ offlineMode ? '离线草稿场次（带基线）' : '当日通告顺序' }}</h2>
            <small class="muted">点击字段值即可修改；离线修改逐条记录字段、时间与基线，同步时三方合并</small>
          </div>
          <button v-if="!offlineMode" class="primary" :disabled="!canEditOfficial" @click="store.snapshot()">保存版本</button>
        </div>
        <div class="scene-list">
          <article
            v-for="(scene,index) in (offlineMode ? store.draftScenes : store.sortedScenes)"
            :key="scene.id"
            class="scene scene-edit"
            :class="{ locked: scene.locked, dragging: !offlineMode && dragging === index, draft: offlineMode }"
            :draggable="!offlineMode"
            @dragstart="!offlineMode && (dragging=index)"
            @dragover.prevent
            @drop="drop(index)"
          >
            <b>{{ index + 1 }}</b>
            <div class="scene-code">
              {{ scene.code }}
              <el-tag v-if="scene.locked" size="small" type="info">锁定</el-tag>
            </div>
            <div class="scene-title">
              <b>{{ scene.title }}</b>
              <small>{{ scene.day }} {{ scene.start }}–{{ scene.end }} · {{ store.locationName(scene.locationId) }}</small>
              <div class="field-chips">
                <el-tag
                  v-for="field in store.changedFields(scene.id)"
                  :key="field"
                  size="small"
                  :type="LOCKED_PROTECTED_FIELDS.includes(field) && scene.locked ? 'danger' : 'warning'"
                >改：{{ fieldChip(field) }}</el-tag>
              </div>
            </div>
            <span class="status" :class="scene.status">{{ scene.status }}</span>
            <div class="actions">
              <template v-if="offlineMode">
                <button class="secondary" :disabled="!canEditDraft" @click="openEdit(scene,'start',true)">改时间</button>
                <button class="secondary" :disabled="!canEditDraft" @click="openEdit(scene,'talentIds',true)">改演员</button>
                <button class="secondary" :disabled="!canEditDraft" @click="openEdit(scene,'locationId',true)">改场地</button>
                <button class="secondary" :disabled="!canEditDraft" @click="openEdit(scene,'equipmentIds',true)">改器材</button>
                <button class="secondary" :disabled="!canEditDraft" @click="openEdit(scene,'title',true)">改名称</button>
              </template>
              <template v-else>
                <button class="secondary" :disabled="!canEditOfficial || scene.locked" @click="store.updateStatus(scene.id, currentStatus(scene.status === '草稿' ? '已确认' : scene.status === '已确认' ? '拍摄中' : scene.status === '拍摄中' ? '已完成' : '已完成'))">推进</button>
                <button class="secondary" :disabled="!canEditOfficial" @click="openEdit(scene,'locationId',false)">编辑字段</button>
                <button class="secondary" :disabled="store.role !== '制片'" @click="store.toggleLock(scene.id)">{{ scene.locked ? "解锁" : "锁定" }}</button>
              </template>
            </div>
            <div class="scene-meta wide">
              <small>演员：{{ store.talentNames(scene.talentIds).join("、") || "待定" }} · 器材：{{ store.equipmentNames(scene.equipmentIds).join("、") || "无" }}</small>
              <small v-if="!offlineMode && scene.updatedAt" class="muted">最近字段修改：{{ dayjs(Math.max(...Object.values(scene.updatedAt).map((v) => new Date(v).getTime()))).format("MM-DD HH:mm") }}</small>
            </div>
          </article>
        </div>
      </section>
    </div>

    <el-dialog v-model="editVisible" :title="editing ? `修改 ${editing.code} · ${FIELD_LABELS[editing.field]}` : ''" width="420px">
      <div v-if="editing" class="edit-dialog">
        <el-alert
          v-if="editing.locked && LOCKED_PROTECTED_FIELDS.includes(editing.field) && editing.draft"
          type="warning"
          :closable="false"
          title="该场次已锁定，此修改同步时不会自动写入，将列入冲突中心由制片确认覆盖"
          style="margin-bottom:12px"
        />
        <label class="field" v-if="editing.field === 'talentIds'">
          <span>演员（可多选）</span>
          <select v-model="editValue as string[]" multiple style="height:140px">
            <option v-for="item in store.talents" :key="item.id" :value="item.id">{{ item.name }} · {{ item.role }}</option>
          </select>
        </label>
        <label class="field" v-else-if="editing.field === 'equipmentIds'">
          <span>器材（可多选）</span>
          <select v-model="editValue as string[]" multiple style="height:140px">
            <option v-for="item in store.equipment" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
        </label>
        <label class="field" v-else-if="editing.field === 'locationId'">
          <span>场地</span>
          <select v-model="editValue as string"><option v-for="item in store.locations" :key="item.id" :value="item.id">{{ item.name }}</option></select>
        </label>
        <label class="field" v-else-if="editing.field === 'day'">
          <span>拍摄日</span><input v-model="editValue as string" type="date" />
        </label>
        <label class="field" v-else-if="editing.field === 'start' || editing.field === 'end'">
          <span>{{ FIELD_LABELS[editing.field] }}</span><input v-model="editValue as string" type="time" />
        </label>
        <label class="field" v-else>
          <span>{{ FIELD_LABELS[editing.field] }}</span><input v-model="editValue as string" />
        </label>
      </div>
      <template #footer>
        <button class="secondary" @click="editing = null">取消</button>
        <button class="primary" @click="commitEdit">记录修改</button>
      </template>
    </el-dialog>
  </section>
</template>
