import { showDarwinToast } from "./darwin"
import { createLinuxToast } from "./linux"
import { createWindowsToast } from "./windows"

export type SystemToast = ((title: string, message: string, sessionID?: string) => void) & {
  readonly dispose?: () => void
}

export const createSystemToast = (onActivate?: (sessionID: string) => void): SystemToast => {
  if (process.platform === "win32") return createWindowsToast(onActivate)
  if (process.platform === "darwin") return showDarwinToast
  return createLinuxToast()
}
