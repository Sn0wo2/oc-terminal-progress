import { existsSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_AUMID = "sn0wo2.opencode-terminal-progress";
const silentWindowsSpawnOptions = {
  stdout: "ignore",
  stderr: "ignore",
  windowsHide: true,
} as const;

export const createWindowsToast = () => {
  const appData = process.env.APPDATA;
  const shortcut = appData
    ? join(
        appData,
        "Microsoft\\Windows\\Start Menu\\Programs\\OpenCode Terminal Progress.lnk",
      )
    : undefined;
  let shortcutReady = shortcut !== undefined && existsSync(shortcut);

  if (shortcut && !shortcutReady)
    Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        join(import.meta.dir, "..", "..", "assets", "shortcut.ps1"),
      ],
      {
        env: {
          ...process.env,
          OC_TP_LNK: shortcut,
          OC_TP_TARGET: process.execPath,
          OC_TP_ICON: join(import.meta.dir, "..", "..", "assets", "icon.ico"),
          OC_TP_AUMID: PLUGIN_AUMID,
        },
        ...silentWindowsSpawnOptions,
      },
    );

  return (title: string, message: string) => {
    if (!shortcutReady && shortcut && existsSync(shortcut))
      shortcutReady = true;
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
        ...silentWindowsSpawnOptions,
      },
    );
  };
};
