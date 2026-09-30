export type Role = "制片" | "导演" | "演员统筹" | "场记";
export type SceneStatus = "草稿" | "已确认" | "拍摄中" | "已完成";
export type ConflictType = "演员档期" | "场地占用" | "器材借用" | "转场时间";

/** 场次上允许逐条修改、逐条合并的字段 */
export type SceneField =
  | "code"
  | "title"
  | "day"
  | "start"
  | "end"
  | "talentIds"
  | "locationId"
  | "equipmentIds"
  | "status";

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
  /** 正式通告中每个字段的最后修改时间，用于判定离线期间制片是否改过同字段 */
  updatedAt?: Partial<Record<SceneField, string>>;
}

export interface Conflict {
  id: string;
  type: ConflictType;
  sceneIds: string[];
  message: string;
  severity: "高" | "中";
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

/** 单条字段级变更：记录字段名、修改时间与基线值 */
export interface FieldChange {
  field: SceneField;
  /** 离线修改后的值 */
  value: string | string[];
  /** 开始离线时该字段在正式通告上的基线值 */
  base: string | string[];
  modifiedAt: string;
}

export type DraftSyncState = "待同步" | "同步失败";

/**
 * 离线草稿：保存基线快照 + 字段级变更，而不是整份通告，
 * 这样第二天同步时可以与制片在线改动做三方合并。
 */
export interface OfflineDraft {
  version: 2;
  beganAt: string;
  savedAt: string;
  /** 离线开始时的正式通告快照 */
  baselineScenes: Scene[];
  /** 已存在场次的字段级变更，按场次归集 */
  changes: Record<string, FieldChange[]>;
  /** 离线期间新增的场次 */
  addedScenes: Scene[];
  syncState: DraftSyncState;
  lastError?: { time: string; reason: string } | null;
}

/** 合并后保留正式内容、等待制片在冲突中心处理的条目 */
export interface PendingMerge {
  id: string;
  kind: "字段冲突" | "锁定覆盖";
  sceneId: string;
  sceneCode: string;
  field: SceneField;
  /** 合并时保留下来的正式内容 */
  officialValue: string | string[];
  /** 未自动写入的草稿内容，等待制片定夺 */
  draftValue: string | string[];
  officialModifiedAt?: string;
  draftModifiedAt: string;
  locked: boolean;
  resolution?: "保留正式" | "采用草稿";
  resolvedAt?: string;
}
