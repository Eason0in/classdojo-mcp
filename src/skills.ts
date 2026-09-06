import type { ClassRef } from "./roster.js";

export type SkillCategory = "positive" | "needs_work";

export type SkillRule = {
  category: SkillCategory;
  name: string;
  points: number;
  iconId: number;
};

export type SkillRuleInput = Omit<SkillRule, "iconId"> & { iconId?: number };

export const DEFAULT_SKILL_PRESET_ID = "traditional_chinese_classroom_v1";

export const DEFAULT_SKILL_PRESET: SkillRule[] = [
  { category: "positive", name: "全班準時上課", points: 2, iconId: 34 },
  { category: "positive", name: "努力", points: 1, iconId: 13 },
  { category: "positive", name: "團隊合作", points: 1, iconId: 5 },
  { category: "positive", name: "完成特務🕵️", points: 5, iconId: 74 },
  { category: "positive", name: "幫助他人", points: 1, iconId: 24 },
  { category: "positive", name: "用品攜帶齊全", points: 2, iconId: 26 },
  { category: "positive", name: "積極參與", points: 1, iconId: 15 },
  { category: "positive", name: "考試無人補考", points: 5, iconId: 10 },
  { category: "positive", name: "音樂小老師", points: 2, iconId: 14 },
  { category: "needs_work", name: "事假", points: 0, iconId: 73 },
  { category: "needs_work", name: "作業未完成", points: -1, iconId: 6 },
  { category: "needs_work", name: "情節嚴重", points: -5, iconId: 2 },
  { category: "needs_work", name: "無理", points: -1, iconId: 12 },
  { category: "needs_work", name: "病假", points: 0, iconId: 54 },
  { category: "needs_work", name: "遲到進教室", points: -1, iconId: 51 },
];

const DEFAULT_ICON_IDS: Record<SkillCategory, number> = {
  positive: 13,
  needs_work: 6,
};

export function normalizeSkillRules(rules: SkillRuleInput[]): SkillRule[] {
  if (rules.length === 0) throw new Error("At least one skill is required.");

  const names = new Set<string>();
  return rules.map((rule) => {
    const name = rule.name.trim();
    if (!name) throw new Error("Skill names must not be empty.");
    if (names.has(name)) throw new Error(`Skill names must be unique: ${name}.`);
    names.add(name);

    if (!Number.isInteger(rule.points)) throw new Error(`Skill points must be integers: ${name}.`);
    if (rule.category === "positive" && (rule.points < 0 || rule.points > 5)) {
      throw new Error(`Positive skill points must be between 0 and 5: ${name}.`);
    }
    if (rule.category === "needs_work" && (rule.points < -5 || rule.points > 0)) {
      throw new Error(`Needs-work skill points must be between -5 and 0: ${name}.`);
    }

    const iconId = rule.iconId ?? DEFAULT_ICON_IDS[rule.category];
    if (!Number.isInteger(iconId) || iconId < 1 || iconId > 76) {
      throw new Error(`Skill iconId must be an integer between 1 and 76: ${name}.`);
    }
    return { ...rule, name, iconId };
  });
}

export type SkillDiff = {
  matches: boolean;
  added: SkillRule[];
  updated: Array<{ before: SkillRule; after: SkillRule }>;
  removed: SkillRule[];
};

export type SkillSource =
  | { type: "preset"; presetId: string }
  | { type: "class"; className: string }
  | { type: "inline" };

export type SkillSyncPreview = {
  source: SkillSource;
  desiredSkills: SkillRule[];
  classes: Array<ClassRef & { existingSkills: SkillRule[]; diff: SkillDiff }>;
};

export interface SkillRulesAdapter {
  getSkills(classId: string): Promise<SkillRule[]>;
  replaceSkills(classId: string, expectedSkills: SkillRule[], desiredSkills: SkillRule[]): Promise<void>;
}

export class SkillConfirmationRequiredError extends Error {
  constructor() {
    super("ClassDojo skills will not be changed without confirm: true.");
    this.name = "SkillConfirmationRequiredError";
  }
}

function skillKey(rule: SkillRule): string {
  return `${rule.category}\u0000${rule.name}`;
}

function sameSkill(left: SkillRule, right: SkillRule): boolean {
  return left.points === right.points && left.iconId === right.iconId;
}

export function diffSkills(current: SkillRule[], desired: SkillRule[]): SkillDiff {
  const currentByKey = new Map(current.map((rule) => [skillKey(rule), rule]));
  const desiredByKey = new Map(desired.map((rule) => [skillKey(rule), rule]));
  const added = desired.filter((rule) => !currentByKey.has(skillKey(rule)));
  const removed = current.filter((rule) => !desiredByKey.has(skillKey(rule)));
  const updated = current.flatMap((before) => {
    const after = desiredByKey.get(skillKey(before));
    return after && !sameSkill(before, after) ? [{ before, after }] : [];
  });
  return {
    matches: added.length === 0 && updated.length === 0 && removed.length === 0,
    added,
    updated,
    removed,
  };
}

export function createSkillSyncPreview(
  classes: ClassRef[],
  desiredSkills: SkillRule[],
  existingByClassId: Record<string, SkillRule[]>,
  source: SkillSource,
): SkillSyncPreview {
  return {
    source,
    desiredSkills,
    classes: classes.map((classroom) => {
      const existingSkills = existingByClassId[classroom.classId] ?? [];
      return {
        ...classroom,
        existingSkills,
        diff: diffSkills(existingSkills, desiredSkills),
      };
    }),
  };
}

export type SkillSyncClassResult =
  | (ClassRef & { status: "unchanged" | "updated"; verifiedSkills: SkillRule[] })
  | (ClassRef & { status: "failed"; error: string; actualSkills?: SkillRule[]; actualState?: "unknown" });

export async function applySkillSync(
  adapter: SkillRulesAdapter,
  preview: SkillSyncPreview,
  confirmed: boolean,
): Promise<{
  status: "completed" | "failed";
  classes: SkillSyncClassResult[];
  verifiedClassNames: string[];
  safelyRetryableClassNames: string[];
  retryRequiresNewPreview: boolean;
}> {
  if (!confirmed) throw new SkillConfirmationRequiredError();

  const results: SkillSyncClassResult[] = [];
  for (const [classIndex, classroom] of preview.classes.entries()) {
    let actualSkills: SkillRule[] | undefined;
    let attemptedWrite = false;
    let actualStateUnknown = false;
    try {
      actualSkills = await adapter.getSkills(classroom.classId);
      if (!diffSkills(classroom.existingSkills, actualSkills).matches) {
        throw new Error("Verification failed: skills changed after the preview.");
      }

      const status = diffSkills(actualSkills, preview.desiredSkills).matches ? "unchanged" : "updated";
      if (status === "updated") {
        attemptedWrite = true;
        await adapter.replaceSkills(classroom.classId, actualSkills, preview.desiredSkills);
      }
      const verifiedSkills = await adapter.getSkills(classroom.classId);
      actualSkills = verifiedSkills;
      if (!diffSkills(verifiedSkills, preview.desiredSkills).matches) {
        throw new Error("Verification failed: skills do not match the preview.");
      }
      results.push({
        classId: classroom.classId,
        className: classroom.className,
        status,
        verifiedSkills,
      });
    } catch (error) {
      if (attemptedWrite) {
        try {
          actualSkills = await adapter.getSkills(classroom.classId);
        } catch {
          actualSkills = undefined;
          actualStateUnknown = true;
        }
      }
      results.push({
        classId: classroom.classId,
        className: classroom.className,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        ...(actualSkills ? { actualSkills } : {}),
        ...(actualStateUnknown ? { actualState: "unknown" as const } : {}),
      });
      return {
        status: "failed",
        classes: results,
        verifiedClassNames: results.filter((result) => result.status !== "failed").map((result) => result.className),
        safelyRetryableClassNames: preview.classes.slice(classIndex).map((item) => item.className),
        retryRequiresNewPreview: true,
      };
    }
  }

  return {
    status: "completed",
    classes: results,
    verifiedClassNames: results.map((result) => result.className),
    safelyRetryableClassNames: [],
    retryRequiresNewPreview: false,
  };
}
