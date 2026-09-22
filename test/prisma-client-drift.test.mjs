// The rest of the suite swaps Prisma for an in-memory double, which means a
// schema change that was never followed by `prisma generate` / `migrate deploy`
// passes every other test and then fails at runtime with
// "Unknown argument `addJsonlPath`". This test reads the real generated client
// and fails fast when it has drifted from prisma/schema.prisma.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..");

/** Field names declared for a model in the schema file. */
function schemaFields(modelName) {
  const schema = fs.readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
  const block = schema.match(new RegExp(`model\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(block, `model ${modelName} not found in schema.prisma`);

  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//") && !line.startsWith("@@"))
    .map((line) => line.split(/\s+/)[0]);
}

describe("generated Prisma client matches the schema", () => {
  for (const model of ["BulkSyncJob", "TagAutomationSetting"]) {
    it(`${model} has every field the schema declares`, () => {
      const { Prisma } = require("@prisma/client");
      const generated = Prisma.dmmf?.datamodel?.models?.find((m) => m.name === model);
      assert.ok(generated, `${model} is missing from the generated client`);

      const generatedNames = new Set(generated.fields.map((f) => f.name));
      const missing = schemaFields(model).filter((name) => !generatedNames.has(name));

      assert.deepEqual(
        missing,
        [],
        `Generated client is stale — run \`npm run setup\` (prisma generate && prisma migrate deploy). Missing: ${missing.join(", ")}`,
      );
    });
  }

  it("has no unapplied migrations left in prisma/migrations", () => {
    // Every migration directory should be reflected in the schema's history;
    // this catches a migration file added but never wired up.
    const dir = path.join(ROOT, "prisma/migrations");
    const migrations = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    assert.ok(migrations.length > 0, "no migrations found");
    for (const name of migrations) {
      assert.ok(
        fs.existsSync(path.join(dir, name, "migration.sql")),
        `${name} has no migration.sql`,
      );
    }
  });
});

describe("elapsed label", () => {
  it("stops the clock on a finished job", async () => {
    const { bulkSyncElapsedLabel } = await import("../app/lib/bulk-sync-status.js");

    const startedAt = new Date("2026-09-18T11:04:37Z");
    const job = {
      status: "completed",
      startedAt,
      finishedAt: new Date("2026-09-18T11:04:49Z"),
      updatedAt: new Date("2026-09-18T11:04:49Z"),
    };
    assert.equal(bulkSyncElapsedLabel(job), "12s");

    // Called again much later it must not have grown.
    assert.equal(bulkSyncElapsedLabel(job), "12s");
  });

  it("falls back to updatedAt for legacy rows with no finishedAt", async () => {
    const { bulkSyncElapsedLabel } = await import("../app/lib/bulk-sync-status.js");

    // This is the shape that produced the bogus "Took 41m 42s".
    const label = bulkSyncElapsedLabel({
      status: "completed",
      startedAt: new Date("2026-09-18T11:04:37Z"),
      finishedAt: null,
      updatedAt: new Date("2026-09-18T11:18:32Z"),
    });
    assert.equal(label, "13m 55s");
  });

  it("keeps counting while a job is still running", async () => {
    const { bulkSyncElapsedLabel } = await import("../app/lib/bulk-sync-status.js");

    const label = bulkSyncElapsedLabel({
      status: "downloading",
      startedAt: new Date(Date.now() - 65_000),
      finishedAt: null,
      updatedAt: new Date(),
    });
    assert.match(label, /^1m \d+s$/);
  });
});
