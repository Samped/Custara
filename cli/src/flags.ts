export type Flags = Record<string, string | boolean>;

export function parseFlags(argv: string[]) {
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const eq = key.indexOf("=");
    if (eq >= 0) {
      flags[key.slice(0, eq)] = key.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return { positionals, flags };
}

export function flagString(flags: Flags, name: string) {
  const value = flags[name];
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim();
}

export function wantsJson(flags: Flags) {
  return flags.json === true || flags.json === "true";
}
