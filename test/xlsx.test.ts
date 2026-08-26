import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  extractSourceStudents,
  inspectWorkbook,
  inspectRosterSheet,
  readSourceStudentsFromWorkbook,
} from "../src/xlsx.js";

describe("extractSourceStudents", () => {
  it("reads each five-column roster block on a row", () => {
    const students = extractSourceStudents([
      [
        "班級",
        "學號",
        "性別",
        "座號",
        "姓名",
        null,
        "班級",
        "學號",
        "性別",
        "座號",
        "姓名",
        null,
        "班級",
        "學號",
        "性別",
        "座號",
        "姓名",
      ],
      [
        "五年一班",
        111001,
        "男",
        1,
        "測試學生甲",
        null,
        "五年二班",
        111077,
        "男",
        1,
        "測試學生乙",
        null,
        "五年三班",
        111102,
        "男",
        1,
        "測試學生丙",
      ],
    ]);

    expect(students).toEqual([
      { className: "五年一班", seatNumber: 1, name: "測試學生甲" },
      { className: "五年二班", seatNumber: 1, name: "測試學生乙" },
      { className: "五年三班", seatNumber: 1, name: "測試學生丙" },
    ]);
  });

  it("discovers roster columns across the entire sheet instead of fixed block offsets", () => {
    const header = Array.from({ length: 23 }, () => null) as Array<string | number | null>;
    header[0] = "班級";
    header[3] = "座號";
    header[4] = "姓名";
    header[18] = "班級";
    header[20] = "座號";
    header[22] = "姓名";
    const students = Array.from({ length: 23 }, () => null) as Array<string | number | null>;
    students[0] = "五年一班";
    students[3] = 1;
    students[4] = "測試學生甲";
    students[18] = "五年七班";
    students[20] = 1;
    students[22] = "測試學生乙";

    expect(extractSourceStudents([header, students])).toEqual([
      { className: "五年一班", seatNumber: 1, name: "測試學生甲" },
      { className: "五年七班", seatNumber: 1, name: "測試學生乙" },
    ]);
    expect(inspectRosterSheet("五年級名單", [header, students])).toMatchObject({
      sheetName: "五年級名單",
      rosterCandidates: [
        { headerRow: 1, classColumn: 1, seatColumn: 4, nameColumn: 5, studentCount: 1 },
        { headerRow: 1, classColumn: 19, seatColumn: 21, nameColumn: 23, studentCount: 1 },
      ],
    });
  });

  it("stops a roster candidate when the same header block starts again", () => {
    const header = ["班級", null, null, "座號", "姓名"];
    expect(extractSourceStudents([
      header,
      ["五年一班", null, null, 1, "測試學生甲"],
      header,
      ["五年七班", null, null, 1, "測試學生乙"],
    ])).toEqual([
      { className: "五年一班", seatNumber: 1, name: "測試學生甲" },
      { className: "五年七班", seatNumber: 1, name: "測試學生乙" },
    ]);
  });

  it("loads the two grade sheets from an XLSX file", async () => {
    const zip = new JSZip();
    zip.file(
      "xl/workbook.xml",
      '<workbook><sheets><sheet name="五年級名單" sheetId="1" r:id="rId1"/><sheet name="六年級名單" sheetId="2" r:id="rId2"/></sheets></workbook>',
    );
    zip.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    );
    zip.file(
      "xl/sharedStrings.xml",
      '<sst><si><t>五年三班</t></si><si><t>測試學生甲</t></si><si><t>六年二班</t></si><si><t>測試學生乙</t></si></sst>',
    );
    zip.file(
      "xl/worksheets/sheet1.xml",
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="D1"><v>1</v></c><c r="E1" t="s"><v>1</v></c></row></sheetData></worksheet>',
    );
    zip.file(
      "xl/worksheets/sheet2.xml",
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>2</v></c><c r="D1"><v>1</v></c><c r="E1" t="s"><v>3</v></c></row></sheetData></worksheet>',
    );
    const directory = await mkdtemp(join(tmpdir(), "classdojo-mcp-"));
    const workbookPath = join(directory, "students.xlsx");
    await writeFile(workbookPath, await zip.generateAsync({ type: "nodebuffer" }));

    await expect(readSourceStudentsFromWorkbook(workbookPath)).resolves.toEqual([
      { className: "五年三班", seatNumber: 1, name: "測試學生甲" },
      { className: "六年二班", seatNumber: 1, name: "測試學生乙" },
    ]);
    await expect(readSourceStudentsFromWorkbook(workbookPath, { sheetNames: ["五年級名單"] })).resolves.toEqual([
      { className: "五年三班", seatNumber: 1, name: "測試學生甲" },
    ]);
    await expect(inspectWorkbook(workbookPath)).resolves.toEqual([
      { sheetName: "五年級名單", rowCount: 1, columnCount: 5, rosterCandidates: [] },
      { sheetName: "六年級名單", rowCount: 1, columnCount: 5, rosterCandidates: [] },
    ]);
  });
});
