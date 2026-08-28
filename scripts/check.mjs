import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = ["chromium", "firefox"];

function manifestFiles(manifest) {
  return [
    ...(manifest.background?.scripts ?? []),
    manifest.background?.service_worker,
    ...manifest.content_scripts.flatMap(({ js = [], css = [] }) => [...js, ...css]),
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {})
  ].filter(Boolean);
}

for (const target of targets) {
  const manifest = JSON.parse(await readFile(resolve(root, "src", "manifests", `${target}.json`), "utf8"));
  if (manifest.name !== "Rewind Chat" || manifest.manifest_version !== 3) throw new Error(`${target}: manifesto inválido`);
  for (const file of manifestFiles(manifest)) {
    await access(resolve(root, "src", "common", file)).catch(() => access(resolve(root, "src", "platforms", target, file)));
  }
  if (target === "chromium" && !manifest.background?.service_worker) throw new Error("chromium: service worker ausente");
  if (target === "firefox" && !manifest.background?.scripts) throw new Error("firefox: background scripts ausente");
  console.log(`Rewind Chat: manifesto ${target} válido.`);
}
