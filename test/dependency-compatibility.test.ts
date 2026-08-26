import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));

describe("runtime dependency compatibility", () => {
  test("requires an MCP SDK release that supports Zod 4", () => {
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      dependencies: Record<string, string>;
    };

    expect(manifest.dependencies.zod).toBe("^4.4.3");
    expect(manifest.dependencies["@modelcontextprotocol/sdk"]).toBe("^1.30.0");
  });
});
