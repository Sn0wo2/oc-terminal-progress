import type { Pointer } from "bun:ffi"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const PLUGIN_AUMID = "sn0wo2.opencode-terminal-progress"

type WindowApi = ReturnType<typeof loadWindowApi>

const asPointer = (value: Pointer | bigint | null): Pointer =>
  (typeof value === "bigint" ? Number(value) : (value ?? 0)) as Pointer

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

let windowApi: WindowApi | undefined

const windowPid = (api: WindowApi, handle: Pointer) => {
  const pid = new Uint32Array(1)
  api.user32.GetWindowThreadProcessId(handle, ptr(pid))
  return pid[0] ?? 0
}

const windowClass = (api: WindowApi, handle: Pointer) => {
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

const findVisibleWindow = (api: WindowApi, pid: number): Pointer | null => {
  let previous: Pointer | null = null
  for (;;) {
    const handle = asPointer(api.user32.FindWindowExW(null, previous, null, null))
    if (!handle) return null
    previous = handle
    if (
      api.user32.IsWindowVisible(handle) &&
      api.user32.GetWindowTextLengthW(handle) > 0 &&
      windowPid(api, handle) === pid
    )
      return handle
  }
}

/** Brings the terminal window to the foreground (Windows only; no-op elsewhere). */
export const focusTerminal = () => {
  if (process.platform !== "win32") return
  try {
    if (!windowApi) windowApi = loadWindowApi()
    const api = windowApi
    const consoleWindow = asPointer(api.kernel32.GetConsoleWindow())
    if (!consoleWindow) return
    // A real classic-console window; anything else under ConPTY is a pseudo-console
    // ghost window (visible but unfocusable on recent Windows builds), so walk up to
    // the terminal host instead.
    let window: { handle: Pointer; pid: number } | undefined
    if (windowClass(api, consoleWindow) === "ConsoleWindowClass") {
      window = { handle: consoleWindow, pid: windowPid(api, consoleWindow) }
    } else {
      let pid = windowPid(api, consoleWindow)
      for (let hop = 0; !window && hop < 2; hop++) {
        pid = parentPid(api, pid)
        const handle = pid ? findVisibleWindow(api, pid) : null
        if (handle) window = { handle, pid }
      }
    }
    if (!window) return
    if (!api.user32.IsWindow(window.handle) || windowPid(api, window.handle) !== window.pid) return
    if (api.user32.IsIconic(window.handle)) api.user32.ShowWindow(window.handle, 9)
    api.user32.keybd_event(0x12, 0, 0, 0n)
    if (!api.user32.SetForegroundWindow(window.handle)) api.user32.SwitchToThisWindow(window.handle, 1)
    api.user32.keybd_event(0x12, 0, 2, 0n)
  } catch {}
}

/** Registers the toast identity (Start Menu shortcut) if needed; returns the AUMID to use, if any. */
export const registerToastAppID = (): string | undefined => {
  if (process.platform !== "win32" || process.arch !== "x64") return undefined
  try {
    const appData = process.env.APPDATA
    const programs = appData ? join(appData, "Microsoft", "Windows", "Start Menu", "Programs") : undefined
    const shortcut = programs ? join(programs, "OpenCode Terminal Progress.lnk") : undefined
    if (shortcut && programs && !existsSync(shortcut)) {
      const snoretoast = fileURLToPath(
        new URL(
          `./vendor/snoreToast/snoretoast-${process.arch === "x64" ? "x64" : "x86"}.exe`,
          import.meta.resolve("node-notifier/package.json"),
        ),
      )
      mkdirSync(programs, { recursive: true })
      Bun.spawnSync([snoretoast, "-install", shortcut, process.execPath, PLUGIN_AUMID], {
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
    }
    return shortcut && existsSync(shortcut) ? PLUGIN_AUMID : undefined
  } catch {
    return undefined
  }
}
