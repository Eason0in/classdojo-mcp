import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const verifier = fileURLToPath(new URL("../scripts/verify-release-asset.sh", import.meta.url));

describe("release asset verification", () => {
  test("checks only the exact asset when an SBOM has the same prefix", () => {
    const directory = mkdtempSync(join(tmpdir(), "classdojo-mcp-checksum-"));
    const assetName = "mcp-publisher_linux_amd64.tar.gz";
    const asset = Buffer.from("publisher archive");
    const checksum = createHash("sha256").update(asset).digest("hex");

    writeFileSync(join(directory, assetName), asset);
    writeFileSync(
      join(directory, "checksums.txt"),
      `${checksum}  ${assetName}\n${"0".repeat(64)}  ${assetName}.sbom.json\n`,
    );

    const result = spawnSync("bash", [verifier, "checksums.txt", assetName], {
      cwd: directory,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${assetName}: OK`);
  });
});
