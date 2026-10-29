import { showDarwinToast } from "./darwin"
import { createLinuxToast } from "./linux"
import { createWindowsToast } from "./windows"

export const createSystemToast = () => {
  if (process.platform === "win32") return createWindowsToast()
  if (process.platform === "darwin") return showDarwinToast
  return createLinuxToast()
}
