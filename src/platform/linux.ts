export const createLinuxToast = () => {
  const notifySend = Bun.which("notify-send");
  return (title: string, message: string) => {
    if (notifySend)
      Bun.spawn([notifySend, title, message], {
        stdout: "ignore",
        stderr: "ignore",
      });
  };
};
