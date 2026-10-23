import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { stripVTControlCharacters } from "node:util";
import type { CliRenderer } from "@opentui/core";

let notificationDatabase: Database | undefined;

export const claimNotification = (
  eventID: string,
  channel: "toast" | "bell" | "osc",
) => {
  try {
    let database = notificationDatabase;
    if (!database) {
      const directory = join(
        process.env.XDG_CACHE_HOME ??
          process.env.LOCALAPPDATA ??
          join(homedir(), ".cache"),
        "oc-terminal-progress",
      );
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      database = new Database(join(directory, "notifications.sqlite"));
      database.exec(`
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS notification_claims (
          event_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          expires INTEGER NOT NULL,
          PRIMARY KEY (event_id, channel)
        );
      `);
      notificationDatabase = database;
    }

    const now = Date.now();
    const { changes } = database
      .query(
        `INSERT INTO notification_claims VALUES (?, ?, ?)
         ON CONFLICT(event_id, channel) DO UPDATE SET expires = excluded.expires
         WHERE notification_claims.expires <= ?`,
      )
      .run(eventID, channel, now + 24 * 60 * 60 * 1000, now);
    if (changes)
      database
        .query("DELETE FROM notification_claims WHERE expires <= ?")
        .run(now);
    return changes > 0;
  } catch {
    return true;
  }
};

export const writeTerminal = (renderer: CliRenderer, sequence: string) => {
  const captured =
    renderer.screenMode === "split-footer" &&
    renderer.externalOutputMode === "capture-stdout";
  if (captured) renderer.externalOutputMode = "passthrough";
  process.stdout.write(
    process.env.TMUX
      ? `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`
      : process.env.STY
        ? `\x1bP${sequence}\x1b\\`
        : sequence,
  );
  if (captured) renderer.externalOutputMode = "capture-stdout";
};

export const normalizeText = (text: string, limit: number) => {
  const value = stripVTControlCharacters(text)
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
  return value.length > limit
    ? `${value.slice(0, limit - 1).trimEnd()}…`
    : value;
};
