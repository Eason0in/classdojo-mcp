import { readFile } from "node:fs/promises";
import { posix } from "node:path";

import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

import type { SourceStudent } from "./roster.js";

type CellValue = string | number | null | undefined;

export type RosterCandidate = {
  headerRow: number;
  classColumn: number;
  seatColumn: number;
  nameColumn: number;
  studentCount: number;
};

export type SheetInspection = {
  sheetName: string;
  rowCount: number;
  columnCount: number;
  rosterCandidates: RosterCandidate[];
};

function normalizedHeader(value: CellValue): string {
  return typeof value === "string" ? value.replaceAll(/\s/g, "").toLowerCase() : "";
}

function isClassHeader(value: CellValue): boolean {
  return ["班級", "班别", "class", "classname"].includes(normalizedHeader(value));
}

function isSeatHeader(value: CellValue): boolean {
  return ["座號", "座位號", "seat", "seatnumber"].includes(normalizedHeader(value));
}

function isNameHeader(value: CellValue): boolean {
  return ["姓名", "名字", "name", "studentname"].includes(normalizedHeader(value));
}

function discoverRosterColumns(rows: CellValue[][]): Omit<RosterCandidate, "studentCount">[] {
  return rows.flatMap((row, rowIndex) => {
    const classColumns = row.flatMap((value, index) => (isClassHeader(value) ? [index] : []));
    return classColumns.flatMap((classColumn) => {
      const seatColumn = row.findIndex((value, index) => index > classColumn && index <= classColumn + 12 && isSeatHeader(value));
      const nameColumn = row.findIndex((value, index) => index > classColumn && index <= classColumn + 12 && isNameHeader(value));
      if (seatColumn === -1 || nameColumn === -1) return [];
      return [{ headerRow: rowIndex + 1, classColumn: classColumn + 1, seatColumn: seatColumn + 1, nameColumn: nameColumn + 1 }];
    });
  });
}

function studentsForColumns(rows: CellValue[][], candidate: Omit<RosterCandidate, "studentCount">): SourceStudent[] {
  const students: SourceStudent[] = [];
  for (const row of rows.slice(candidate.headerRow)) {
    const className = row[candidate.classColumn - 1];
    const seatNumber = row[candidate.seatColumn - 1];
    const name = row[candidate.nameColumn - 1];
    if (isClassHeader(className) || isSeatHeader(seatNumber) || isNameHeader(name)) break;
    if (className === null || className === undefined || seatNumber === null || seatNumber === undefined || name === null || name === undefined) continue;
    if (typeof className !== "string" || typeof seatNumber !== "number" || typeof name !== "string") continue;
    const normalizedClassName = className.trim();
    const normalizedName = name.trim();
    if (!normalizedClassName || !normalizedName || !Number.isSafeInteger(seatNumber) || seatNumber < 1) {
      throw new Error("Invalid roster row: class, positive integer seat number, and student name are required.");
    }
    students.push({ className: normalizedClassName, seatNumber, name: normalizedName });
  }
  return students;
}

function legacyStudents(rows: CellValue[][]): SourceStudent[] {
  const students: SourceStudent[] = [];

  for (const row of rows) {
    for (let offset = 0; offset < row.length; offset += 1) {
      const [className, , , seatNumber, name] = row.slice(offset, offset + 5);
      if (
        typeof className !== "string" ||
        className === "班級" ||
        typeof seatNumber !== "number" ||
        typeof name !== "string"
      ) {
        continue;
      }

      const normalizedClassName = className.trim();
      const normalizedName = name.trim();
      if (!normalizedClassName || !normalizedName || !Number.isSafeInteger(seatNumber) || seatNumber < 1) {
        throw new Error("Invalid roster row: class, positive integer seat number, and student name are required.");
      }
      students.push({ className: normalizedClassName, seatNumber, name: normalizedName });
    }
  }

  return students;
}

function validateStudents(students: SourceStudent[]): SourceStudent[] {

  const seenSeats = new Set<string>();
  for (const student of students) {
    const key = `${student.className}\u0000${student.seatNumber}`;
    if (seenSeats.has(key)) throw new Error(`Duplicate seat number in ${student.className}: ${student.seatNumber}.`);
    seenSeats.add(key);
  }
  return students;
}

export function inspectRosterSheet(sheetName: string, rows: CellValue[][]): SheetInspection {
  const columns = discoverRosterColumns(rows);
  return {
    sheetName,
    rowCount: rows.length,
    columnCount: Math.max(0, ...rows.map((row) => row.length)),
    rosterCandidates: columns.map((candidate) => ({
      ...candidate,
      studentCount: studentsForColumns(rows, candidate).length,
    })),
  };
}

export function extractSourceStudents(rows: CellValue[][]): SourceStudent[] {
  const columns = discoverRosterColumns(rows);
  const students = columns.length > 0
    ? columns.flatMap((candidate) => studentsForColumns(rows, candidate))
    : legacyStudents(rows);
  return validateStudents(students);
}

const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textValue).join("");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "rPr")
      .map(([, item]) => textValue(item))
      .join("");
  }
  return "";
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/)?.[0];
  if (!letters) return -1;
  return [...letters].reduce((result, letter) => result * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function resolveCellValue(cell: Record<string, unknown>, sharedStrings: string[]): CellValue {
  const rawValue = cell.v ?? (cell.is as Record<string, unknown> | undefined)?.t;
  if (rawValue === undefined) return null;
  if (cell.t === "s") return sharedStrings[Number(rawValue)] ?? null;
  const rawText = textValue(rawValue);
  return /^\d+$/.test(rawText) ? Number(rawText) : rawText;
}

async function readXml(zip: JSZip, path: string): Promise<Record<string, unknown>> {
  const file = zip.file(path);
  if (!file) throw new Error(`Invalid XLSX: missing ${path}.`);
  return parser.parse(await file.async("text")) as Record<string, unknown>;
}

type WorkbookSheetRows = { sheetName: string; rows: CellValue[][] };

export type WorkbookReadOptions = { sheetNames?: string[] };

async function readWorkbookSheets(workbookPath: string): Promise<WorkbookSheetRows[]> {
  const workbookBytes = await readFile(workbookPath);
  if (workbookBytes.byteLength > MAX_WORKBOOK_BYTES) {
    throw new Error("Workbook is larger than the 10 MB safety limit.");
  }

  const zip = await JSZip.loadAsync(workbookBytes);
  const [workbook, relationships, sharedStringsDocument] = await Promise.all([
    readXml(zip, "xl/workbook.xml"),
    readXml(zip, "xl/_rels/workbook.xml.rels"),
    zip.file("xl/sharedStrings.xml") ? readXml(zip, "xl/sharedStrings.xml") : Promise.resolve({}),
  ]);
  const sharedStringsRoot = sharedStringsDocument as { sst?: { si?: unknown } };
  const sharedStrings = asArray(sharedStringsRoot.sst?.si).map(textValue);
  const targets = new Map(
    asArray(((relationships.Relationships as Record<string, unknown> | undefined)?.Relationship as unknown) ?? undefined).map(
      (relationship) => {
        const record = relationship as Record<string, string>;
        return [record.Id, posix.normalize(posix.join("xl", record.Target))];
      },
    ),
  );
  const sheets = asArray(
    (((workbook.workbook as Record<string, unknown> | undefined)?.sheets as Record<string, unknown> | undefined)?.sheet as unknown) ??
      undefined,
  ) as Record<string, string>[];

  const result: WorkbookSheetRows[] = [];
  for (const sheet of sheets) {
    const target = targets.get(sheet["r:id"]);
    if (!target) throw new Error(`Invalid XLSX: missing relationship for ${sheet.name}.`);
    const worksheet = await readXml(zip, target);
    const rows = asArray(
      (((worksheet.worksheet as Record<string, unknown> | undefined)?.sheetData as Record<string, unknown> | undefined)?.row as unknown) ??
        undefined,
    ) as Record<string, unknown>[];
    const sheetRows: CellValue[][] = [];
    for (const row of rows) {
      const values: CellValue[] = [];
      for (const cell of asArray(row.c as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
        const index = columnIndex(String(cell.r ?? ""));
        if (index >= 0) values[index] = resolveCellValue(cell, sharedStrings);
      }
      sheetRows.push(values);
    }
    result.push({ sheetName: sheet.name, rows: sheetRows });
  }

  return result;
}

export async function inspectWorkbook(workbookPath: string): Promise<SheetInspection[]> {
  return (await readWorkbookSheets(workbookPath)).map((sheet) => inspectRosterSheet(sheet.sheetName, sheet.rows));
}

export async function readSourceStudentsFromWorkbook(
  workbookPath: string,
  options: WorkbookReadOptions = {},
): Promise<SourceStudent[]> {
  const sheets = await readWorkbookSheets(workbookPath);
  const selectedSheets = options.sheetNames
    ? sheets.filter((sheet) => options.sheetNames?.includes(sheet.sheetName))
    : sheets;
  if (options.sheetNames && selectedSheets.length !== options.sheetNames.length) {
    const found = new Set(selectedSheets.map((sheet) => sheet.sheetName));
    throw new Error(`Workbook sheets not found: ${options.sheetNames.filter((name) => !found.has(name)).join(", ")}.`);
  }
  return validateStudents(selectedSheets.flatMap((sheet) => extractSourceStudents(sheet.rows)));
}
