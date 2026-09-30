import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import dayjs from "dayjs";
import type {
  Conflict,
  Equipment,
  FieldChange,
  HistoryEntry,
  Location,
  OfflineDraft,
  PendingMerge,
  Role,
  Scene,
  SceneField,
  SceneStatus,
  Talent,
  Version
} from "../types";
import { calculateConflicts, fieldValue, LOCKED_PROTECTED_FIELDS, mergeDraft, sameValue } from "../lib/merge";

const STORAGE_KEY = "pair-wise-yf-45/schedule-v2";
const DRAFT_KEY = "pair-wise-yf-45/offline-draft-v2";

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

interface PersistShape {
  scenes: Scene[];
  history: HistoryEntry[];
  versions: Version[];
  exemptions: string[];
  pendingMerges: PendingMerge[];
}

function readState(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistShape>;
      return {
        scenes: parsed.scenes ?? structuredClone(seedScenes),
        history: parsed.history ?? [],
        versions: parsed.versions ?? [],
        exemptions: parsed.exemptions ?? [],
        pendingMerges: parsed.pendingMerges ?? []
      };
    }
  } catch {
    /* fall through to seeds */
  }
  return { scenes: structuredClone(seedScenes), history: [], versions: [], exemptions: [], pendingMerges: [] };
}

function readDraft(): OfflineDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OfflineDraft;
    return parsed.version === 2 ? parsed : null;
  } catch {
    return null;
  }
}

export const useScheduleStore = defineStore("schedule", () => {
  const initial = readState();
  const scenes = ref<Scene[]>(initial.scenes);
  const history = ref<HistoryEntry[]>(initial.history);
  const versions = ref<Version[]>(initial.versions);
  const exemptions = ref<string[]>(initial.exemptions);
  const pendingMerges = ref<PendingMerge[]>(initial.pendingMerges);
  const role = ref<Role>("制片");
  const online = ref(navigator.onLine);
  const draft = ref<OfflineDraft | null>(readDraft());

  /** 场次每次变化后重算，recalculatedAt 标记冲突中心结果的新鲜度 */
  const conflictsRecalculatedAt = ref<string>(new Date().toISOString());
  const conflictsVersion = ref(0);

  const talentNames = (ids: string[]) => ids.map((id) => talents.find((item) => item.id === id)?.name ?? id);
  const locationName = (id: string) => locations.find((item) => item.id === id)?.name ?? id ?? "待定";
  const equipmentNames = (ids: string[]) => ids.map((id) => equipment.find((item) => item.id === id)?.name ?? id);

  const conflicts = computed<Conflict[]>(() =>
    calculateConflicts(scenes.value, { talents, locations, equipment }, exemptions.value)
  );

  const openPendingMerges = computed(() => pendingMerges.value.filter((item) => !item.resolution));

  const sortedScenes = computed(() =>
    [...scenes.value].sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`))
  );

  /** 草稿视图中的场次顺序（基线 + 新增），供场记离线编辑 */
  const draftScenes = computed<Scene[]>(() => {
    if (!draft.value) return [];
    const map = new Map<string, Scene>();
    for (const scene of draft.value.baselineScenes) map.set(scene.id, applyDraftChanges(structuredClone(scene), draft.value));
    for (const scene of draft.value.addedScenes) map.set(scene.id, applyDraftChanges(structuredClone(scene), draft.value));
    return [...map.values()].sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`));
  });

  function changedFields(sceneId: string): SceneField[] {
    if (!draft.value) return [];
    return (draft.value.changes[sceneId] ?? []).map((change) => change.field);
  }

  function log(action: string, detail: string) {
    history.value.unshift({ id: crypto.randomUUID(), action, detail, time: new Date().toISOString() });
    history.value = history.value.slice(0, 100);
  }

  function persist() {
    const payload: PersistShape = {
      scenes: scenes.value,
      history: history.value,
      versions: versions.value,
      exemptions: exemptions.value,
      pendingMerges: pendingMerges.value
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  watch([scenes, history, versions, exemptions, pendingMerges], persist, { deep: true });

  // 场次变化后重算冲突，并清理已经不再成立的旧豁免，保证冲突中心不停在旧结果。
  // 用「不含豁免」的完整冲突集合判断豁免是否仍有效，避免刚豁免的条目被误清。
  watch(
    scenes,
    () => {
      conflictsVersion.value += 1;
      conflictsRecalculatedAt.value = new Date().toISOString();
      const allLive = new Set(
        calculateConflicts(scenes.value, { talents, locations, equipment }).map((item) => item.id)
      );
      exemptions.value = exemptions.value.filter((id) => allLive.has(id));
    },
    { deep: true }
  );

  // ---------------------------------------------------------------- 正式通告编辑

  /**
   * 正式通告的字段级编辑。
   * 锁定场次的演员、场地、器材不接受普通修改；只有制片走冲突中心覆盖。
   */
  function updateSceneField(
    sceneId: string,
    field: SceneField,
    value: string | string[],
    operator: Role = role.value
  ): { ok: boolean; reason?: string } {
    const scene = scenes.value.find((item) => item.id === sceneId);
    if (!scene) return { ok: false, reason: "场次不存在" };
    if (scene.locked && LOCKED_PROTECTED_FIELDS.includes(field)) {
      return { ok: false, reason: `场次 ${scene.code} 已锁定，演员/场地/器材只能由制片在冲突中心确认覆盖` };
    }
    if (sameValue(scene[field], value)) return { ok: true };
    const oldValue = formatSceneField(field, scene);
    (scene as Record<SceneField, unknown>)[field] = structuredClone(value);
    scene.updatedAt = { ...scene.updatedAt, [field]: new Date().toISOString() };
    log(
      "修改场次",
      `${scene.code} · ${field}：「${oldValue}」→「${formatFieldValue(field, value)}」（${operator}）`
    );
    return { ok: true };
  }

  function addScene(input: Omit<Scene, "id" | "status" | "locked">, operator: Role = role.value) {
    const now = new Date().toISOString();
    const scene: Scene = {
      ...input,
      id: crypto.randomUUID(),
      status: "草稿",
      locked: false,
      updatedAt: {
        code: now, title: now, day: now, start: now, end: now,
        talentIds: now, locationId: now, equipmentIds: now
      }
    };
    scenes.value.push(scene);
    log("新增场次", `${input.code} ${input.title}（${operator}）`);
    return scene;
  }

  function updateStatus(id: string, status: SceneStatus) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene) return;
    // 锁定场次不接受普通修改（含状态流转），需先解锁
    if (scene.locked) return;
    scene.status = status;
    scene.updatedAt = { ...scene.updatedAt, status: new Date().toISOString() };
    log("流转状态", `${scene.code} → ${status}`);
  }

  function toggleLock(id: string) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene) return;
    scene.locked = !scene.locked;
    log(scene.locked ? "锁定场次" : "解锁场次", scene.code);
  }

  function moveScene(from: number, to: number) {
    if (from === to || to < 0 || to >= scenes.value.length) return;
    const [item] = scenes.value.splice(from, 1);
    scenes.value.splice(to, 0, item);
    log("调整顺序", `${item.code} 移至第 ${to + 1} 位`);
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
    log("恢复版本", version.name);
  }

  function exempt(id: string) {
    if (!exemptions.value.includes(id)) exemptions.value.push(id);
    log("豁免冲突", id);
  }

  // ---------------------------------------------------------------- 离线草稿

  /** 场记切到离线：以当前正式通告为基线创建草稿 */
  function beginOfflineDraft() {
    draft.value = {
      version: 2,
      beganAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
      baselineScenes: structuredClone(scenes.value),
      changes: {},
      addedScenes: [],
      syncState: "待同步",
      lastError: null
    };
    persistDraft();
  }

  function ensureDraft() {
    if (!draft.value) beginOfflineDraft();
  }

  function persistDraft() {
    if (draft.value) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft.value));
  }

  /** 离线编辑已存在场次：记录字段名、修改时间与基线（同字段多次编辑只留最新一条） */
  function editDraftScene(sceneId: string, field: SceneField, value: string | string[]) {
    if (!draft.value) return;
    const baseline = draft.value.baselineScenes.find((item) => item.id === sceneId)
      ?? draft.value.addedScenes.find((item) => item.id === sceneId);
    if (!baseline) return;
    const base = fieldValue(field, baseline);
    if (sameValue(base, value)) {
      // 改回基线值：撤销该字段的待同步变更
      draft.value.changes[sceneId] = (draft.value.changes[sceneId] ?? []).filter((change) => change.field !== field);
      if (!draft.value.changes[sceneId]?.length) delete draft.value.changes[sceneId];
    } else {
      const list = draft.value.changes[sceneId] ?? [];
      const existing = list.find((change) => change.field === field);
      const entry: FieldChange = {
        field,
        value: structuredClone(value),
        base: structuredClone(base),
        modifiedAt: new Date().toISOString()
      };
      if (existing) Object.assign(existing, entry);
      else list.push(entry);
      draft.value.changes[sceneId] = list;
    }
    draft.value.savedAt = new Date().toISOString();
    draft.value.syncState = "待同步";
    persistDraft();
  }

  /** 离线新增场次，直接放入草稿，同步时并入正式通告 */
  function addDraftScene(input: Omit<Scene, "id" | "status" | "locked" | "updatedAt">) {
    if (!draft.value) return;
    const now = new Date().toISOString();
    draft.value.addedScenes.push({
      ...input,
      id: crypto.randomUUID(),
      status: "草稿",
      locked: false,
      updatedAt: {
        code: now, title: now, day: now, start: now, end: now,
        talentIds: now, locationId: now, equipmentIds: now
      }
    });
    draft.value.savedAt = now;
    draft.value.syncState = "待同步";
    persistDraft();
  }

  function saveDraft() {
    if (!draft.value) beginOfflineDraft();
    if (draft.value) {
      draft.value.savedAt = new Date().toISOString();
      persistDraft();
    }
  }

  function loadDraft() {
    draft.value = readDraft();
  }

  function discardDraft() {
    draft.value = null;
    localStorage.removeItem(DRAFT_KEY);
    log("放弃离线草稿", "草稿未同步，已丢弃");
  }

  /**
   * 同步：三方合并。同步失败（当前离线）时原草稿保留、标记失败，可重试；
   * 只有合并成功才写入正式通告和操作历史。
   */
  function syncDraft(): { ok: boolean; reason?: string } {
    if (!draft.value) return { ok: false, reason: "没有可同步的草稿" };
    if (!online.value) {
      draft.value.syncState = "同步失败";
      draft.value.lastError = { time: new Date().toISOString(), reason: "当前处于离线模式，恢复联网后可重试" };
      persistDraft();
      return { ok: false, reason: draft.value.lastError.reason };
    }

    const result = mergeDraft(scenes.value, draft.value);
    scenes.value = result.mergedScenes;
    pendingMerges.value = [...pendingMerges.value.filter((item) => item.resolution), ...result.pending];

    const pendingCount = result.pending.length;
    const parts = [`自动合并 ${result.appliedCount} 个字段`, `并入新增 ${result.addedCount} 场`];
    if (pendingCount) parts.push(`${pendingCount} 项待制片在冲突中心定夺`);
    log("同步离线草稿", parts.join("，"));
    result.pending
      .filter((item) => item.kind === "字段冲突")
      .forEach((item) => log("字段冲突待处理", `${item.sceneCode} · ${item.field} 已保留正式内容`));
    result.pending
      .filter((item) => item.kind === "锁定覆盖")
      .forEach((item) => log("锁定覆盖待确认", `${item.sceneCode} · ${item.field} 需制片确认`));

    draft.value = null;
    localStorage.removeItem(DRAFT_KEY);
    return { ok: true };
  }

  /** 冲突中心：制片对保留下来的正式/草稿内容做最终选择 */
  function resolvePendingMerge(
    id: string,
    decision: "保留正式" | "采用草稿"
  ): { ok: boolean; reason?: string } {
    if (role.value !== "制片") return { ok: false, reason: "只有制片可以确认覆盖" };
    const item = pendingMerges.value.find((entry) => entry.id === id);
    if (!item || item.resolution) return { ok: false, reason: "该条目已处理" };
    const scene = scenes.value.find((entry) => entry.id === item.sceneId);
    if (!scene) return { ok: false, reason: "场次已不存在" };

    if (decision === "采用草稿") {
      (scene as Record<SceneField, unknown>)[item.field] = structuredClone(item.draftValue);
      scene.updatedAt = { ...scene.updatedAt, [item.field]: new Date().toISOString() };
    }
    item.resolution = decision;
    item.resolvedAt = new Date().toISOString();
    log(
      item.kind === "锁定覆盖" ? "制片确认覆盖锁定字段" : "制片处理字段冲突",
      `${item.sceneCode} · ${item.field} → ${decision}`
    );
    return { ok: true };
  }

  // ---------------------------------------------------------------- 演示辅助

  /**
   * 演示场记离线期间，制片在线上改动同一批场次（不同字段 + 同一字段 + 锁定字段）。
   * 不会触碰草稿。
   */
  function simulateProducerChanges() {
    const byCode = (code: string) => scenes.value.find((item) => item.code === code);
    const s1 = byCode("A-012");
    const s2 = byCode("A-013");
    if (!s1 || !s2) return { ok: false as const, reason: "演示场次不存在" };

    const stamp = (scene: Scene, field: SceneField) => {
      scene.updatedAt = { ...scene.updatedAt, [field]: new Date().toISOString() };
    };

    // 同一字段冲突：制片也改 A-012 的开始时间
    s1.start = "07:30";
    stamp(s1, "start");
    // 不同字段各自保留：制片只改 A-012 名称（场记若改的是其他字段可并存）
    s1.title = `${s1.title}（制片修订）`;
    stamp(s1, "title");

    // 锁定场次的资源：先锁定 A-013，再由制片调整其场地
    s2.locked = true;
    s2.locationId = "l2";
    stamp(s2, "locationId");

    log("制片在线修改", "A-012 开始时间/名称；锁定 A-013 并调整场地（模拟离线期间并行修改）");
    return { ok: true as const };
  }

  function setOnline(value: boolean) {
    online.value = value;
  }

  function formatFieldValue(field: SceneField, value: string | string[]): string {
    if (Array.isArray(value)) {
      if (field === "talentIds") return talentNames(value).join("、") || "空";
      if (field === "equipmentIds") return equipmentNames(value).join("、") || "空";
      return value.join("、") || "空";
    }
    if (field === "locationId") return value ? locationName(value) : "待定";
    return String(value || "空");
  }

  function formatSceneField(field: SceneField, scene: Scene, raw = false): string {
    const value = fieldValue(field, scene);
    if (raw && !Array.isArray(value)) return String(value || "空");
    return formatFieldValue(field, value);
  }

  return {
    // state
    scenes,
    sortedScenes,
    draftScenes,
    conflicts,
    conflictsRecalculatedAt,
    conflictsVersion,
    history,
    versions,
    role,
    exemptions,
    pendingMerges,
    openPendingMerges,
    online,
    draft,
    talents,
    locations,
    equipment,
    // helpers
    talentNames,
    equipmentNames,
    locationName,
    changedFields,
    formatFieldValue,
    formatSceneField,
    // official schedule
    updateSceneField,
    addScene,
    updateStatus,
    toggleLock,
    moveScene,
    snapshot,
    restore,
    exempt,
    // offline draft
    beginOfflineDraft,
    ensureDraft,
    editDraftScene,
    addDraftScene,
    saveDraft,
    loadDraft,
    discardDraft,
    syncDraft,
    resolvePendingMerge,
    // misc
    simulateProducerChanges,
    setOnline
  };
});

/** 草稿视图：把已记录的字段变更应用到基线快照上 */
function applyDraftChanges(baseScene: Scene, currentDraft: OfflineDraft): Scene {
  const changes = currentDraft.changes[baseScene.id] ?? [];
  for (const change of changes) {
    (baseScene as Record<SceneField, unknown>)[change.field] = structuredClone(change.value);
  }
  return baseScene;
}
