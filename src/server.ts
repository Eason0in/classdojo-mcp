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
import {
  DEFAULT_SKILL_PRESET,
  DEFAULT_SKILL_PRESET_ID,
  applySkillSync,
  createSkillSyncPreview,
  diffSkills,
  normalizeSkillRules,
  type SkillRule,
  type SkillRuleInput,
  type SkillSource,
  type SkillSyncPreview,
} from "./skills.js";
import { inspectWorkbook, readSourceStudentsFromWorkbook } from "./xlsx.js";

export const toolNames = [
  "classdojo_list_classes",
  "classdojo_inspect_workbook",
  "classdojo_get_roster",
  "classdojo_get_skills",
  "classdojo_get_ui_state",
  "classdojo_preview_roster_import",
  "classdojo_apply_roster_import",
  "classdojo_verify_roster_against_workbook",
  "classdojo_preview_skill_sync",
  "classdojo_apply_skill_sync",
  "classdojo_verify_skill_sync",
  "classdojo_doctor",
] as const;

export const promptNames = ["classdojo_configure_skill_rules"] as const;

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
export const SERVER_VERSION = "0.2.0";

const skillRuleInputSchema = z.object({
  category: z.enum(["positive", "needs_work"]),
  name: z.string().min(1),
  points: z.number().int(),
  iconId: z.number().int().min(1).max(76).optional(),
});

const rulesSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("preset"), presetId: z.literal(DEFAULT_SKILL_PRESET_ID) }),
  z.object({ type: z.literal("class"), className: z.string().regex(/^\d{3}$/) }),
  z.object({ type: z.literal("inline"), skills: z.array(skillRuleInputSchema).min(1) }),
]);

type RulesSourceInput = z.infer<typeof rulesSourceSchema>;

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function skillPromptText(): string {
  const rules = DEFAULT_SKILL_PRESET.map((rule) =>
    `- ${rule.category === "positive" ? "Positive" : "Needs work"}: ${rule.name} ${rule.points > 0 ? "+" : ""}${rule.points} (icon ${rule.iconId})`
  ).join("\n");
  return [
    `Use the built-in ${DEFAULT_SKILL_PRESET_ID} ClassDojo skill preset:`,
    rules,
    "Ask the user which three-digit classes to update and whether they want to add, remove, rename, or change any default rule.",
    "Show the complete final rule list before calling classdojo_preview_skill_sync.",
    "After the preview, ask for explicit approval. Only then call classdojo_apply_skill_sync with confirm: true, followed by classdojo_verify_skill_sync.",
  ].join("\n\n");
}

export function createClassDojoServer(dependencies: ServerDependencies = {}): McpServer {
  const adapter = dependencies.adapter ?? new CdpClassDojoAdapter();
  const readWorkbook = dependencies.readWorkbook ?? readSourceStudentsFromWorkbook;
  const previews = new Map<string, { preview: RosterPreview; expiresAt: number }>();
  const skillPreviews = new Map<string, { preview: SkillSyncPreview; expiresAt: number }>();
  const writes = new AsyncOperationQueue();
  const server = new McpServer({ name: "classdojo-mcp", version: SERVER_VERSION });

  async function resolveSkillSource(rulesSource: RulesSourceInput): Promise<{
    source: SkillSource;
    desiredSkills: SkillRule[];
  }> {
    if (rulesSource.type === "preset") {
      return { source: rulesSource, desiredSkills: DEFAULT_SKILL_PRESET };
    }
    if (rulesSource.type === "inline") {
      return { source: { type: "inline" }, desiredSkills: normalizeSkillRules(rulesSource.skills as SkillRuleInput[]) };
    }

    const sourceClass = (await adapter.listClasses()).find((classroom) => classroom.className === rulesSource.className);
    if (!sourceClass) throw new Error(`ClassDojo source class not found: ${rulesSource.className}.`);
    return {
      source: rulesSource,
      desiredSkills: normalizeSkillRules(await adapter.getSkills(sourceClass.classId)),
    };
  }

  async function resolveTargetClasses(targetClassNames: string[]) {
    if (new Set(targetClassNames).size !== targetClassNames.length) {
      throw new Error("Each target ClassDojo class may appear only once.");
    }
    const classes = await adapter.listClasses();
    const selectedClasses = targetClassNames.map((className) => classes.find((classroom) => classroom.className === className));
    const missingClasses = targetClassNames.filter((_, index) => !selectedClasses[index]);
    if (missingClasses.length > 0) throw new Error(`ClassDojo classes not found: ${missingClasses.join(", ")}.`);
    return selectedClasses.filter((classroom) => classroom !== undefined);
  }

  server.registerPrompt(
    "classdojo_configure_skill_rules",
    {
      title: "Configure and synchronize ClassDojo skills",
      description: "Guides a review-first workflow for the built-in Traditional Chinese classroom skill preset.",
    },
    async () => ({
      description: "Review, preview, confirm, apply, and verify ClassDojo classroom skills.",
      messages: [{ role: "user", content: { type: "text", text: skillPromptText() } }],
    }),
  );

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
    "classdojo_get_skills",
    {
      title: "Get ClassDojo skills",
      description: "Reads positive and needs-work skills, including points and icons, without changing ClassDojo data.",
      inputSchema: { classId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ classId }) => jsonResult({ classId, skills: await adapter.getSkills(classId) }),
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
    "classdojo_preview_skill_sync",
    {
      title: "Preview exact ClassDojo skill synchronization",
      description: "Compares a preset, source class, or inline rule list with target classes before any skill is changed.",
      inputSchema: {
        rulesSource: rulesSourceSchema,
        targetClassNames: z.array(z.string().regex(/^\d{3}$/)).min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ rulesSource, targetClassNames }) => {
      const [{ source, desiredSkills }, classes] = await Promise.all([
        resolveSkillSource(rulesSource as RulesSourceInput),
        resolveTargetClasses(targetClassNames),
      ]);
      const existingByClassId: Record<string, SkillRule[]> = {};
      for (const classroom of classes) existingByClassId[classroom.classId] = await adapter.getSkills(classroom.classId);
      const preview = createSkillSyncPreview(classes, desiredSkills, existingByClassId, source);
      const previewId = randomUUID();
      const expiresAt = Date.now() + PREVIEW_TTL_MS;
      skillPreviews.set(previewId, { preview, expiresAt });
      return jsonResult({ previewId, expiresAt: new Date(expiresAt).toISOString(), ...preview });
    },
  );

  server.registerTool(
    "classdojo_apply_skill_sync",
    {
      title: "Apply a previously previewed ClassDojo skill synchronization",
      description: "Exactly replaces target skills only after explicit confirmation, then reads every class back.",
      inputSchema: { previewId: z.string().uuid(), confirm: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ previewId, confirm }) => {
      const storedPreview = skillPreviews.get(previewId);
      if (!storedPreview) throw new Error("Preview not found. Run classdojo_preview_skill_sync again.");
      skillPreviews.delete(previewId);
      if (storedPreview.expiresAt <= Date.now()) {
        throw new Error("Preview expired. Run classdojo_preview_skill_sync again.");
      }
      return writes.run(async () => jsonResult(await applySkillSync(adapter, storedPreview.preview, confirm)));
    },
  );

  server.registerTool(
    "classdojo_verify_skill_sync",
    {
      title: "Verify ClassDojo skills",
      description: "Compares current target skills with a preset, source class, or inline rule list without changing data.",
      inputSchema: {
        rulesSource: rulesSourceSchema,
        targetClassNames: z.array(z.string().regex(/^\d{3}$/)).min(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ rulesSource, targetClassNames }) => {
      const [{ source, desiredSkills }, classes] = await Promise.all([
        resolveSkillSource(rulesSource as RulesSourceInput),
        resolveTargetClasses(targetClassNames),
      ]);
      const results = [];
      for (const classroom of classes) {
        const actualSkills = await adapter.getSkills(classroom.classId);
        results.push({ ...classroom, ...diffSkills(actualSkills, desiredSkills), actualSkills });
      }
      return jsonResult({ source, desiredSkills, classes: results });
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
