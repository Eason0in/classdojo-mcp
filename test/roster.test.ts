import { describe, expect, it } from "vitest";

import {
  ConfirmationRequiredError,
  applyRosterImport,
  createRosterPreview,
  summarizeRosterPreview,
  verifyRoster,
  type ClassDojoAdapter,
} from "../src/roster.js";

describe("createRosterPreview", () => {
  it("sorts students by seat number and preserves a missing seat number", () => {
    const preview = createRosterPreview(
      [{ className: "604", classId: "class-604" }],
      [
        { className: "六年四班", seatNumber: 17, name: "測試學生丙" },
        { className: "六年四班", seatNumber: 1, name: "測試學生甲" },
        { className: "六年四班", seatNumber: 15, name: "測試學生乙" },
      ],
      { "604": "六年四班" },
    );

    expect(preview.classes).toEqual([
      {
        classId: "class-604",
        className: "604",
        sourceClassName: "六年四班",
        students: ["1.測試學生甲", "15.測試學生乙", "17.測試學生丙"],
        missingSeatNumbers: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16],
      },
    ]);
  });

  it("uses name-only labels only when the caller selects that format", () => {
    const preview = createRosterPreview(
      [{ className: "503", classId: "class-503" }],
      [{ className: "五年三班", seatNumber: 1, name: "測試學生甲" }],
      { "503": "五年三班" },
      "name_only",
    );

    expect(preview.classes[0].students).toEqual(["測試學生甲"]);
  });

  it("rejects duplicate display names in name-only mode", () => {
    expect(() => createRosterPreview(
      [{ className: "503", classId: "class-503" }],
      [
        { className: "五年三班", seatNumber: 1, name: "同名學生" },
        { className: "五年三班", seatNumber: 2, name: "同名學生" },
      ],
      { "503": "五年三班" },
      "name_only",
    )).toThrow("Duplicate student names in 五年三班; use seat_number_dot_name instead.");
  });
});

describe("applyRosterImport", () => {
  const adapter: ClassDojoAdapter = {
    async pasteStudents() {
      return undefined;
    },
    async getRoster() {
      return [];
    },
  };

  const preview = createRosterPreview(
    [{ className: "503", classId: "class-503" }],
    [{ className: "五年三班", seatNumber: 1, name: "測試學生甲" }],
    { "503": "五年三班" },
  );

  it("refuses to transmit student names without explicit confirmation", async () => {
    await expect(applyRosterImport(adapter, preview, false)).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
  });

  it("stops after a failed class and leaves later classes pending", async () => {
    const failingAdapter: ClassDojoAdapter = {
      ...adapter,
      async pasteStudents() {
        throw new Error("ClassDojo paste failed");
      },
    };

    await expect(applyRosterImport(failingAdapter, preview, true)).resolves.toEqual({
      classes: [
        {
          classId: "class-503",
          className: "503",
          status: "failed",
          error: "ClassDojo paste failed",
        },
      ],
      verifiedClassNames: [],
      safelyRetryableClassNames: ["503"],
      retryRequiresNewPreview: true,
      status: "failed",
    });
  });

  it("marks a class failed when its read-back roster differs from the preview", async () => {
    const incompleteAdapter: ClassDojoAdapter = {
      ...adapter,
      async getRoster() {
        return [];
      },
    };

    await expect(applyRosterImport(incompleteAdapter, preview, true)).resolves.toEqual({
      classes: [
        {
          classId: "class-503",
          className: "503",
          status: "failed",
          error: "Verification failed: roster does not match the preview.",
        },
      ],
      verifiedClassNames: [],
      safelyRetryableClassNames: ["503"],
      retryRequiresNewPreview: true,
      status: "failed",
    });
  });

  it("only sends previewed additions after the roster snapshot still matches", async () => {
    const pasted: string[][] = [];
    const guardedAdapter: ClassDojoAdapter = {
      async pasteStudents({ students }) {
        pasted.push(students);
      },
      async getRoster() {
        return pasted.length === 0 ? ["1.測試既有學生"] : ["1.測試既有學生", "2.測試學生甲"];
      },
    };
    const guardedPreview = {
      classes: [
        {
          classId: "class-503",
          className: "503",
          sourceClassName: "五年三班",
          students: ["1.測試既有學生", "2.測試學生甲"],
          missingSeatNumbers: [],
          existingStudents: ["1.測試既有學生"],
          additions: ["2.測試學生甲"],
        },
      ],
    };

    await expect(applyRosterImport(guardedAdapter, guardedPreview, true)).resolves.toMatchObject({
      status: "completed",
      verifiedClassNames: ["503"],
      safelyRetryableClassNames: [],
      retryRequiresNewPreview: false,
    });
    expect(pasted).toEqual([["2.測試學生甲"]]);
  });
});

describe("verifyRoster", () => {
  it("reports counts plus missing and unexpected students", () => {
    expect(
      verifyRoster(
        ["1.測試學生甲", "2.測試學生乙", "3.測試學生丙"],
        ["1.測試學生甲", "3.測試學生丙", "4.測試臨時學生"],
      ),
    ).toEqual({
      matches: false,
      expectedCount: 3,
      actualCount: 3,
      missingStudents: ["2.測試學生乙"],
      unexpectedStudents: ["4.測試臨時學生"],
    });
  });
});

describe("summarizeRosterPreview", () => {
  it("returns counts by default without repeating student names", () => {
    expect(summarizeRosterPreview({
      studentNameFormat: "seat_number_dot_name",
      classes: [{
        classId: "class-503",
        className: "503",
        sourceClassName: "五年三班",
        students: ["1.測試學生甲", "2.測試學生乙"],
        missingSeatNumbers: [],
        existingStudents: ["1.測試學生甲"],
        additions: ["2.測試學生乙"],
      }],
    })).toEqual({
      studentNameFormat: "seat_number_dot_name",
      classes: [{
        classId: "class-503",
        className: "503",
        sourceClassName: "五年三班",
        expectedCount: 2,
        existingCount: 1,
        additionsCount: 1,
        missingSeatNumbers: [],
      }],
    });
  });
});
