import { existsSync } from "node:fs";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin/tui";

type ProgressState = 0 | 1 | 4;

const PLUGIN_AUMID = "sn0wo2.opencode-terminal-progress";

export default Plugin.define({
  id: "oc-terminal-progress",
  setup(context) {
    const toastEnabled = context.options.toast !== false;
    let currentSessionId: string | undefined;
    let state: ProgressState = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let lastNotifiedAt = 0;
    let shortcutReady = false;
    const seen = new Set<string>();

    if (toastEnabled && process.platform === "win32" && process.env.APPDATA) {
      const lnk = join(
        process.env.APPDATA,
        "Microsoft\\Windows\\Start Menu\\Programs\\OpenCode Terminal Progress.lnk",
      );
      shortcutReady = existsSync(lnk);
      if (!shortcutReady)
        Bun.spawn(
          [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-File",
            join(import.meta.dir, "..", "assets", "shortcut.ps1"),
          ],
          {
            env: {
              ...process.env,
              OC_TP_LNK: lnk,
              OC_TP_TARGET: process.execPath,
              OC_TP_ICON: join(import.meta.dir, "..", "assets", "icon.ico"),
              OC_TP_AUMID: PLUGIN_AUMID,
            },
            stdout: "ignore",
            stderr: "ignore",
            windowsHide: true,
          },
        );
    }

    const write = (sequence: string) => {
      const renderer = context.renderer;
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

    const setState = (next: ProgressState) => {
      if (next === state) return;
      write(`\x1b]9;4;${next}${next === 4 ? ";100" : ""}\x07`);
      state = next;
    };

    const remember = (event: { type: string; id: string }) => {
      const key = `${event.type}:${event.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      if (seen.size > 256) {
        let dropped = 0;
        for (const entry of seen) {
          seen.delete(entry);
          if (++dropped === 128) break;
        }
      }
      return true;
    };

    const sessionNotify = (sessionID: string, message: string) => {
      const session = context.data.session.get(sessionID);
      if (session?.parentID !== undefined || disposed) return;
      const now = Date.now();
      if (now - lastNotifiedAt < 1000) return;
      lastNotifiedAt = now;
      if (context.options.bell !== false) write("\x07");
      if (!toastEnabled) return;
      const title = session?.title ?? "OpenCode";
      if (process.platform === "win32")
        Bun.spawn(
          [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$text = $template.GetElementsByTagName("text")
$text.Item(0).AppendChild($template.CreateTextNode($env:OC_TERMINAL_PROGRESS_TITLE)) | Out-Null
$text.Item(1).AppendChild($template.CreateTextNode($env:OC_TERMINAL_PROGRESS_MESSAGE)) | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:OC_TERMINAL_PROGRESS_APP_ID).Show([Windows.UI.Notifications.ToastNotification]::new($template))
`,
          ],
          {
            env: {
              ...process.env,
              OC_TERMINAL_PROGRESS_APP_ID: shortcutReady
                ? PLUGIN_AUMID
                : "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe",
              OC_TERMINAL_PROGRESS_TITLE: title,
              OC_TERMINAL_PROGRESS_MESSAGE: message,
            },
            stdout: "ignore",
            stderr: "ignore",
            windowsHide: true,
          },
        );
      else if (process.platform === "darwin")
        Bun.spawn(
          [
            "osascript",
            "-e",
            `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
      else {
        const notifySend = Bun.which("notify-send");
        if (notifySend)
          Bun.spawn([notifySend, title, message], {
            stdout: "ignore",
            stderr: "ignore",
          });
      }
    };

    const update = () => {
      if (disposed) return;
      const route = context.ui.router.current();
      const sessionId = route.type === "session" ? route.sessionID : undefined;
      let next: ProgressState = 0;
      if (sessionId) {
        let waiting = false;
        for (const id of new Set([
          sessionId,
          ...context.data.session.family(sessionId),
        ])) {
          const permissions = context.data.session.permission.list(id);
          const forms = context.data.session.form.list(id);
          if (permissions === undefined)
            void context.data.session.permission.sync(id).catch(() => {});
          if (forms === undefined)
            void context.data.session.form.sync(id).catch(() => {});
          waiting ||= !!(permissions?.length || forms?.length);
        }
        next = waiting
          ? 4
          : context.data.session.status(sessionId) === "running"
            ? 1
            : 0;
      }
      if (next || sessionId !== currentSessionId) {
        currentSessionId = sessionId;
        clearTimeout(idleTimer);
        idleTimer = undefined;
        setState(next);
      } else if (state && idleTimer === undefined) {
        idleTimer = setTimeout(() => {
          idleTimer = undefined;
          setState(0);
        }, 1500);
      }
    };

    const unsubscribe = context.data.listen(({ details }) => {
      const { type } = details;
      if (type === "permission.asked") {
        if (remember(details))
          sessionNotify(
            details.data.sessionID,
            `Permission required: ${details.data.action}`,
          );
      } else if (type === "form.created") {
        if (remember(details))
          sessionNotify(
            details.data.form.sessionID,
            `Question: ${details.data.form.title}`,
          );
      } else if (type === "session.execution.succeeded") {
        if (remember(details))
          sessionNotify(details.data.sessionID, "Task completed");
      } else if (type === "session.execution.failed") {
        if (remember(details))
          sessionNotify(details.data.sessionID, "Task failed");
      }
      if (
        type.startsWith("permission.") ||
        type.startsWith("form.") ||
        type === "session.status" ||
        type === "tui.session.select"
      )
        queueMicrotask(update);
    });

    const timer = setInterval(update, 500);
    update();
    return () => {
      disposed = true;
      clearInterval(timer);
      clearTimeout(idleTimer);
      unsubscribe();
      setState(0);
    };
  },
});
