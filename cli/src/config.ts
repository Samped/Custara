import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CustaraConfig = {
  baseUrl: string;
  apiKey?: string;
  userToken?: string;
  email?: string;
};

export function defaultConfigPath() {
  return join(homedir(), ".custara", "config.json");
}

export function emptyConfig(): CustaraConfig {
  return { baseUrl: "https://custara.xyz" };
}

export async function loadConfig(path = defaultConfigPath()): Promise<CustaraConfig> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<CustaraConfig>;
    return {
      baseUrl: (parsed.baseUrl || "https://custara.xyz").replace(/\/$/, ""),
      apiKey: parsed.apiKey,
      userToken: parsed.userToken,
      email: parsed.email,
    };
  } catch {
    return emptyConfig();
  }
}

export async function saveConfig(config: CustaraConfig, path = defaultConfigPath()) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function resolveRuntime(
  config: CustaraConfig,
  env: Record<string, string | undefined> = process.env,
) {
  const baseUrl = (env.CUSTARA_URL || config.baseUrl || "https://custara.xyz").replace(/\/$/, "");
  const apiKey = env.CUSTARA_API_KEY || config.apiKey || "";
  const userToken = env.CUSTARA_TOKEN || config.userToken || "";
  const stepUp = env.CUSTARA_STEP_UP || "";
  return { baseUrl, apiKey, userToken, stepUp, email: config.email };
}
