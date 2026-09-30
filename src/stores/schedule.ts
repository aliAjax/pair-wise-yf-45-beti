import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import dayjs from "dayjs";
import type { Conflict, Equipment, HistoryEntry, Location, MergeField, OfflineDraft, PendingConflict, Role, Scene, SceneStatus, SyncResult, Talent, Version } from "../types";
import { FIELD_LABELS, MERGE_FIELDS, RESOURCE_FIELDS, cloneValue, equalValue, getField, mergeDraft, setField } from "../merge";

const STORAGE_KEY = "pair-wise-yf-45/schedule-v1";
const DRAFT_KEY = "pair-wise-yf-45/offline-draft";

const talents: Talent[] = [
  { id: "t1", name: "林川", role: "男主" },
  { id: "t2", name: "周禾", role: "女主" },
  { id: "t3", name: "顾言", role: "配角" },
  { id: "t4", name: "孙宁", role: "群演领队" }
];

const locations: Location[] = [
  { id: "l1", name: "老码头" },
  { id: "l2", name: "玻璃厂房" },
  { id: "l3", name: "南站候车厅" }
];

const equipment: Equipment[] = [
  { id: "e1", name: "ARRI A机" },
  { id: "e2", name: "移动伸缩炮" },
  { id: "e3", name: "LED灯组" },
  { id: "e4", name: "跟拍车" }
];

const seedScenes: Scene[] = [
  { id: "s1", code: "A-012", title: "码头交接", day: "2026-10-08", start: "08:00", end: "11:30", talentIds: ["t1", "t3"], locationId: "l1", equipmentIds: ["e1", "e3"], status: "已确认", locked: false },
  { id: "s2", code: "A-013", title: "厂房追逐", day: "2026-10-08", start: "10:30", end: "13:00", talentIds: ["t1", "t2"], locationId: "l1", equipmentIds: ["e2", "e4"], status: "草稿", locked: false },
  { id: "s3", code: "B-021", title: "候车厅告别", day: "2026-10-09", start: "15:00", end: "18:30", talentIds: ["t2", "t3"], locationId: "l3", equipmentIds: ["e1"], status: "草稿", locked: false }
];

function readScenes(): Scene[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw).scenes as Scene[] : structuredClone(seedScenes);
  } catch {
    return structuredClone(seedScenes);
  }
}

function readHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw).history as HistoryEntry[] : [];
  } catch {
    return [];
  }
}

function readVersions(): Version[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw).versions as Version[] : [];
  } catch {
    return [];
  }
}

function readMergeConflicts(): PendingConflict[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw).mergeConflicts as PendingConflict[]) ?? [] : [];
  } catch {
    return [];
  }
}

function minutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function overlaps(a: Scene, b: Scene) {
  return a.day === b.day && minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end);
}

function shared(a: string[], b: string[]) {
  return a.some((value) => b.includes(value));
}

export const useScheduleStore = defineStore("schedule", () => {
  const scenes = ref<Scene[]>(readScenes());
  const history = ref<HistoryEntry[]>(readHistory());
  const versions = ref<Version[]>(readVersions());
  const mergeConflicts = ref<PendingConflict[]>(readMergeConflicts());
  const role = ref<Role>("制片");
  const exemptions = ref<string[]>([]);
  const online = ref(navigator.onLine);
  const draft = ref<OfflineDraft | null>(null);

  const talentNames = (ids: string[]) => ids.map((id) => talents.find((item) => item.id === id)?.name ?? id);
  const locationName = (id: string) => locations.find((item) => item.id === id)?.name ?? id;
  const equipmentNames = (ids: string[]) => ids.map((id) => equipment.find((item) => item.id === id)?.name ?? id);

  function formatFieldValue(field: string, value: unknown): string {
    if (Array.isArray(value)) {
      if (field === "talentIds") return talentNames(value as string[]).join("、") || "待定";
      if (field === "equipmentIds") return equipmentNames(value as string[]).join("、") || "无";
      return (value as string[]).join("、");
    }
    if (field === "locationId") return locationName(value as string);
    return value == null ? "—" : String(value);
  }

  const conflicts = computed<Conflict[]>(() => {
    const result: Conflict[] = [];
    for (let i = 0; i < scenes.value.length; i += 1) {
      for (let j = i + 1; j < scenes.value.length; j += 1) {
        const a = scenes.value[i];
        const b = scenes.value[j];
        if (!overlaps(a, b)) continue;
        const id = `${a.id}:${b.id}`;
        if (exemptions.value.includes(id)) continue;
        if (shared(a.talentIds, b.talentIds)) result.push({ id: `${id}:talent`, type: "演员档期", sceneIds: [a.id, b.id], message: `${talentNames(a.talentIds.filter((item) => b.talentIds.includes(item))).join("、")} 在两场戏中档期重叠`, severity: "高" });
        if (a.locationId === b.locationId) result.push({ id: `${id}:location`, type: "场地占用", sceneIds: [a.id, b.id], message: `${locationName(a.locationId)} 被同时占用`, severity: "高" });
        if (shared(a.equipmentIds, b.equipmentIds)) result.push({ id: `${id}:equipment`, type: "器材借用", sceneIds: [a.id, b.id], message: `${equipmentNames(a.equipmentIds.filter((item) => b.equipmentIds.includes(item))).join("、")} 发生借用重叠`, severity: "中" });
        if (a.locationId !== b.locationId && minutes(b.start) - minutes(a.end) < 30) result.push({ id: `${id}:transfer`, type: "转场时间", sceneIds: [a.id, b.id], message: "两个场地之间转场时间不足30分钟", severity: "中" });
      }
    }
    return result;
  });

  /** 冲突中心待处理总数：资源冲突 + 待处理合并条目。 */
  const openConflictCount = computed(() => conflicts.value.length + mergeConflicts.value.filter((item) => item.status === "pending").length);

  /** 展示中的场次：离线时展示草稿，在线时展示正式通告。 */
  const displayScenes = computed(() => (online.value ? scenes.value : draft.value?.scenes ?? scenes.value));

  const sortedScenes = computed(() => [...displayScenes.value].sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`)));

  function log(action: string, detail: string) {
    history.value.unshift({ id: crypto.randomUUID(), action, detail, time: new Date().toISOString() });
    history.value = history.value.slice(0, 80);
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ scenes: scenes.value, history: history.value, versions: versions.value, mergeConflicts: mergeConflicts.value }));
  }

  watch([scenes, history, versions, mergeConflicts], persist, { deep: true });

  function persistDraft() {
    if (!draft.value) return;
    draft.value.savedAt = new Date().toISOString();
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft.value));
  }

  /** 离线编辑前确保草稿存在：基线取当前正式通告。 */
  function ensureDraft() {
    if (draft.value) return;
    draft.value = { scenes: structuredClone(scenes.value), baseline: structuredClone(scenes.value), changes: [], savedAt: new Date().toISOString() };
    persistDraft();
  }

  function addScene(input: Omit<Scene, "id" | "status" | "locked" | "updatedAt">): { ok: boolean; reason?: string } {
    const now = new Date().toISOString();
    if (!online.value) {
      ensureDraft();
      const newScene: Scene = { ...input, id: crypto.randomUUID(), status: "草稿", locked: false };
      draft.value!.scenes.push(newScene);
      for (const field of MERGE_FIELDS) {
        draft.value!.changes.push({ sceneId: newScene.id, field, time: now, baseline: null });
      }
      persistDraft();
      return { ok: true };
    }
    scenes.value.push({ ...input, id: crypto.randomUUID(), status: "草稿", locked: false, updatedAt: now });
    log("新增场次", `${input.code} ${input.title}`);
    return { ok: true };
  }

  function updateStatus(id: string, status: SceneStatus) {
    if (!online.value) return; // 状态流转为在线制片操作
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene || scene.locked) return;
    scene.status = status;
    scene.updatedAt = new Date().toISOString();
    log("流转状态", `${scene.code} → ${status}`);
  }

  function toggleLock(id: string) {
    if (!online.value) return; // 锁定为在线制片操作
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene) return;
    scene.locked = !scene.locked;
    scene.updatedAt = new Date().toISOString();
    log(scene.locked ? "锁定场次" : "解锁场次", scene.code);
  }

  function moveScene(from: number, to: number) {
    if (from === to || to < 0 || to >= displayScenes.value.length) return;
    const target = online.value ? scenes.value : draft.value?.scenes;
    if (!target) return;
    const [item] = target.splice(from, 1);
    target.splice(to, 0, item);
    if (online.value) log("调整顺序", `${item.code} 移至第 ${to + 1} 位`);
    else persistDraft();
  }

  /** 场次内容字段编辑：在线写正式通告，离线写入草稿并按字段记录变更。 */
  function updateScene(id: string, fields: Partial<Scene>): { ok: boolean; reason?: string } {
    const now = new Date().toISOString();
    if (!online.value) {
      ensureDraft();
      const draftScene = draft.value!.scenes.find((item) => item.id === id);
      if (!draftScene) return { ok: false, reason: "草稿中未找到该场次" };
      const baselineScene = draft.value!.baseline.find((item) => item.id === id);
      for (const key of Object.keys(fields) as (keyof Scene)[]) {
        if (!MERGE_FIELDS.includes(key as MergeField)) continue;
        const field = key as string;
        const existing = draft.value!.changes.find((item) => item.sceneId === id && item.field === field);
        if (existing) {
          existing.time = now;
        } else {
          draft.value!.changes.push({ sceneId: id, field, time: now, baseline: baselineScene ? cloneValue(baselineScene[key as keyof Scene]) : null });
        }
        setField(draftScene, field, cloneValue(fields[key]));
      }
      pruneChanges(draftScene, baselineScene);
      persistDraft();
      return { ok: true };
    }
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene) return { ok: false, reason: "正式通告中未找到该场次" };
    const touched = Object.keys(fields).filter((key) => MERGE_FIELDS.includes(key as MergeField));
    if (scene.locked && touched.some((field) => RESOURCE_FIELDS.includes(field as MergeField))) {
      return { ok: false, reason: "锁定场次的演员、场地、器材不接受普通修改，需制片在冲突中心确认覆盖" };
    }
    for (const key of touched as (keyof Scene)[]) {
      setField(scene, key, cloneValue(fields[key]));
    }
    scene.updatedAt = now;
    log("修改场次", `${scene.code} · ${touched.map((field) => FIELD_LABELS[field] ?? field).join("、")}`);
    return { ok: true };
  }

  /** 清理已回退到基线的字段变更记录。 */
  function pruneChanges(draftScene: Scene, baselineScene: Scene | undefined) {
    if (!baselineScene) return;
    draft.value!.changes = draft.value!.changes.filter((change) => {
      if (change.sceneId !== draftScene.id) return true;
      return !equalValue(getField(draftScene, change.field), getField(baselineScene, change.field));
    });
  }

  function snapshot(name = `版本 ${versions.value.length + 1}`) {
    versions.value.unshift({ id: crypto.randomUUID(), name, time: new Date().toISOString(), scenes: structuredClone(scenes.value) });
    versions.value = versions.value.slice(0, 12);
    log("保存版本", name);
  }

  function restore(id: string) {
    const version = versions.value.find((item) => item.id === id);
    if (!version) return;
    scenes.value = structuredClone(version.scenes);
    pruneExemptions();
    log("恢复版本", version.name);
  }

  function saveDraft() {
    ensureDraft();
    log("保存离线草稿", dayjs(draft.value!.savedAt).format("MM-DD HH:mm"));
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) {
        draft.value = null;
        return;
      }
      const parsed = JSON.parse(raw) as OfflineDraft;
      // 兼容旧草稿：无基线时以当前正式通告为基线。
      if (!parsed.baseline) {
        parsed.baseline = structuredClone(scenes.value);
        parsed.changes = [];
      }
      draft.value = parsed;
    } catch {
      draft.value = null;
    }
  }

  /** 同步离线草稿：失败则保留原草稿可重试，成功才写入正式通告与操作历史。 */
  function syncDraft(): SyncResult {
    if (!draft.value) return { ok: false, reason: "没有可同步的离线草稿" };
    if (!online.value) return { ok: false, reason: "离线状态下无法同步，请恢复在线后重试" };
    try {
      const result = mergeDraft(draft.value, scenes.value);
      // 仅在合并成功后提交
      scenes.value = result.scenes;
      const now = new Date().toISOString();
      scenes.value.forEach((scene) => {
        if (!scene.updatedAt) scene.updatedAt = now;
      });
      mergeConflicts.value.push(...result.pending, ...result.overrides);
      pruneExemptions();
      const parts = [`应用 ${result.applied} 项草稿变更`];
      if (result.pending.length) parts.push(`${result.pending.length} 项双方改待处理`);
      if (result.overrides.length) parts.push(`${result.overrides.length} 项锁定覆盖待确认`);
      log("同步离线草稿", parts.join("，"));
      if (result.pending.length) log("待处理合并冲突", result.pending.map((item) => `${item.sceneCode} ${FIELD_LABELS[item.field] ?? item.field}`).join("、"));
      if (result.overrides.length) log("锁定场次覆盖待确认", result.overrides.map((item) => `${item.sceneCode} ${FIELD_LABELS[item.field] ?? item.field}`).join("、"));
      log("重算资源冲突", `演员/场地/器材/转场冲突现 ${conflicts.value.length} 项`);
      draft.value = null;
      localStorage.removeItem(DRAFT_KEY);
      return { ok: true, summary: parts.join("；"), applied: result.applied, pending: result.pending.length, overrides: result.overrides.length };
    } catch (error) {
      return { ok: false, reason: `同步失败：${(error as Error).message}，原草稿已保留，可重试` };
    }
  }

  /** 制片在冲突中心处理待处理条目。 */
  function resolveConflict(id: string, action: PendingConflict["resolution"]): { ok: boolean; reason?: string } {
    if (role.value !== "制片") return { ok: false, reason: "仅制片可在冲突中心确认覆盖" };
    const item = mergeConflicts.value.find((entry) => entry.id === id);
    if (!item || item.status !== "pending") return { ok: false, reason: "该条目已处理或不存在" };
    const scene = scenes.value.find((entry) => entry.id === item.sceneId);
    if ((action === "use-draft" || action === "override") && scene) {
      setField(scene, item.field, cloneValue(item.draftValue));
      scene.updatedAt = new Date().toISOString();
    }
    item.status = "resolved";
    item.resolution = action;
    pruneExemptions();
    const actionText = action === "use-draft" ? "采用草稿内容" : action === "override" ? "确认覆盖" : action === "keep-formal" ? "保留正式内容" : "拒绝草稿修改";
    log("处理合并冲突", `${item.sceneCode} ${FIELD_LABELS[item.field] ?? item.field} · ${actionText}`);
    log("重算资源冲突", `演员/场地/器材/转场冲突现 ${conflicts.value.length} 项`);
    return { ok: true };
  }

  /** 清除已失效的冲突豁免（场次变化后冲突 id 可能不再对应）。 */
  function pruneExemptions() {
    const current = new Set(conflicts.value.map((item) => item.id));
    exemptions.value = exemptions.value.filter((id) => current.has(id));
  }

  function exempt(id: string) {
    exemptions.value.push(id);
    log("豁免冲突", id);
  }

  function setOnline(value: boolean) {
    online.value = value;
    if (!value) ensureDraft();
  }

  return {
    scenes,
    sortedScenes,
    displayScenes,
    conflicts,
    openConflictCount,
    history,
    versions,
    mergeConflicts,
    role,
    exemptions,
    online,
    draft,
    talents,
    locations,
    equipment,
    talentNames,
    equipmentNames,
    locationName,
    formatFieldValue,
    addScene,
    updateScene,
    updateStatus,
    toggleLock,
    moveScene,
    snapshot,
    restore,
    saveDraft,
    loadDraft,
    syncDraft,
    resolveConflict,
    exempt,
    setOnline
  };
});
