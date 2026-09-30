export type Role = "制片" | "导演" | "演员统筹" | "场记";
export type SceneStatus = "草稿" | "已确认" | "拍摄中" | "已完成";
export type ConflictType = "演员档期" | "场地占用" | "器材借用" | "转场时间";
export type MergeField = "code" | "title" | "day" | "start" | "end" | "talentIds" | "locationId" | "equipmentIds";
export type ConflictKind = "both-changed" | "locked-override";
export type ConflictResolution = "keep-formal" | "use-draft" | "override" | "reject";

export interface Talent {
  id: string;
  name: string;
  role: string;
}

export interface Location {
  id: string;
  name: string;
}

export interface Equipment {
  id: string;
  name: string;
}

export interface Scene {
  id: string;
  code: string;
  title: string;
  day: string;
  start: string;
  end: string;
  talentIds: string[];
  locationId: string;
  equipmentIds: string[];
  status: SceneStatus;
  locked: boolean;
  updatedAt?: string;
}

export interface Conflict {
  id: string;
  type: ConflictType;
  sceneIds: string[];
  message: string;
  severity: "高" | "中";
}

/** 离线草稿中逐条记录的字段变更：字段名、修改时间、基线值。 */
export interface FieldChange {
  sceneId: string;
  field: string;
  time: string;
  baseline: unknown;
}

/** 合并后待制片处理的条目：同字段双方改、或锁定场次资源字段被草稿修改。 */
export interface PendingConflict {
  id: string;
  sceneId: string;
  sceneCode: string;
  field: string;
  kind: ConflictKind;
  draftValue: unknown;
  formalValue: unknown;
  draftTime: string;
  formalTime?: string;
  status: "pending" | "resolved";
  resolution?: ConflictResolution;
}

export interface HistoryEntry {
  id: string;
  action: string;
  detail: string;
  time: string;
}

export interface Version {
  id: string;
  name: string;
  time: string;
  scenes: Scene[];
}

export interface OfflineDraft {
  scenes: Scene[];
  /** 草稿创建时的正式通告快照，作为三方合并的基线。 */
  baseline: Scene[];
  changes: FieldChange[];
  savedAt: string;
}

export interface SyncResult {
  ok: boolean;
  reason?: string;
  summary?: string;
  applied?: number;
  pending?: number;
  overrides?: number;
}
