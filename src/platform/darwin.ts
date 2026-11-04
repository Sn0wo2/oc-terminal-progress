export const showDarwinToast = (title: string, message: string, _sessionID?: string) => {
  Bun.spawn(
    ["osascript", "-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
    { stdout: "ignore", stderr: "ignore" },
  )
}
