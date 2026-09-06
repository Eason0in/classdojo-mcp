import { readFile } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import type { ClassDojoBrowserAdapter } from "../src/browser.js";
import type { SkillRule } from "../src/skills.js";
import { createClassDojoServer, promptNames, toolNames } from "../src/server.js";

const adapter: ClassDojoBrowserAdapter = {
  listClasses: async () => [],
  getRoster: async () => [],
  getSkills: async () => [],
  getUiState: async () => "ready",
  pasteStudents: async () => undefined,
  replaceSkills: async () => undefined,
  doctor: async () => ({ status: "ready", classCount: 0, classes: [] }),
};

describe("MCP tool definitions", () => {
  it("exposes the portable V1 roster tools", () => {
    expect(toolNames).toEqual([
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
    ]);
  });

  it("exposes a guided configuration prompt with the built-in rules", async () => {
    const server = createClassDojoServer({ adapter });
    const client = new Client({ name: "prompt-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listPrompts();
    expect(promptNames).toEqual(["classdojo_configure_skill_rules"]);
    expect(listed.prompts.map((prompt) => prompt.name)).toEqual(promptNames);
    const prompt = await client.getPrompt({ name: "classdojo_configure_skill_rules" });
    expect(prompt.messages[0].content).toMatchObject({
      type: "text",
      text: expect.stringContaining("traditional_chinese_classroom_v1"),
    });
    expect(prompt.messages[0].content).toMatchObject({ text: expect.stringContaining("全班準時上課 +2") });
    expect(prompt.messages[0].content).toMatchObject({ text: expect.stringContaining("Ask the user") });

    await client.close();
    await server.close();
  });

  it("lists JSON schemas and annotations through a standard MCP client", async () => {
    const server = createClassDojoServer({ adapter });
    const client = new Client({ name: "compatibility-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name)).toEqual(toolNames);
    expect(result.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
    expect(result.tools.find((tool) => tool.name === "classdojo_apply_roster_import")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(
      result.tools.find((tool) => tool.name === "classdojo_apply_roster_import")?.inputSchema.required,
    ).toEqual(expect.arrayContaining(["previewId", "confirm"]));
    expect(
      result.tools.find((tool) => tool.name === "classdojo_preview_roster_import")?.inputSchema.required,
    ).toEqual(expect.arrayContaining(["workbookPath", "sheetNames", "studentNameFormat", "mappings"]));
    expect(result.tools.find((tool) => tool.name === "classdojo_apply_skill_sync")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(
      result.tools.find((tool) => tool.name === "classdojo_preview_skill_sync")?.inputSchema.required,
    ).toEqual(expect.arrayContaining(["rulesSource", "targetClassNames"]));

    const duplicateSourceMapping = await client.callTool({
      name: "classdojo_preview_roster_import",
      arguments: {
        workbookPath: "/synthetic/not-read.xlsx",
        sheetNames: ["Grade 5"],
        studentNameFormat: "seat_number_dot_name",
        mappings: [
          { classdojoClassName: "503", sourceClassName: "Grade 5 Class 3" },
          { classdojoClassName: "504", sourceClassName: "Grade 5 Class 3" },
        ],
      },
    });
    expect(duplicateSourceMapping.isError).toBe(true);
    expect(duplicateSourceMapping.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("Each workbook source class may appear only once") }),
    ]));

    await client.close();
    await server.close();
  });

  it("keeps npm and MCP Registry metadata aligned", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      name: string;
      version: string;
      mcpName: string;
    };
    const serverJson = JSON.parse(await readFile(new URL("../server.json", import.meta.url), "utf8")) as {
      name: string;
      version: string;
      packages: Array<{ identifier: string; version: string; transport: { type: string } }>;
    };

    expect(serverJson.name).toBe(packageJson.mcpName);
    expect(serverJson.version).toBe(packageJson.version);
    expect(serverJson.packages).toContainEqual(
      expect.objectContaining({
        identifier: packageJson.name,
        version: packageJson.version,
        transport: { type: "stdio" },
      }),
    );
  });
});

describe("skill synchronization tools", () => {
  it("previews inline changes, applies them with confirmation, and verifies the saved rules", async () => {
    const existing: SkillRule[] = [{ category: "positive", name: "努力", points: 1, iconId: 13 }];
    const state: Record<string, SkillRule[]> = { "class-502": existing };
    const skillAdapter: ClassDojoBrowserAdapter = {
      ...adapter,
      listClasses: async () => [{ classId: "class-502", className: "502" }],
      getSkills: async (classId) => state[classId],
      replaceSkills: async (classId, _expectedSkills, skills) => { state[classId] = skills; },
    };
    const server = createClassDojoServer({ adapter: skillAdapter });
    const client = new Client({ name: "skill-sync-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const rulesSource = {
      type: "inline",
      skills: [{ category: "positive", name: "努力", points: 2 }],
    };
    const previewResult = await client.callTool({
      name: "classdojo_preview_skill_sync",
      arguments: { rulesSource, targetClassNames: ["502"] },
    });
    const preview = JSON.parse((previewResult.content[0] as { text: string }).text) as {
      previewId: string;
      desiredSkills: SkillRule[];
      classes: Array<{ diff: { matches: boolean } }>;
    };
    expect(preview.desiredSkills).toEqual([{ category: "positive", name: "努力", points: 2, iconId: 13 }]);
    expect(preview.classes[0].diff.matches).toBe(false);

    const applyResult = await client.callTool({
      name: "classdojo_apply_skill_sync",
      arguments: { previewId: preview.previewId, confirm: true },
    });
    expect(JSON.parse((applyResult.content[0] as { text: string }).text)).toMatchObject({
      status: "completed",
      verifiedClassNames: ["502"],
      classes: [{ className: "502", status: "updated" }],
    });

    const verifyResult = await client.callTool({
      name: "classdojo_verify_skill_sync",
      arguments: { rulesSource, targetClassNames: ["502"] },
    });
    expect(JSON.parse((verifyResult.content[0] as { text: string }).text)).toMatchObject({
      classes: [{ className: "502", matches: true, added: [], updated: [], removed: [] }],
    });

    await client.close();
    await server.close();
  });

  it("rejects duplicate target classes before creating a preview", async () => {
    const skillAdapter: ClassDojoBrowserAdapter = {
      ...adapter,
      listClasses: async () => [{ classId: "class-502", className: "502" }],
    };
    const server = createClassDojoServer({ adapter: skillAdapter });
    const client = new Client({ name: "duplicate-target-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "classdojo_preview_skill_sync",
      arguments: {
        rulesSource: { type: "preset", presetId: "traditional_chinese_classroom_v1" },
        targetClassNames: ["502", "502"],
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("Each target ClassDojo class may appear only once") }),
    ]));

    await client.close();
    await server.close();
  });
});
