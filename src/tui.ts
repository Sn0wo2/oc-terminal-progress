import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin/tui"
import notifier from "node-notifier"
import { focusTerminal, registerToastAppID } from "./platform"
import { claimNotification, normalizeText, writeTerminal } from "./utils"

export default Plugin.define({
  id: "oc-terminal-progress",
  setup(context) {
    const { toast, bell, oscNotify, oscProgress } = context.options as {
      toast?: boolean
      bell?: boolean
      oscNotify?: "9" | "777" | "99"
      oscProgress?: boolean
    }
    const appID = toast === false ? undefined : registerToastAppID()
    const toastIcon =
      process.platform === "win32" ? fileURLToPath(new URL("./assets/opencode.png", import.meta.url)) : undefined
    const systemToast =
      toast === false
        ? undefined
        : (title: string, message: string, sessionID?: string) =>
            notifier.notify(
              {
                title: process.platform === "win32" ? `OC | ${title}` : title,
                message,
                ...(appID ? { appID } : {}),
                ...(toastIcon ? { icon: toastIcon } : {}),
              },
              (error, response, metadata) => {
                const activated = [response, metadata?.activationType].some((value) => {
                  const type = value?.toLowerCase().trim()
                  return (
                    type === "activate" ||
                    type === "click" ||
                    type === "foreground" ||
                    type === "protocol" ||
                    !!type?.endsWith("clicked")
                  )
                })
                if (error || !activated) return
                focusTerminal()
                if (!sessionID) return
                if (
                  context.ui.tabs.enabled() &&
                  (context.ui.tabs.focus(sessionID) || context.ui.tabs.focus(context.data.session.root(sessionID)))
                )
                  return
                context.ui.router.navigate({ type: "session", sessionID })
              },
            )
    let notificationId = 0
    let currentSessionId: string | undefined
    let state = 0
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let completionTimer: ReturnType<typeof setTimeout> | undefined
    let completionSessionId: string | undefined
    let completionVisible = false
    let activeFamily = new Set<string>()
    let disposed = false
    const seen = new Set<string>()
    const permissionTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const eligiblePermissions = new Set<string>()

    const setState = (next: number) => {
      if (next === state && !completionVisible) return
      if (oscProgress !== false) writeTerminal(context.renderer, `\x1b]9;4;${next}${next === 4 ? ";100" : ""}\x07`)
      state = next
      completionVisible = false
    }

    const clearCompletion = () => {
      clearTimeout(completionTimer)
      completionTimer = undefined
      completionSessionId = undefined
    }

    const remember = (event: { type: string; id: string }) => {
      const key = `${event.type}:${event.id}`
      if (seen.has(key)) return false
      seen.add(key)
      if (seen.size > 256) seen.delete(seen.values().next().value ?? key)
      return true
    }

    const sessionNotify = (
      sessionID: string,
      message: string,
      ring: boolean,
      eventID: string,
      includeChild = false,
    ) => {
      const route = context.ui.router.current()
      if (
        disposed ||
        route.type !== "session" ||
        (route.sessionID !== sessionID && !context.data.session.family(route.sessionID).includes(sessionID))
      )
        return
      const session = context.data.session.get(sessionID)
      if (!includeChild && session?.parentID !== undefined) return
      if (ring && bell !== false && claimNotification(eventID, "bell")) writeTerminal(context.renderer, "\x07")
      const title = normalizeText(
        context.data.session.get(context.data.session.root(sessionID))?.title ?? session?.title ?? "OpenCode",
        100,
      )
      const body = normalizeText(message, 240)
      if (systemToast && claimNotification(eventID, "toast")) systemToast(title, body, sessionID)
      if (oscNotify && claimNotification(eventID, "osc")) {
        if (oscNotify === "9") writeTerminal(context.renderer, `\x1b]9;${title.replaceAll(";", ",")}: ${body}\x07`)
        else if (oscNotify === "777")
          writeTerminal(
            context.renderer,
            `\x1b]777;notify;${title.replaceAll(";", ",")};${body.replaceAll(";", ",")}\x07`,
          )
        else {
          const id = `oc-terminal-progress-${++notificationId}`
          writeTerminal(context.renderer, `\x1b]99;i=${id}:d=0;${title}\x07`)
          writeTerminal(context.renderer, `\x1b]99;i=${id}:p=body;${body}\x07`)
        }
      }
    }

    const schedulePermission = (sessionID: string, requestID: string) => {
      const key = `${sessionID}:${requestID}`
      if (
        eligiblePermissions.has(key) ||
        permissionTimers.has(key) ||
        !remember({ type: "permission.request", id: key })
      )
        return
      permissionTimers.set(
        key,
        setTimeout(async () => {
          permissionTimers.delete(key)
          let requests = context.data.session.permission.list(sessionID)
          if (requests === undefined) {
            await context.data.session.permission.sync(sessionID).catch(() => {})
            requests = context.data.session.permission.list(sessionID)
          }
          const pending = requests?.find((entry) => entry.id === requestID)
          if (!pending || disposed) return
          eligiblePermissions.add(key)
          if (activeFamily.has(sessionID)) clearCompletion()
          const action = normalizeText(pending.action, 40)
          const resources = normalizeText(pending.resources.join(", "), 90)
          const reason = normalizeText(pending.message ?? "", 65)
          sessionNotify(
            sessionID,
            `Permission: ${action}${resources ? ` | Resources: ${resources}` : ""}${reason ? ` | Reason: ${reason}` : ""}`,
            true,
            `permission.request:${key}`,
            true,
          )
          queueMicrotask(update)
        }, 500),
      )
    }

    const completionMessage = async (sessionID: string) => {
      await context.data.session.message.sync(sessionID).catch(() => {})
      const message = context.data.session.message
        .list(sessionID)
        .findLast((entry) => entry.type === "assistant" && entry.finish !== "tool-calls")
      const response =
        message?.type === "assistant"
          ? message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(" ")
              .trim()
          : undefined
      return response ? `Completed: ${response}` : "Task completed"
    }

    const update = () => {
      if (disposed) return
      const route = context.ui.router.current()
      const sessionId = route.type === "session" ? route.sessionID : undefined
      activeFamily = new Set(sessionId ? [sessionId, ...context.data.session.family(sessionId)] : [])
      if (completionSessionId && !activeFamily.has(completionSessionId)) clearCompletion()
      else if (completionSessionId) {
        if (completionTimer !== undefined) return
        if (context.data.session.status(completionSessionId) === "running") return
        completionSessionId = undefined
      }
      let next = 0
      if (sessionId) {
        let waiting = false
        for (const id of activeFamily) {
          const permissions = context.data.session.permission.list(id)
          const forms = context.data.session.form.list(id)
          if (permissions === undefined) void context.data.session.permission.sync(id).catch(() => {})
          else {
            for (const permission of permissions) schedulePermission(id, permission.id)
            waiting ||= permissions.some((permission) => eligiblePermissions.has(`${id}:${permission.id}`))
          }
          if (forms === undefined) void context.data.session.form.sync(id).catch(() => {})
          waiting ||= !!forms?.length
        }
        next = waiting ? 4 : context.data.session.status(sessionId) === "running" ? 3 : 0
      }
      if (next || sessionId !== currentSessionId) {
        currentSessionId = sessionId
        clearTimeout(idleTimer)
        idleTimer = undefined
        setState(next)
      } else if (state && idleTimer === undefined) {
        idleTimer = setTimeout(() => {
          idleTimer = undefined
          setState(0)
        }, 1500)
      }
    }

    const unsubscribe = context.data.listen(({ details }) => {
      const { type } = details
      if (type === "permission.asked") {
        if (remember(details)) schedulePermission(details.data.sessionID, details.data.id)
      } else if (type === "permission.replied") {
        const key = `${details.data.sessionID}:${details.data.requestID}`
        clearTimeout(permissionTimers.get(key))
        permissionTimers.delete(key)
        eligiblePermissions.delete(key)
      } else if (type === "form.created") {
        if (remember(details)) {
          if (activeFamily.has(details.data.form.sessionID)) clearCompletion()
          const fields = details.data.form.fields.filter((field) => !("hidden" in field && field.hidden))
          const first = fields[0]
          const question = first
            ? normalizeText(first.title || first.key, 38) +
              ("options" in first && first.options?.length
                ? ` [Options: ${normalizeText(first.options.map((option) => option.label).join(", "), 50)}]`
                : "") +
              (first.description || ("placeholder" in first ? first.placeholder : "")
                ? ` — ${normalizeText(first.description || ("placeholder" in first ? first.placeholder : "") || "", 30)}`
                : "")
            : ""
          let message = `Answer needed: ${normalizeText(details.data.form.title, 40)}${question ? ` — ${question}` : ""}`
          for (const field of fields.slice(1)) {
            const prompt = normalizeText(field.title || field.key, 45)
            const choices =
              "options" in field && field.options?.length
                ? ` [Options: ${normalizeText(field.options.map((option) => option.label).join(", "), 50)}]`
                : ""
            const detail = `${prompt}${choices}`
            const remaining = 240 - message.length - 2
            if (detail.length <= remaining) message += `; ${detail}`
            else {
              if (prompt.length <= remaining) message += `; ${prompt}`
              break
            }
          }
          sessionNotify(
            details.data.form.sessionID,
            message,
            true,
            `${type}:${details.data.form.sessionID}:${details.id}`,
            true,
          )
        }
      } else if (type === "session.execution.succeeded" || type === "session.execution.failed") {
        if (remember(details)) {
          const eventID = `${type}:${details.data.sessionID}:${details.id}`
          const route = context.ui.router.current()
          const isCurrentSession = route.type === "session" && route.sessionID === details.data.sessionID
          if (isCurrentSession) {
            clearTimeout(idleTimer)
            idleTimer = undefined
            clearCompletion()
            completionSessionId = details.data.sessionID
            if (oscProgress !== false)
              writeTerminal(context.renderer, `\x1b]9;4;${type === "session.execution.succeeded" ? 1 : 2};100\x07`)
            completionVisible = oscProgress !== false
            if (bell !== false && claimNotification(eventID, "bell")) writeTerminal(context.renderer, "\x07")
            completionTimer = setTimeout(() => {
              completionTimer = undefined
              if (disposed || completionSessionId !== details.data.sessionID) return
              setState(0)
              if (context.data.session.status(details.data.sessionID) !== "running") completionSessionId = undefined
              update()
            }, 1500)
          }
          const notify = async () => {
            const message =
              details.type === "session.execution.failed"
                ? `Failed: ${normalizeText(details.data.error.message, 232) || "Task failed"}`
                : await completionMessage(details.data.sessionID)
            sessionNotify(details.data.sessionID, message, !isCurrentSession, eventID)
          }
          void notify()
        }
      } else if (type === "session.execution.started") {
        if (activeFamily.has(details.data.sessionID)) clearCompletion()
      }
      if (
        type.startsWith("permission.") ||
        type.startsWith("form.") ||
        type === "session.status" ||
        type === "session.execution.started" ||
        type === "tui.session.select"
      )
        queueMicrotask(update)
    })

    const timer = setInterval(update, 500)
    update()
    return () => {
      disposed = true
      clearInterval(timer)
      clearTimeout(idleTimer)
      clearCompletion()
      for (const timeout of permissionTimers.values()) clearTimeout(timeout)
      permissionTimers.clear()
      unsubscribe()
      setState(0)
    }
  },
})
