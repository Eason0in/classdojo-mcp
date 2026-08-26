import { readFile } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import type { ClassDojoBrowserAdapter } from "../src/browser.js";
import { createClassDojoServer, toolNames } from "../src/server.js";

const adapter: ClassDojoBrowserAdapter = {
  listClasses: async () => [],
  getRoster: async () => [],
  getUiState: async () => "ready",
  pasteStudents: async () => undefined,
  doctor: async () => ({ status: "ready", classCount: 0, classes: [] }),
};

describe("MCP tool definitions", () => {
  it("exposes the portable V1 roster tools", () => {
    expect(toolNames).toEqual([
      "classdojo_list_classes",
      "classdojo_inspect_workbook",
      "classdojo_get_roster",
      "classdojo_get_ui_state",
      "classdojo_preview_roster_import",
      "classdojo_apply_roster_import",
      "classdojo_verify_roster_against_workbook",
      "classdojo_doctor",
    ]);
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
