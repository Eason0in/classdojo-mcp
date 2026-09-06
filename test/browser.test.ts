import { describe, expect, it } from "vitest";

import {
  AsyncOperationQueue,
  chooseStudentImportStrategy,
  detectClassDojoUiState,
  formatSkillPoints,
  parseSkillTile,
  parseSkillTiles,
} from "../src/browser.js";

describe("AsyncOperationQueue", () => {
  it("serializes browser operations even when callers invoke them concurrently", async () => {
    const queue = new AsyncOperationQueue();
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = queue.run(async () => {
      events.push("first:start");
      await firstMayFinish;
      events.push("first:end");
    });
    const second = queue.run(async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});

describe("chooseStudentImportStrategy", () => {
  it("uses individual additions when a seat-number prefix must be preserved", () => {
    expect(chooseStudentImportStrategy("seat_number_dot_name")).toBe("individual");
  });

  it("uses copy and paste only for name-only imports", () => {
    expect(chooseStudentImportStrategy("name_only")).toBe("copy_paste");
  });
});

describe("detectClassDojoUiState", () => {
  it("detects family invitations as a blocker", () => {
    expect(detectClassDojoUiState("编辑班级\n邀请家庭\n家长电子邮件或电话")).toBe("family_invite");
  });

  it("does not mistake the normal family-navigation button for a dialog", () => {
    expect(detectClassDojoUiState("课堂操作\n邀请家庭\n选项\n添加学生")).toBe("ready");
  });

  it("detects a student-account consent dialog as a blocker", () => {
    expect(detectClassDojoUiState("让学生也享受ClassDojo的乐趣！\n暂且略过\n我同意")).toBe("student_account_consent");
  });
});

describe("parseSkillTile", () => {
  it("reads a localized label, signed points, and icon id", () => {
    expect(parseSkillTile({
      category: "positive",
      label: "编辑完成特務🕵️",
      text: "完成特務🕵️+5",
      iconSrc: "https://dojoicons.classdojo.com/positive_behavior/100/74.png",
    })).toEqual({ category: "positive", name: "完成特務🕵️", points: 5, iconId: 74 });
    expect(parseSkillTile({
      category: "needs_work",
      label: "Edit Late arrival",
      text: "Late arrival-1",
      iconSrc: "https://dojoicons.classdojo.com/negative_behavior/100/51.png?size=100",
    })).toEqual({ category: "needs_work", name: "Late arrival", points: -1, iconId: 51 });
  });

  it("ignores the add-skill tile and malformed icons", () => {
    expect(parseSkillTile({
      category: "positive",
      label: "添加技能（需完善）",
      text: "添加技能",
      iconSrc: null,
    })).toBeNull();
  });
});

describe("parseSkillTiles", () => {
  it("excludes only a clearly identified add-skill tile", () => {
    expect(parseSkillTiles("positive", [
      {
        label: "编辑努力",
        text: "努力+1",
        iconSrc: "https://dojoicons.classdojo.com/positive_behavior/100/13.png",
      },
      {
        label: "添加技能（需完善）",
        text: "添加技能",
        iconSrc: null,
      },
    ])).toEqual([{ category: "positive", name: "努力", points: 1, iconId: 13 }]);
  });

  it("fails closed when any visible skill cannot be parsed", () => {
    expect(() => parseSkillTiles("positive", [
      {
        label: "编辑努力",
        text: "努力+1",
        iconSrc: "https://dojoicons.classdojo.com/positive_behavior/100/13.png",
      },
      {
        label: "编辑未知規則",
        text: "未知規則",
        iconSrc: "https://dojoicons.classdojo.com/positive_behavior/100/99.png",
      },
    ])).toThrow("Could not parse visible ClassDojo skill: 编辑未知規則.");
  });

  it("fails closed for an unexpected tile without an image", () => {
    expect(() => parseSkillTiles("positive", [
      {
        label: "编辑努力",
        text: "努力+1",
        iconSrc: null,
      },
    ])).toThrow("Could not parse visible ClassDojo skill: 编辑努力.");
  });
});

describe("formatSkillPoints", () => {
  it("matches the signed labels used by the ClassDojo points selector", () => {
    expect(formatSkillPoints(2)).toBe("+2");
    expect(formatSkillPoints(0)).toBe("0");
    expect(formatSkillPoints(-1)).toBe("-1");
  });
});
