import { describe, expect, it } from "vitest";

import { AsyncOperationQueue, chooseStudentImportStrategy, detectClassDojoUiState } from "../src/browser.js";

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
