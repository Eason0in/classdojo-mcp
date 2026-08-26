import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AsyncOperationQueue, CdpClassDojoAdapter, type ClassDojoBrowserAdapter } from "./browser.js";
import {
  applyRosterImport,
  createRosterPreview,
  summarizeRosterPreview,
  verifyRoster,
  type RosterPreview,
  type SourceStudent,
} from "./roster.js";
import { inspectWorkbook, readSourceStudentsFromWorkbook } from "./xlsx.js";

export const toolNames = [
  "classdojo_list_classes",
  "classdojo_inspect_workbook",
  "classdojo_get_roster",
  "classdojo_get_ui_state",
  "classdojo_preview_roster_import",
  "classdojo_apply_roster_import",
  "classdojo_verify_roster_against_workbook",
  "classdojo_doctor",
] as const;

type ClassMapping = { classdojoClassName: string; sourceClassName: string };

function validateMappings(mappings: ClassMapping[]): void {
  const targetClasses = mappings.map((mapping) => mapping.classdojoClassName);
  if (new Set(targetClasses).size !== targetClasses.length) {
    throw new Error("Each ClassDojo class may appear only once in mappings.");
  }
  const sourceClasses = mappings.map((mapping) => mapping.sourceClassName);
  if (new Set(sourceClasses).size !== sourceClasses.length) {
    throw new Error("Each workbook source class may appear only once in mappings.");
  }
}

type ServerDependencies = {
  adapter?: ClassDojoBrowserAdapter;
  readWorkbook?: (path: string, options?: { sheetNames?: string[] }) => Promise<SourceStudent[]>;
};

const PREVIEW_TTL_MS = 15 * 60 * 1000;

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function createClassDojoServer(dependencies: ServerDependencies = {}): McpServer {
  const adapter = dependencies.adapter ?? new CdpClassDojoAdapter();
  const readWorkbook = dependencies.readWorkbook ?? readSourceStudentsFromWorkbook;
  const previews = new Map<string, { preview: RosterPreview; expiresAt: number }>();
  const writes = new AsyncOperationQueue();
  const server = new McpServer({ name: "classdojo-mcp", version: "0.1.0" });

  server.registerTool(
    "classdojo_list_classes",
    {
      title: "List ClassDojo classes",
      description: "Lists the three-digit classes visible in the locally connected ClassDojo teacher session.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => jsonResult({ classes: await adapter.listClasses() }),
  );

  server.registerTool(
    "classdojo_inspect_workbook",
    {
      title: "Inspect workbook roster candidates",
      description:
        "Scans every worksheet and reports candidate class, seat-number, and student-name column groups without importing or transmitting student data.",
      inputSchema: { workbookPath: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workbookPath }) => jsonResult({ sheets: await inspectWorkbook(workbookPath) }),
  );

  server.registerTool(
    "classdojo_get_roster",
    {
      title: "Get a ClassDojo roster",
      description: "Reads a class roster without changing ClassDojo data.",
      inputSchema: { classId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ classId }) => jsonResult({ classId, students: await adapter.getRoster(classId) }),
  );

  server.registerTool(
    "classdojo_get_ui_state",
    {
      title: "Get current ClassDojo UI state",
      description:
        "Reports whether the selected class is ready, adding students, or blocked by a family-invitation, welcome-message, or student-account dialog. It does not dismiss anything.",
      inputSchema: { classId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ classId }) => jsonResult({ classId, state: await adapter.getUiState(classId) }),
  );

  server.registerTool(
    "classdojo_preview_roster_import",
    {
      title: "Preview a roster import",
      description: "Reads a local XLSX workbook and reports the student-name changes before anything is sent to ClassDojo.",
      inputSchema: {
        workbookPath: z.string().min(1),
        sheetNames: z.array(z.string().min(1)).min(1),
        studentNameFormat: z.enum(["seat_number_dot_name", "name_only"]),
        includeStudentDetails: z.boolean().default(false),
        mappings: z.array(
          z.object({ classdojoClassName: z.string().regex(/^\d{3}$/), sourceClassName: z.string().min(1) }),
        ).min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ workbookPath, sheetNames, studentNameFormat, includeStudentDetails, mappings }) => {
      validateMappings(mappings as ClassMapping[]);
      const [classes, sourceStudents] = await Promise.all([
        adapter.listClasses(),
        readWorkbook(workbookPath, { sheetNames }),
      ]);
      const requestedClassNames = (mappings as ClassMapping[]).map((mapping) => mapping.classdojoClassName);
      const classMap = Object.fromEntries(
        (mappings as ClassMapping[]).map((mapping) => [mapping.classdojoClassName, mapping.sourceClassName]),
      );
      const selectedClasses = classes.filter((classroom) => classMap[classroom.className]);
      const foundClassNames = new Set(selectedClasses.map((classroom) => classroom.className));
      const missingClasses = requestedClassNames.filter((className) => !foundClassNames.has(className));
      if (missingClasses.length > 0) {
        throw new Error(`ClassDojo classes not found: ${missingClasses.join(", ")}.`);
      }
      const missingSourceClasses = Array.from(new Set(Object.values(classMap))).filter(
        (sourceClassName) => !sourceStudents.some((student) => student.className === sourceClassName),
      );
      if (missingSourceClasses.length > 0) {
        throw new Error(`Workbook classes not found or empty: ${missingSourceClasses.join(", ")}.`);
      }
      const preview = createRosterPreview(selectedClasses, sourceStudents, classMap, studentNameFormat);
      const existingByClassId: Record<string, string[]> = {};
      for (const classroom of preview.classes) {
        existingByClassId[classroom.classId] = await adapter.getRoster(classroom.classId);
      }
      preview.classes = preview.classes.map((classroom) => ({
        ...classroom,
        existingStudents: existingByClassId[classroom.classId],
        additions: classroom.students.filter((student) => !existingByClassId[classroom.classId].includes(student)),
      }));
      const previewId = randomUUID();
      const expiresAt = Date.now() + PREVIEW_TTL_MS;
      previews.set(previewId, { preview, expiresAt });
      return jsonResult({
        previewId,
        expiresAt: new Date(expiresAt).toISOString(),
        ...(includeStudentDetails
          ? { classes: preview.classes }
          : summarizeRosterPreview(preview)),
      });
    },
  );

  server.registerTool(
    "classdojo_apply_roster_import",
    {
      title: "Apply a previously previewed roster import",
      description: "Sends student names to ClassDojo only after explicit confirmation, then verifies each class by reading it back.",
      inputSchema: { previewId: z.string().uuid(), confirm: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ previewId, confirm }) => {
      const storedPreview = previews.get(previewId);
      if (!storedPreview) throw new Error("Preview not found. Run classdojo_preview_roster_import again.");
      previews.delete(previewId);
      if (storedPreview.expiresAt <= Date.now()) {
        throw new Error("Preview expired. Run classdojo_preview_roster_import again.");
      }
      return writes.run(async () => jsonResult(await applyRosterImport(adapter, storedPreview.preview, confirm)));
    },
  );

  server.registerTool(
    "classdojo_verify_roster_against_workbook",
    {
      title: "Verify a ClassDojo roster against an XLSX workbook",
      description:
        "Reads the current ClassDojo roster and a local XLSX workbook, then reports exact count, missing, and unexpected student-name differences without changing ClassDojo data.",
      inputSchema: {
        workbookPath: z.string().min(1),
        sheetNames: z.array(z.string().min(1)).min(1),
        studentNameFormat: z.enum(["seat_number_dot_name", "name_only"]),
        mappings: z.array(
          z.object({ classdojoClassName: z.string().regex(/^\d{3}$/), sourceClassName: z.string().min(1) }),
        ).min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ workbookPath, sheetNames, studentNameFormat, mappings }) => {
      validateMappings(mappings as ClassMapping[]);
      const [classes, sourceStudents] = await Promise.all([
        adapter.listClasses(),
        readWorkbook(workbookPath, { sheetNames }),
      ]);
      const requestedClassNames = (mappings as ClassMapping[]).map((mapping) => mapping.classdojoClassName);
      const classMap = Object.fromEntries(
        (mappings as ClassMapping[]).map((mapping) => [mapping.classdojoClassName, mapping.sourceClassName]),
      );
      const selectedClasses = classes.filter((classroom) => classMap[classroom.className]);
      const foundClassNames = new Set(selectedClasses.map((classroom) => classroom.className));
      const missingClasses = requestedClassNames.filter((className) => !foundClassNames.has(className));
      if (missingClasses.length > 0) {
        throw new Error(`ClassDojo classes not found: ${missingClasses.join(", ")}.`);
      }
      const missingSourceClasses = Array.from(new Set(Object.values(classMap))).filter(
        (sourceClassName) => !sourceStudents.some((student) => student.className === sourceClassName),
      );
      if (missingSourceClasses.length > 0) {
        throw new Error(`Workbook classes not found or empty: ${missingSourceClasses.join(", ")}.`);
      }
      const preview = createRosterPreview(selectedClasses, sourceStudents, classMap, studentNameFormat);
      const verificationResults = [];
      for (const classroom of preview.classes) {
        verificationResults.push({
          classId: classroom.classId,
          className: classroom.className,
          sourceClassName: classroom.sourceClassName,
          missingSeatNumbersInWorkbook: classroom.missingSeatNumbers,
          ...verifyRoster(classroom.students, await adapter.getRoster(classroom.classId)),
        });
      }
      return jsonResult({ classes: verificationResults });
    },
  );

  server.registerTool(
    "classdojo_doctor",
    {
      title: "Check the local ClassDojo browser adapter",
      description: "Checks the local browser connection, login visibility, and available classes without writing data.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => jsonResult(await adapter.doctor()),
  );

  return server;
}
