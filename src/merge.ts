import type { FieldChange, MergeField, PendingConflict, Scene } from "./types";

/** 参与字段级合并的场次内容字段。 */
export const MERGE_FIELDS: MergeField[] = ["code", "title", "day", "start", "end", "talentIds", "locationId", "equipmentIds"];
/** 锁定场次不接受普通修改的资源字段。 */
export const RESOURCE_FIELDS: MergeField[] = ["talentIds", "locationId", "equipmentIds"];

export const FIELD_LABELS: Record<string, string> = {
  code: "场次编号",
  title: "场次名称",
  day: "拍摄日",
  start: "开始时间",
  end: "结束时间",
  talentIds: "演员阵容",
  locationId: "场地",
  equipmentIds: "器材清单"
};

export interface DraftSnapshot {
  scenes: Scene[];
  baseline: Scene[];
  changes: FieldChange[];
  savedAt: string;
}

export interface MergeResult {
  scenes: Scene[];
  pending: PendingConflict[];
  overrides: PendingConflict[];
  applied: number;
}

/** 字段值深拷贝（字段值仅为 string 或 string[]）。 */
export function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  return value;
}

/** 字段值比较：数组按集合比较（与选择顺序无关）。 */
export function equalValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.length === sb.length && sa.every((value, index) => value === sb[index]);
  }
  return a === b;
}

export function getField(scene: Scene, field: string): unknown {
  return (scene as unknown as Record<string, unknown>)[field];
}

export function setField(scene: Scene, field: string, value: unknown) {
  (scene as unknown as Record<string, unknown>)[field] = value;
}

function buildPending(draft: DraftSnapshot, draftScene: Scene, formalScene: Scene, field: string, kind: PendingConflict["kind"]): PendingConflict {
  const change = draft.changes.find((item) => item.sceneId === draftScene.id && item.field === field);
  return {
    id: crypto.randomUUID(),
    sceneId: draftScene.id,
    sceneCode: draftScene.code,
    field,
    kind,
    draftValue: cloneValue(getField(draftScene, field)),
    formalValue: cloneValue(getField(formalScene, field)),
    draftTime: change?.time ?? draft.savedAt,
    formalTime: formalScene.updatedAt,
    status: "pending"
  };
}

/**
 * 三方字段级合并（基线 / 草稿 / 正式）：
 * - 仅草稿改 → 保留草稿；
 * - 仅正式改 → 保留正式；
 * - 双方都改 → 保留正式，列入待处理；
 * - 锁定场次的演员/场地/器材被草稿修改 → 不写入，转入覆盖待制片确认。
 *
 * 纯函数：不修改入参，返回候选正式场次与待处理条目。
 */
export function mergeDraft(draft: DraftSnapshot, formal: Scene[]): MergeResult {
  const candidate = structuredClone(formal);
  const pending: PendingConflict[] = [];
  const overrides: PendingConflict[] = [];
  let applied = 0;

  for (const draftScene of draft.scenes) {
    const baselineScene = draft.baseline.find((item) => item.id === draftScene.id);
    if (!baselineScene) {
      if (candidate.some((item) => item.id === draftScene.id)) continue;
      candidate.push(structuredClone(draftScene));
      applied += 1;
      continue;
    }
    const target = candidate.find((item) => item.id === draftScene.id);
    if (!target) continue; // 正式侧已删除该场次，草稿修改随之失效
    for (const field of MERGE_FIELDS) {
      const draftValue = getField(draftScene, field);
      const baseValue = getField(baselineScene, field);
      const formalValue = getField(target, field);
      const draftChanged = !equalValue(draftValue, baseValue);
      const formalChanged = !equalValue(formalValue, baseValue);
      if (!draftChanged) continue;
      if (!formalChanged) {
        if (RESOURCE_FIELDS.includes(field) && target.locked) {
          overrides.push(buildPending(draft, draftScene, target, field, "locked-override"));
        } else {
          setField(target, field, cloneValue(draftValue));
          applied += 1;
        }
      } else {
        pending.push(buildPending(draft, draftScene, target, field, "both-changed"));
      }
    }
  }
  return { scenes: candidate, pending, overrides, applied };
}
