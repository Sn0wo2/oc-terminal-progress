import { dlopen, FFIType, ptr } from "bun:ffi"
import { existsSync } from "node:fs"
import { join } from "node:path"

const PLUGIN_AUMID = "sn0wo2.opencode-terminal-progress"
const TOAST_PROTOCOL = "octp"
const silentWindowsSpawnOptions = {
  stdout: "ignore",
  stderr: "ignore",
  windowsHide: true,
} as const

type WindowApi = ReturnType<typeof loadWindowApi>
type FFIPointer = number & { readonly __pointer__: null }
type TerminalWindow = { readonly handle: FFIPointer; readonly pid: number }

const asPointer = (value: unknown): FFIPointer =>
  (typeof value === "bigint" ? Number(value) : (value ?? 0)) as FFIPointer

const loadWindowApi = () => {
  const user32 = dlopen("user32.dll", {
    FindWindowExW: {
      args: [FFIType.pointer, FFIType.pointer, FFIType.pointer, FFIType.pointer],
      returns: FFIType.pointer,
    },
    GetWindowThreadProcessId: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.u32 },
    GetWindowTextLengthW: { args: [FFIType.pointer], returns: FFIType.i32 },
    GetClassNameW: { args: [FFIType.pointer, FFIType.pointer, FFIType.i32], returns: FFIType.i32 },
    IsWindow: { args: [FFIType.pointer], returns: FFIType.i32 },
    IsWindowVisible: { args: [FFIType.pointer], returns: FFIType.i32 },
    IsIconic: { args: [FFIType.pointer], returns: FFIType.i32 },
    ShowWindow: { args: [FFIType.pointer, FFIType.i32], returns: FFIType.i32 },
    SetForegroundWindow: { args: [FFIType.pointer], returns: FFIType.i32 },
    SwitchToThisWindow: { args: [FFIType.pointer, FFIType.i32], returns: FFIType.void },
    keybd_event: { args: [FFIType.u8, FFIType.u8, FFIType.u32, FFIType.u64], returns: FFIType.void },
  })
  const kernel32 = dlopen("kernel32.dll", {
    GetConsoleWindow: { args: [], returns: FFIType.pointer },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.pointer },
    CloseHandle: { args: [FFIType.pointer], returns: FFIType.i32 },
  })
  const ntdll = dlopen("ntdll.dll", {
    NtQueryInformationProcess: {
      args: [FFIType.pointer, FFIType.u32, FFIType.pointer, FFIType.u32, FFIType.pointer],
      returns: FFIType.i32,
    },
  })
  return { user32: user32.symbols, kernel32: kernel32.symbols, ntdll: ntdll.symbols }
}

const windowPid = (api: WindowApi, handle: FFIPointer) => {
  const pid = new Uint32Array(1)
  api.user32.GetWindowThreadProcessId(handle, ptr(pid))
  return pid[0] ?? 0
}

const windowClass = (api: WindowApi, handle: FFIPointer) => {
  const buffer = new Uint16Array(64)
  const length = api.user32.GetClassNameW(handle, ptr(buffer), 64)
  return new TextDecoder("utf-16le").decode(buffer.slice(0, Math.max(length, 0)))
}

const parentPid = (api: WindowApi, pid: number): number => {
  const process = api.kernel32.OpenProcess(0x10_00, 0, pid)
  if (!process) return 0
  try {
    const info = new BigUint64Array(6)
    if (api.ntdll.NtQueryInformationProcess(process, 0, ptr(info), info.byteLength, null) !== 0) return 0
    return Number(info[5] ?? 0n)
  } finally {
    api.kernel32.CloseHandle(process)
  }
}

const findVisibleWindow = (api: WindowApi, pid: number): FFIPointer => {
  let previous: FFIPointer | null = null
  for (;;) {
    const handle = asPointer(api.user32.FindWindowExW(null, previous, null, null))
    if (!handle) return handle
    previous = handle
    if (
      api.user32.IsWindowVisible(handle) &&
      api.user32.GetWindowTextLengthW(handle) > 0 &&
      windowPid(api, handle) === pid
    )
      return handle
  }
}

const resolveTerminalWindow = (api: WindowApi): TerminalWindow | undefined => {
  try {
    const consoleWindow = asPointer(api.kernel32.GetConsoleWindow())
    if (!consoleWindow) return undefined
    // A real classic-console window; anything else under ConPTY is a pseudo-console
    // ghost window (visible but unfocusable on recent Windows builds), so walk up to
    // the terminal host instead.
    if (windowClass(api, consoleWindow) === "ConsoleWindowClass")
      return { handle: consoleWindow, pid: windowPid(api, consoleWindow) }
    let pid = windowPid(api, consoleWindow)
    for (let hop = 0; hop < 2; hop++) {
      pid = parentPid(api, pid)
      if (!pid) return undefined
      const handle = findVisibleWindow(api, pid)
      if (handle) return { handle, pid }
    }
    return undefined
  } catch {
    return undefined
  }
}

const focusTerminalWindow = (api: WindowApi, window: TerminalWindow) => {
  try {
    if (!api.user32.IsWindow(window.handle) || windowPid(api, window.handle) !== window.pid) return
    if (api.user32.IsIconic(window.handle)) api.user32.ShowWindow(window.handle, 9)
    api.user32.keybd_event(0x12, 0, 0, 0n)
    if (!api.user32.SetForegroundWindow(window.handle)) api.user32.SwitchToThisWindow(window.handle, 1)
    api.user32.keybd_event(0x12, 0, 2, 0n)
  } catch {}
}

const isProtocolRegistered = (): boolean => {
  try {
    return (
      Bun.spawnSync(["reg.exe", "query", `HKCU\\Software\\Classes\\${TOAST_PROTOCOL}\\shell\\open\\command`, "/ve"], {
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      }).exitCode === 0
    )
  } catch {
    return true
  }
}

export const createWindowsToast = (onActivate?: (sessionID: string) => void) => {
  const appData = process.env["APPDATA"]
  const shortcut = appData
    ? join(appData, "Microsoft\\Windows\\Start Menu\\Programs\\OpenCode Terminal Progress.lnk")
    : undefined
  let shortcutReady = shortcut !== undefined && existsSync(shortcut)
  let api: WindowApi | undefined
  try {
    api = loadWindowApi()
  } catch {
    api = undefined
  }
  const window = api ? resolveTerminalWindow(api) : undefined
  const token = crypto.randomUUID()
  let server: ReturnType<typeof Bun.serve> | undefined
  if (onActivate) {
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          const url = new URL(request.url)
          if (url.pathname !== "/click" || url.searchParams.get("t") !== token)
            return new Response(null, { status: 404 })
          if (api && window) focusTerminalWindow(api, window)
          const sessionID = url.searchParams.get("s")
          if (sessionID) onActivate(sessionID)
          return new Response(null, { status: 204 })
        },
      })
      server.unref()
    } catch {
      server = undefined
    }
  }

  if ((shortcut && !shortcutReady) || !isProtocolRegistered())
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
          ...(shortcut ? { OC_TP_LNK: shortcut } : {}),
          OC_TP_TARGET: process.execPath,
          OC_TP_ICON: join(import.meta.dir, "..", "..", "assets", "icon.ico"),
          OC_TP_AUMID: PLUGIN_AUMID,
        },
        ...silentWindowsSpawnOptions,
      },
    )

  const toast = (title: string, message: string, sessionID?: string) => {
    if (!shortcutReady && shortcut && existsSync(shortcut)) shortcutReady = true
    const launch = server
      ? `${TOAST_PROTOCOL}://click?p=${server.port}&t=${token}${sessionID ? `&s=${encodeURIComponent(sessionID)}` : ""}`
      : undefined
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
if ($env:OC_TP_LAUNCH) {
  $template.DocumentElement.SetAttribute("launch", $env:OC_TP_LAUNCH)
  $template.DocumentElement.SetAttribute("activationType", "protocol")
}
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:OC_TERMINAL_PROGRESS_APP_ID).Show([Windows.UI.Notifications.ToastNotification]::new($template))
`,
      ],
      {
        env: {
          ...process.env,
          ...(launch ? { OC_TP_LAUNCH: launch } : {}),
          OC_TERMINAL_PROGRESS_APP_ID: shortcutReady
            ? PLUGIN_AUMID
            : "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe",
          OC_TERMINAL_PROGRESS_TITLE: title,
          OC_TERMINAL_PROGRESS_MESSAGE: message,
        },
        ...silentWindowsSpawnOptions,
      },
    )
  }
  toast.dispose = () => {
    void server?.stop(true)
  }
  return toast
}
