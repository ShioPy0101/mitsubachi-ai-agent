import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
const root = process.cwd();
const storage = await mkdtemp(join(tmpdir(), "mitsubachi-d1-"));
const cli = resolve("node_modules/wrangler/bin/wrangler.js");
function run(args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0 ? done(output) : fail(new Error(output)),
    );
  });
}
const common = ["mitsubachi-ai-agent", "--local", "--persist-to", storage];
await run(["d1", "migrations", "apply", ...common]);
const tables = await run([
  "d1",
  "execute",
  ...common,
  "--command",
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  "--json",
]);
if (
  /"name"\s*:\s*"(?:stations|station_line_positions|route_segment_connections)"/.test(
    tables,
  )
)
  throw new Error("Master tables survived deletion migration");
const foreignKeys = await run([
  "d1",
  "execute",
  ...common,
  "--command",
  "PRAGMA foreign_key_check",
  "--json",
]);
if (
  JSON.parse(foreignKeys).some((r: { results: unknown[] }) => r.results.length)
)
  throw new Error("Invalid foreign keys");
// Smoke-check the local routing/bindings against the same fresh database.
const localStartupAt = Date.now();
const dev = spawn(
  process.execPath,
  [cli, "dev", "--local", "--port", "8791", "--persist-to", storage],
  { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);
let startup = "";
dev.stdout.on("data", (c) => {
  startup += c;
});
dev.stderr.on("data", (c) => {
  startup += c;
});
try {
  const limit = Date.now() + 45_000;
  let response: Response | undefined;
  while (Date.now() < limit) {
    try {
      response = await fetch("http://localhost:8791/health");
      if (response.ok) break;
    } catch {}
    await new Promise((done) => setTimeout(done, 300));
  }
  if (!response?.ok)
    throw new Error(`Local Worker failed to start: ${startup}`);
  const health = await response.json();
  const report = {
    storage,
    migrations: "0001 through 0010",
    tables: JSON.parse(tables),
    foreignKeys: JSON.parse(foreignKeys),
    health,
    localStartupMs: Date.now() - localStartupAt,
    externalAiCalled: false,
    productionDeployed: false,
  };
  await writeFile(
    "docs/benchmarks/local-verification.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  dev.kill("SIGTERM");
}
