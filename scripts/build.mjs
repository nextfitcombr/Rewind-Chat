import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supportedTargets = ["chromium", "firefox"];
const requestedTarget = process.argv[2];
const targets = requestedTarget ? [requestedTarget] : supportedTargets;

for (const target of targets) {
  if (!supportedTargets.includes(target)) throw new Error(`Navegador inválido: ${target}`);
  const output = resolve(root, "dist", target);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(resolve(root, "src", "common"), output, { recursive: true });
  await cp(resolve(root, "src", "platforms", target), output, { recursive: true });
  const manifest = await readFile(resolve(root, "src", "manifests", `${target}.json`), "utf8");
  await writeFile(resolve(output, "manifest.json"), manifest);
  console.log(`Rewind Chat: dist/${target} gerado.`);
}
