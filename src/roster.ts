export type SourceStudent = {
  className: string;
  seatNumber: number;
  name: string;
};

export type ClassRef = {
  classId: string;
  className: string;
};

export type StudentNameFormat = "seat_number_dot_name" | "name_only";

export type RosterPreviewClass = ClassRef & {
  sourceClassName: string;
  students: string[];
  missingSeatNumbers: number[];
  existingStudents?: string[];
  additions?: string[];
};

export type RosterPreview = {
  studentNameFormat: StudentNameFormat;
  classes: RosterPreviewClass[];
};

export interface ClassDojoAdapter {
  pasteStudents(input: { classId: string; students: string[]; studentNameFormat: StudentNameFormat }): Promise<void>;
  getRoster(classId: string): Promise<string[]>;
}

export class ConfirmationRequiredError extends Error {
  constructor() {
    super("Student names will not be sent without confirm: true.");
    this.name = "ConfirmationRequiredError";
  }
}

function missingSeatNumbers(students: SourceStudent[]): number[] {
  if (students.length === 0) return [];

  const seen = new Set(students.map((student) => student.seatNumber));
  const highest = Math.max(...seen);
  return Array.from({ length: highest }, (_, index) => index + 1).filter(
    (seatNumber) => !seen.has(seatNumber),
  );
}

function rosterMatches(expected: string[], actual: string[]): boolean {
  if (expected.length !== actual.length) return false;
  return [...expected].sort().every((student, index) => student === [...actual].sort()[index]);
}

export function verifyRoster(expected: string[], actual: string[]) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missingStudents = expected.filter((student) => !actualSet.has(student));
  const unexpectedStudents = actual.filter((student) => !expectedSet.has(student));
  return {
    matches: missingStudents.length === 0 && unexpectedStudents.length === 0 && expected.length === actual.length,
    expectedCount: expected.length,
    actualCount: actual.length,
    missingStudents,
    unexpectedStudents,
  };
}

export function createRosterPreview(
  classes: ClassRef[],
  sourceStudents: SourceStudent[],
  classMap: Record<string, string>,
  studentNameFormat: StudentNameFormat = "seat_number_dot_name",
): RosterPreview {
  return {
    studentNameFormat,
    classes: classes.flatMap((classRef) => {
      const sourceClassName = classMap[classRef.className];
      if (!sourceClassName) return [];

      const students = sourceStudents
        .filter((student) => student.className === sourceClassName)
        .sort((left, right) => left.seatNumber - right.seatNumber);
      if (studentNameFormat === "name_only") {
        const names = students.map((student) => student.name);
        if (new Set(names).size !== names.length) {
          throw new Error(`Duplicate student names in ${sourceClassName}; use seat_number_dot_name instead.`);
        }
      }

      return [
        {
          ...classRef,
          sourceClassName,
          students: students.map((student) =>
            studentNameFormat === "seat_number_dot_name" ? `${student.seatNumber}.${student.name}` : student.name,
          ),
          missingSeatNumbers: missingSeatNumbers(students),
        },
      ];
    }),
  };
}

export function summarizeRosterPreview(preview: RosterPreview) {
  return {
    studentNameFormat: preview.studentNameFormat,
    classes: preview.classes.map((classroom) => ({
      classId: classroom.classId,
      className: classroom.className,
      sourceClassName: classroom.sourceClassName,
      expectedCount: classroom.students.length,
      existingCount: classroom.existingStudents?.length ?? 0,
      additionsCount: classroom.additions?.length ?? classroom.students.length,
      missingSeatNumbers: classroom.missingSeatNumbers,
    })),
  };
}

export type ImportClassResult =
  | {
      classId: string;
      className: string;
      status: "imported";
      verifiedStudents: string[];
    }
  | {
      classId: string;
      className: string;
      status: "failed";
      error: string;
    };

export async function applyRosterImport(
  adapter: ClassDojoAdapter,
  preview: RosterPreview,
  confirmed: boolean,
): Promise<{
  status: "completed" | "failed";
  classes: ImportClassResult[];
  verifiedClassNames: string[];
  safelyRetryableClassNames: string[];
  retryRequiresNewPreview: boolean;
}> {
  if (!confirmed) throw new ConfirmationRequiredError();

  const results: ImportClassResult[] = [];
  for (const [classIndex, classroom] of preview.classes.entries()) {
    try {
      const currentStudents = await adapter.getRoster(classroom.classId);
      if (classroom.existingStudents && !rosterMatches(classroom.existingStudents, currentStudents)) {
        throw new Error("Verification failed: roster changed after the preview.");
      }
      const studentsToAdd = classroom.additions ?? classroom.students;
      if (studentsToAdd.length > 0) {
        await adapter.pasteStudents({
          classId: classroom.classId,
          students: studentsToAdd,
          studentNameFormat: preview.studentNameFormat,
        });
      }
      const verifiedStudents = await adapter.getRoster(classroom.classId);
      const expectedStudents = Array.from(new Set([...currentStudents, ...studentsToAdd]));
      if (!rosterMatches(expectedStudents, verifiedStudents)) {
        throw new Error("Verification failed: roster does not match the preview.");
      }
      results.push({
        classId: classroom.classId,
        className: classroom.className,
        status: "imported",
        verifiedStudents,
      });
    } catch (error) {
      results.push({
        classId: classroom.classId,
        className: classroom.className,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: "failed",
        classes: results,
        verifiedClassNames: results.filter((result) => result.status === "imported").map((result) => result.className),
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
