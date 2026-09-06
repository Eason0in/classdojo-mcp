import { describe, expect, it } from "vitest";

import {
  DEFAULT_SKILL_PRESET,
  DEFAULT_SKILL_PRESET_ID,
  SkillConfirmationRequiredError,
  applySkillSync,
  createSkillSyncPreview,
  diffSkills,
  normalizeSkillRules,
  type SkillRulesAdapter,
} from "../src/skills.js";

describe("default skill preset", () => {
  it("contains the agreed Traditional Chinese positive and needs-work rules", () => {
    expect(DEFAULT_SKILL_PRESET_ID).toBe("traditional_chinese_classroom_v1");
    expect(DEFAULT_SKILL_PRESET).toEqual([
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
    ]);
  });
});

describe("applySkillSync", () => {
  const desired = [{ category: "positive" as const, name: "努力", points: 2, iconId: 13 }];
  const existing = [{ category: "positive" as const, name: "努力", points: 1, iconId: 13 }];
  const classes = [
    { classId: "class-502", className: "502" },
    { classId: "class-503", className: "503" },
  ];
  const preview = createSkillSyncPreview(
    classes,
    desired,
    { "class-502": desired, "class-503": existing },
    { type: "preset", presetId: DEFAULT_SKILL_PRESET_ID },
  );

  it("requires explicit confirmation before changing any class", async () => {
    const adapter: SkillRulesAdapter = {
      getSkills: async () => [],
      replaceSkills: async () => undefined,
    };

    await expect(applySkillSync(adapter, preview, false)).rejects.toBeInstanceOf(
      SkillConfirmationRequiredError,
    );
  });

  it("skips matching classes, updates differences, and verifies read-back", async () => {
    const state: Record<string, typeof desired> = {
      "class-502": desired,
      "class-503": existing,
    };
    const replaced: string[] = [];
    const adapter: SkillRulesAdapter = {
      getSkills: async (classId) => state[classId],
      replaceSkills: async (classId, expectedSkills, skills) => {
        replaced.push(classId);
        expect(expectedSkills).toEqual(existing);
        state[classId] = skills;
      },
    };

    await expect(applySkillSync(adapter, preview, true)).resolves.toEqual({
      status: "completed",
      classes: [
        { classId: "class-502", className: "502", status: "unchanged", verifiedSkills: desired },
        { classId: "class-503", className: "503", status: "updated", verifiedSkills: desired },
      ],
      verifiedClassNames: ["502", "503"],
      safelyRetryableClassNames: [],
      retryRequiresNewPreview: false,
    });
    expect(replaced).toEqual(["class-503"]);
  });

  it("stops when a target changed after preview and reports its current state", async () => {
    const changed = [{ category: "positive" as const, name: "努力", points: 3, iconId: 13 }];
    let replaced = false;
    const adapter: SkillRulesAdapter = {
      getSkills: async (classId) => classId === "class-502" ? desired : changed,
      replaceSkills: async () => { replaced = true; },
    };

    await expect(applySkillSync(adapter, preview, true)).resolves.toEqual({
      status: "failed",
      classes: [
        { classId: "class-502", className: "502", status: "unchanged", verifiedSkills: desired },
        {
          classId: "class-503",
          className: "503",
          status: "failed",
          error: "Verification failed: skills changed after the preview.",
          actualSkills: changed,
        },
      ],
      verifiedClassNames: ["502"],
      safelyRetryableClassNames: ["503"],
      retryRequiresNewPreview: true,
    });
    expect(replaced).toBe(false);
  });

  it("re-reads the actual class state after a write fails", async () => {
    const partial = [{ category: "positive" as const, name: "部分完成", points: 1, iconId: 13 }];
    let state = existing;
    const singleClassPreview = createSkillSyncPreview(
      [classes[1]],
      desired,
      { "class-503": existing },
      { type: "preset", presetId: DEFAULT_SKILL_PRESET_ID },
    );
    const adapter: SkillRulesAdapter = {
      getSkills: async () => state,
      replaceSkills: async () => {
        state = partial;
        throw new Error("ClassDojo save failed");
      },
    };

    await expect(applySkillSync(adapter, singleClassPreview, true)).resolves.toMatchObject({
      status: "failed",
      classes: [{ status: "failed", error: "ClassDojo save failed", actualSkills: partial }],
    });
  });

  it("marks the actual state unknown when a failed write cannot be read back", async () => {
    let reads = 0;
    const singleClassPreview = createSkillSyncPreview(
      [classes[1]],
      desired,
      { "class-503": existing },
      { type: "preset", presetId: DEFAULT_SKILL_PRESET_ID },
    );
    const adapter: SkillRulesAdapter = {
      getSkills: async () => {
        reads += 1;
        if (reads === 1) return existing;
        throw new Error("ClassDojo page unavailable");
      },
      replaceSkills: async () => { throw new Error("ClassDojo save failed"); },
    };

    const result = await applySkillSync(adapter, singleClassPreview, true);
    expect(result).toMatchObject({
      status: "failed",
      classes: [{ status: "failed", error: "ClassDojo save failed", actualState: "unknown" }],
    });
    expect(result.classes[0]).not.toHaveProperty("actualSkills");
  });
});

describe("createSkillSyncPreview", () => {
  it("captures each target snapshot and its exact-replacement diff", () => {
    const desired = [{ category: "positive" as const, name: "努力", points: 2, iconId: 13 }];
    const existing = [{ category: "positive" as const, name: "努力", points: 1, iconId: 13 }];

    expect(createSkillSyncPreview(
      [{ classId: "class-502", className: "502" }],
      desired,
      { "class-502": existing },
      { type: "preset", presetId: DEFAULT_SKILL_PRESET_ID },
    )).toEqual({
      source: { type: "preset", presetId: DEFAULT_SKILL_PRESET_ID },
      desiredSkills: desired,
      classes: [{
        classId: "class-502",
        className: "502",
        existingSkills: existing,
        diff: {
          matches: false,
          added: [],
          updated: [{ before: existing[0], after: desired[0] }],
          removed: [],
        },
      }],
    });
  });
});

describe("diffSkills", () => {
  it("reports additions, point or icon updates, and removals", () => {
    const current = [
      { category: "positive" as const, name: "努力", points: 1, iconId: 13 },
      { category: "needs_work" as const, name: "遲到", points: -1, iconId: 51 },
      { category: "needs_work" as const, name: "多餘規則", points: -1, iconId: 6 },
    ];
    const desired = [
      { category: "positive" as const, name: "努力", points: 2, iconId: 13 },
      { category: "needs_work" as const, name: "遲到", points: -1, iconId: 54 },
      { category: "positive" as const, name: "團隊合作", points: 1, iconId: 5 },
    ];

    expect(diffSkills(current, desired)).toEqual({
      matches: false,
      added: [desired[2]],
      updated: [
        { before: current[0], after: desired[0] },
        { before: current[1], after: desired[1] },
      ],
      removed: [current[2]],
    });
    expect(diffSkills([...desired].reverse(), desired)).toEqual({
      matches: true,
      added: [],
      updated: [],
      removed: [],
    });
  });
});

describe("normalizeSkillRules", () => {
  it("trims names and supplies deterministic icons for inline rules", () => {
    expect(normalizeSkillRules([
      { category: "positive", name: "  主動發言  ", points: 2 },
      { category: "needs_work", name: "忘記用品", points: -1 },
    ])).toEqual([
      { category: "positive", name: "主動發言", points: 2, iconId: 13 },
      { category: "needs_work", name: "忘記用品", points: -1, iconId: 6 },
    ]);
  });

  it("rejects duplicate names and points outside the category range", () => {
    expect(() => normalizeSkillRules([
      { category: "positive", name: "努力", points: 1 },
      { category: "needs_work", name: "努力", points: -1 },
    ])).toThrow("Skill names must be unique: 努力.");
    expect(() => normalizeSkillRules([
      { category: "positive", name: "超額", points: 6 },
    ])).toThrow("Positive skill points must be between 0 and 5: 超額.");
    expect(() => normalizeSkillRules([
      { category: "needs_work", name: "方向錯誤", points: 1 },
    ])).toThrow("Needs-work skill points must be between -5 and 0: 方向錯誤.");
  });
});
