import { readFileSync, writeFileSync } from "fs";

/**
 * X's OAuth2 access tokens expire in ~2h, and the refresh token itself
 * rotates (single-use) on every refresh call. OpenClaw's MCP config bakes
 * --env values in statically at `mcp add` time, so a normal env-var
 * credential can't survive a single refresh. Instead this server owns the
 * credentials file directly - reads it fresh on every use, writes the new
 * access/refresh token pair straight back after every refresh, and leaves
 * every other line (comments, the OAuth1 keys) untouched.
 */
export class CredentialsStore {
  constructor(private readonly path: string) {}

  private readAll(): string[] {
    return readFileSync(this.path, "utf-8").split("\n");
  }

  private writeAll(lines: string[]): void {
    writeFileSync(this.path, lines.join("\n"), { mode: 0o600 });
  }

  get(key: string): string {
    const lines = this.readAll();
    const line = lines.find((l) => l.startsWith(`${key}=`));
    if (!line) throw new Error(`Missing ${key} in credentials file`);
    return line.slice(key.length + 1).trim();
  }

  setMany(values: Record<string, string>): void {
    let lines = this.readAll();
    for (const [key, value] of Object.entries(values)) {
      const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
      const newLine = `${key}=${value}`;
      if (idx >= 0) {
        lines[idx] = newLine;
      } else {
        lines.push(newLine);
      }
    }
    this.writeAll(lines);
  }
}
