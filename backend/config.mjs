import { EngineError } from "./engine-errors.mjs";

export function getBaseDir() {
  const raw = String(Bare.argv?.[0] || "").trim();
  if (!raw) {
    throw new EngineError({
      category: "internal.config",
      cause: "missing-basedir",
      message: "Invalid baseDir: argv[0] missing/empty",
    });
  }
  return raw;
}
