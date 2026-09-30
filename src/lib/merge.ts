import type {
  Conflict,
  Equipment,
  FieldChange,
  Location,
  OfflineDraft,
  PendingMerge,
  Scene,
  SceneField,
  Talent
} from "../types";

/** 锁定场次中不接受普通修改的受保护字段，只有制片可在冲突中心确认覆盖 */
export const LOCKED_PROTECTED_FIELDS: SceneField[] = ["talentIds", "locationId", "equipmentIds"];

export const FIELD_LABELS: Record<SceneField, string> = {
  code: "场次编号",
  title: "场次名称",
  day: "拍摄日",
  start: "开始时间",
  end: "结束时间",
  talentIds: "演员",
  locationId: "场地",
  equipmentIds: "器材",
  status: "状态"
};

export function fieldValue(field: SceneField, scene: Scene): string | string[] {
  return scene[field];
}

/** 字段值比较：数组按集合比较，避免顺序差异造成假冲突 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const left = [...a].map(String).sort();
    const right = [...b].map(String).sort();
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return String(a) === String(b);
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

export interface ResourceCatalog {
  talents: Talent[];
  locations: Location[];
  equipment: Equipment[];
}

/**
 * 根据当前正式通告重算演员、场地、器材与转场冲突。
 * 场次一旦变化（合并、解决待处理项、在线编辑）即调用。
 */
export function calculateConflicts(
  scenes: Scene[],
  catalog: ResourceCatalog,
  exemptedIds: string[] = []
): Conflict[] {
  const talentName = (id: string) => catalog.talents.find((item) => item.id === id)?.name ?? id;
  const locationName = (id: string) => catalog.locations.find((item) => item.id === id)?.name ?? id;
  const equipmentName = (id: string) => catalog.equipment.find((item) => item.id === id)?.name ?? id;
  const result: Conflict[] = [];

  const ordered = [...scenes].sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`));
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const a = ordered[i];
      const b = ordered[j];
      if (!overlaps(a, b)) continue;
      const id = `${a.id}:${b.id}`;
      const sharedTalents = a.talentIds.filter((item) => b.talentIds.includes(item));
      if (sharedTalents.length) {
        const conflictId = `${id}:talent`;
        if (!exemptedIds.includes(conflictId)) {
          result.push({ id: conflictId, type: "演员档期", sceneIds: [a.id, b.id], message: `${sharedTalents.map(talentName).join("、")} 在两场戏中档期重叠`, severity: "高" });
        }
      }
      if (a.locationId && a.locationId === b.locationId) {
        const conflictId = `${id}:location`;
        if (!exemptedIds.includes(conflictId)) {
          result.push({ id: conflictId, type: "场地占用", sceneIds: [a.id, b.id], message: `${locationName(a.locationId)} 被同时占用`, severity: "高" });
        }
      }
      const sharedEquipment = a.equipmentIds.filter((item) => b.equipmentIds.includes(item));
      if (sharedEquipment.length) {
        const conflictId = `${id}:equipment`;
        if (!exemptedIds.includes(conflictId)) {
          result.push({ id: conflictId, type: "器材借用", sceneIds: [a.id, b.id], message: `${sharedEquipment.map(equipmentName).join("、")} 发生借用重叠`, severity: "中" });
        }
      }
      if (a.locationId !== b.locationId && minutes(b.start) - minutes(a.end) < 30) {
        const conflictId = `${id}:transfer`;
        if (!exemptedIds.includes(conflictId)) {
          result.push({ id: conflictId, type: "转场时间", sceneIds: [a.id, b.id], message: "两个场地之间转场时间不足30分钟", severity: "中" });
        }
      }
    }
  }
  return result;
}

/** 草稿合并结果：合并后的通告 + 保留正式内容、待制片处理的条目 */
export interface MergeResult {
  mergedScenes: Scene[];
  pending: PendingMerge[];
  appliedCount: number;
  addedCount: number;
}

function makePending(
  kind: PendingMerge["kind"],
  scene: Scene,
  change: FieldChange,
  officialValue: string | string[],
  officialModifiedAt?: string
): PendingMerge {
  return {
    id: `${scene.id}:${change.field}:${change.modifiedAt}`,
    kind,
    sceneId: scene.id,
    sceneCode: scene.code,
    field: change.field,
    officialValue,
    draftValue: change.value,
    officialModifiedAt,
    draftModifiedAt: change.modifiedAt,
    locked: scene.locked
  };
}

/**
 * 三方合并（基线 / 正式 / 草稿），规则：
 * 1. 不同字段各自保留：制片与场记改的不是同一字段时，双方改动都写入；
 * 2. 同一字段双方都改：保留正式内容，列入待处理（字段冲突）；
 * 3. 锁定场次的演员、场地、器材：草稿修改不自动写入，列入待处理（锁定覆盖）；
 * 4. 仅草稿改动的字段直接写入；离线新增场次直接加入。
 */
export function mergeDraft(officialScenes: Scene[], draft: OfflineDraft): MergeResult {
  const merged = structuredClone(officialScenes);
  const officialById = new Map(officialScenes.map((scene) => [scene.id, scene]));
  const baselineById = new Map(draft.baselineScenes.map((scene) => [scene.id, scene]));
  const mergedById = new Map(merged.map((scene) => [scene.id, scene]));
  const pending: PendingMerge[] = [];
  let appliedCount = 0;

  for (const [sceneId, changes] of Object.entries(draft.changes)) {
    const mergedScene = mergedById.get(sceneId);
    if (!mergedScene) continue; // 场次已被正式通告删除，草稿变更不再应用
    const officialScene = officialById.get(sceneId)!;
    const baselineScene = baselineById.get(sceneId);

    for (const change of changes) {
      const officialValueNow = fieldValue(change.field, officialScene);
      // 规则 3：锁定场次的受保护字段，草稿不接受普通修改
      if (mergedScene.locked && LOCKED_PROTECTED_FIELDS.includes(change.field)) {
        pending.push(makePending("锁定覆盖", officialScene, change, officialValueNow, officialScene.updatedAt?.[change.field]));
        continue;
      }
      const baseValue = baselineScene ? fieldValue(change.field, baselineScene) : change.base;
      const officialChanged = !sameValue(officialValueNow, baseValue);
      // 规则 2：同一字段双方都改，保留正式内容并列入待处理
      if (officialChanged && !sameValue(officialValueNow, change.value)) {
        pending.push(makePending("字段冲突", officialScene, change, officialValueNow, officialScene.updatedAt?.[change.field]));
        continue;
      }
      // 规则 1 / 4：只有场记改，或双方恰好改成相同值 —— 草稿内容安全写入
      (mergedScene as Record<SceneField, unknown>)[change.field] = structuredClone(change.value);
      mergedScene.updatedAt = {
        ...mergedScene.updatedAt,
        [change.field]: officialChanged ? new Date().toISOString() : change.modifiedAt
      };
      appliedCount += 1;
    }
  }

  // 规则 4：离线新增场次直接并入正式通告
  for (const added of draft.addedScenes) {
    if (mergedById.has(added.id)) continue;
    const cloned = structuredClone(added);
    merged.push(cloned);
    mergedById.set(cloned.id, cloned);
  }

  return { mergedScenes: merged, pending, appliedCount, addedCount: draft.addedScenes.length };
}
