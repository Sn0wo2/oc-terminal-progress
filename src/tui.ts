import { Plugin } from "@opencode/plugin/tui";

type ProgressState = 0 | 1 | 4;

export default Plugin.define({
  id: "oc-terminal-progress",
  setup(context) {
    let currentSessionId: string | undefined;
    let state: ProgressState = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const setState = (next: ProgressState) => {
      if (next === state) return;
      const renderer = context.renderer;
      const captured =
        renderer.screenMode === "split-footer" &&
        renderer.externalOutputMode === "capture-stdout";
      if (captured) renderer.externalOutputMode = "passthrough";
      const sequence = `\x1b]9;4;${next}${next === 4 ? ";100" : ""}\x07`;
      process.stdout.write(
        process.env.TMUX
          ? `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`
          : process.env.STY
            ? `\x1bP${sequence}\x1b\\`
            : sequence,
      );
      if (captured) renderer.externalOutputMode = "capture-stdout";
      state = next;
    };

    const update = () => {
      if (disposed) return;
      const route = context.ui.router.current();
      const sessionId = route.type === "session" ? route.sessionID : undefined;
      const changed = sessionId !== currentSessionId;
      currentSessionId = sessionId;
      let next: ProgressState = 0;
      if (sessionId) {
        const ids = new Set([
          sessionId,
          ...context.data.session.family(sessionId),
        ]);
        let waiting = false;
        for (const id of ids) {
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
      if (next || changed) {
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
      const type = details.type;
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
