/**
 * opencode-discord — bridges OpenCode with a Discord server.
 *
 * The bot listens to messages in a set of channel IDs for one server (guild),
 * forwards each message into a persistent OpenCode session, and replies to
 * Discord with ONLY the assistant's final text output — reasoning, tool calls,
 * and other internal parts are filtered out. The bot's Discord status always
 * shows OpenCode's current default model (e.g. "Claude Sonnet 4.6 · thinking…")
 * while working, and back to "online" + an idle status when done.
 *
 * Configuration:
 *   - Bot token: DISCORD_BOT_TOKEN env var, `token` in ctx.options,
 *     or `token` in `.opencode/discord.json`
 *   - guildID / channelIDs / idleText / workingText / timeoutMs /
 *     includeAuthor: `.opencode/discord.json` or `ctx.options`
 *
 * Discord setup:
 *   1. Create an application + bot at https://discord.com/developers/applications,
 *      enable "MESSAGE CONTENT INTENT" under Privileged Gateway Intents.
 *   2. Invite the bot to your server (OAuth2 -> URL Generator -> scopes: bot;
 *      permissions: View Channels, Send Messages, Read Message History).
 *   3. Enable Developer Mode in Discord (Settings -> Advanced), right-click the
 *      server and the channels -> Copy ID.
 *   4. Put the IDs in `.opencode/discord.json`.
 *   5. Run `opencode` in the project root and message the bot in one of the
 *      channels.
 */

// ---------------------------------------------------------------------------
// Discord constants + small helpers
// ---------------------------------------------------------------------------

const API_BASE = "https://discord.com/api/v10"
/** GUILDS (1<<0) | GUILD_MESSAGES (1<<9) | MESSAGE_CONTENT (1<<15) */
const GATEWAY_INTENTS = 1 | 512 | 32768

const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_PRESENCE = 3
const OP_RESUME = 6
const OP_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any // the plugin context shape follows the running OpenCode server; keep it loose.

type GatewayPayload = { op: number; t?: string; d?: any; s?: number | null }

interface DiscordConfig {
  token: string
  guildID: string
  channelIDs: string[]
  /** custom status text when idle */
  idleText?: string
  /** custom status text while working */
  workingText?: string
  /** max ms to wait for the agent before interrupting */
  timeoutMs?: number
  /** prefix forwarded messages with the Discord author, e.g. "@alice: fix the tests" */
  includeAuthor?: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Split into Discord-sized chunks (2000 limit), preferring line/space breaks. */
function chunkText(text: string, size = 1900): string[] {
  const chunks: string[] = []
  let rest = text.trim()
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size)
    if (cut <= 0) cut = rest.lastIndexOf(" ", size)
    if (cut <= 0) cut = size
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).replace(/^[\s\n]+/, "")
  }
  if (rest) chunks.push(rest)
  return chunks
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default {
  id: "discord",
  async setup(ctx: Any) {
    const root: string = ctx?.location?.directory ?? process.cwd()

    // the background service discards stderr, so keep a dedicated log file too
    const fs = await import("node:fs")
    const path = await import("node:path")
    const logPath = path.join(root, ".opencode", "discord.log")
    const log = (message: string) => {
      const line = `[${new Date().toISOString()}] [opencode-discord] ${message}`
      console.error(line)
      try {
        fs.appendFileSync(logPath, line + "\n")
      } catch {
        /* file logging is best-effort */
      }
    }

    // --- configuration -----------------------------------------------------
    let fileConfig: Partial<DiscordConfig> = {}
    try {
      const configPath = path.join(root, ".opencode", "discord.json")
      if (fs.existsSync(configPath)) {
        fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"))
      }
    } catch (error) {
      log(`could not read .opencode/discord.json: ${error}`)
    }

    const partial = { ...fileConfig, ...((ctx?.options ?? {}) as Partial<DiscordConfig>) }
    const config: DiscordConfig = {
      ...partial,
      token: partial.token || process.env["DISCORD_BOT_TOKEN"] || "",
      guildID: partial.guildID || "",
      channelIDs: Array.isArray(partial.channelIDs) ? partial.channelIDs : [],
      idleText: partial.idleText ?? "for OpenCode requests",
      workingText: partial.workingText ?? "thinking…",
      timeoutMs: Number(partial.timeoutMs) > 0 ? Number(partial.timeoutMs) : 120_000,
      includeAuthor: partial.includeAuthor !== false,
    }

    if (!config.token || !config.guildID || config.channelIDs.length === 0) {
      log(
        "disabled — provide DISCORD_BOT_TOKEN (or .opencode/discord.json token) plus guildID " +
          "and channelIDs; see the README in .opencode/plugins/discord/",
      )
      return
    }

    log(`enabled for guild ${config.guildID}, channels: ${config.channelIDs.join(", ")}`)

    // --- gateway state -------------------------------------------------------
    const state = {
      ws: undefined as WebSocket | undefined,
      heartbeatTimer: undefined as ReturnType<typeof setInterval> | undefined,
      lastSeq: 0,
      sessionID: "",
      acked: true,
      ready: false,
      reconnectAttempts: 0,
      shutdown: false,
      recentMessageIDs: new Set<string>(),
      working: false,
      queued: 0,
    }

    // --- Discord REST --------------------------------------------------------
    async function discordFetch(url: string, init: RequestInit, attempt = 0): Promise<Response> {
      const response = await fetch(url, {
        ...init,
        headers: {
          "Authorization": `Bot ${config.token}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      })
      if (response.status === 429 && attempt < 3) {
        let wait = 1000
        try {
          const body = await response.clone().json()
          wait = Math.ceil(Number(body?.retry_after ?? 1) * 1000)
        } catch {
          /* keep default wait */
        }
        await sleep(Math.min(wait, 20_000))
        return discordFetch(url, init, attempt + 1)
      }
      return response
    }

    async function sendDiscordMessage(
      channelID: string,
      content: string,
      replyToID?: string,
    ): Promise<void> {
      const url = `${API_BASE}/channels/${channelID}/messages`
      const chunks = chunkText(content)
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index]
        try {
          const response = await discordFetch(url, {
            method: "POST",
            body: JSON.stringify({
              content: chunk,
              allowed_mentions: { parse: [] },
              // thread the answer to the triggering message (first chunk only)
              ...(index === 0 && replyToID
                ? { message_reference: { message_id: replyToID } }
                : {}),
            }),
          })
          if (!response.ok) log(`POST message to ${channelID} -> ${response.status}`)
        } catch (error) {
          log(`POST message to ${channelID} failed: ${error}`)
        }
        await sleep(350) // stay under message rate limits
      }
    }

    // --- presence --------------------------------------------------------
    /** Human-readable name of OpenCode's current default model, "" when unavailable. */
    async function currentModelLabel(): Promise<string> {
      try {
        const chosen = await ctx.model.default()
        if (!chosen?.providerID || !chosen?.modelID) return ""
        const models = await ctx.model.list(chosen.providerID)
        const info = models.find((model: Any) => model?.id === chosen.modelID)
        return String(info?.name || chosen.modelID)
      } catch {
        return ""
      }
    }

    async function applyPresence(): Promise<void> {
      if (state.ws?.readyState !== WebSocket.OPEN) return
      const modelLabel = await currentModelLabel()
      const prefix = modelLabel ? `${modelLabel} · ` : ""
      gatewaySend({
        op: OP_PRESENCE,
        d: {
          since: null,
          status: state.working ? "dnd" : "online",
          activities: [
            {
              name: "Custom Status",
              type: 4,
              state: prefix + (state.working ? config.workingText : config.idleText),
            },
          ],
          afk: false,
        },
      })
    }

    // serialize presence sends so async model lookups can never emit stale flips
    let presenceChain = Promise.resolve()
    function requestPresence(): void {
      presenceChain = presenceChain.then(() => applyPresence()).catch(() => undefined)
    }

    // --- OpenCode session helpers ---------------------------------------------
    const SESSION_MAP_KEY = "discord:sessions"

    async function getOrCreateSession(channelID: string): Promise<string> {
      const map = (await ctx.storage.get(SESSION_MAP_KEY)) ?? {}
      const known = map[channelID]
      if (typeof known === "string" && known) {
        try {
          await ctx.session.get({ sessionID: known })
          return known
        } catch {
          delete map[channelID] // stale mapping — recreate below
          await ctx.storage.set(SESSION_MAP_KEY, map)
        }
      }
      const session = await ctx.session.create({ title: `discord #${channelID}`.slice(0, 80) })
      map[channelID] = session.id
      await ctx.storage.set(SESSION_MAP_KEY, map)
      return session.id
    }

    /**
     * Extract only assistant text content from the new session messages:
     * no reasoning parts, no tool-call parts, no synthetic/system noise.
     */
    function extractReplyText(messages: Any, afterCount: number): string {
      const fresh = (messages ?? []).slice(afterCount)
      const textOf = (message: Any): string => {
        const parts = Array.isArray(message?.content) ? message.content : []
        return parts
          .filter((part: Any) => part?.type === "text" && typeof part.text === "string")
          .map((part: Any) => part.text)
          .join("\n")
          .trim()
      }
      const assistants = fresh.filter((message: Any) => message?.type === "assistant")
      for (let index = assistants.length - 1; index >= 0; index--) {
        const text = textOf(assistants[index])
        if (text) return text
      }
      return ""
    }

    // --- message pipeline ---------------------------------------------------------
    let pipeline = Promise.resolve()
    const TIMEOUT_NOTE =
      "I ran into the processing timeout without finishing a reply — try rephrasing or asking again."

    function enqueue(trigger: {
      channelID: string
      messageID: string
      author: string
      text: string
    }): void {
      state.queued += 1
      const channelID = trigger.channelID
      const speaker = trigger.author ? `@${trigger.author}` : ""
      const promptText = speaker && config.includeAuthor
        ? `${speaker}: ${trigger.text.trim()}`
        : trigger.text.trim()
      const excerpt = trigger.text.trim().slice(0, 60)
      const job = async () => {
        log(
          `processing request from #${channelID}${speaker ? ` (${speaker})` : ""}: "${excerpt}"`,
        )
        state.working = true
        requestPresence()
        try {
          const sessionID = await getOrCreateSession(channelID)
          const before = await ctx.session.context({ sessionID })
          await ctx.session.prompt({
            sessionID,
            text: promptText,
            delivery: "queue",
          })

          // wait for the session to go idle again, with a safety timeout
          let timedOut = false
          await Promise.race([
            ctx.session.wait({ sessionID }),
            new Promise<void>((resolve) =>
              setTimeout(() => {
                timedOut = true
                resolve()
              }, config.timeoutMs),
            ),
          ])
          if (timedOut) {
            log(`wait timed out on session ${sessionID}, interrupting`)
            await ctx.session.interrupt({ sessionID, continue: false })
            await Promise.race([
              ctx.session.wait({ sessionID }).catch(() => undefined),
              sleep(15_000),
            ])
          }

          const after = await ctx.session.context({ sessionID })
          const reply = extractReplyText(after, (before ?? []).length)
          if (reply) {
            await sendDiscordMessage(channelID, reply, trigger.messageID)
          } else if (timedOut) {
            await sendDiscordMessage(channelID, TIMEOUT_NOTE, trigger.messageID)
          } else {
            log(`no text content produced for #${channelID} — not spamming Discord`)
          }
        } catch (error) {
          log(`message pipeline failed: ${error}`)
          await sendDiscordMessage(
            channelID,
            `error while processing: ${String(error).slice(0, 300)}`,
            trigger.messageID,
          ).catch(() => undefined)
        } finally {
          state.queued -= 1
          if (state.queued > 0) {
            state.working = true // next request is already queued; stay "working"
          } else {
            state.working = false
          }
          requestPresence()
        }
      }
      // the job body has its own try/finally; this catch is insurance so the
      // pipeline can never become a permanently rejected promise
      pipeline = pipeline.then(job).catch((error) => log(`pipeline job crashed: ${error}`))
    }

    // --- gateway protocol -----------------------------------------------------------
    function gatewaySend(payload: unknown): void {
      if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload))
    }

    function startHeartbeat(intervalMs: number): void {
      if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
      state.heartbeatTimer = setInterval(() => {
        if (state.ws?.readyState !== WebSocket.OPEN) return
        if (!state.acked) {
          log("missed heartbeat ack, forcing reconnect")
          try {
            state.ws.close(4000, "heartbeat-timeout")
          } catch {
            /* already closing */
          }
          return
        }
        state.acked = false
        gatewaySend({ op: OP_HEARTBEAT, d: state.lastSeq || null })
      }, intervalMs)
    }

    function scheduleReconnect(): void {
      const wait = Math.min(1000 * 2 ** state.reconnectAttempts, 60_000)
      state.reconnectAttempts += 1
      setTimeout(() => {
        void connectGateway().catch((error) => log(`reconnect failed: ${error}`))
      }, wait)
    }

    async function connectGateway(): Promise<void> {
      const res = await fetch(`${API_BASE}/gateway/bot`, {
        headers: { Authorization: `Bot ${config.token}` },
      })
      if (!res.ok) throw new Error(`gateway/bot gave ${res.status} — check the bot token`)
      const url = (await res.json())?.url as string

      state.acked = true
      state.ready = false
      const ws = new WebSocket(`${url}?v=10&encoding=json`)
      state.ws = ws

      ws.addEventListener("open", () => {
        state.reconnectAttempts = 0
      })
      ws.addEventListener("message", (rawEvent) => {
        void onGatewayMessage(rawEvent as unknown as { data: string | Buffer })
      })
      ws.addEventListener("error", () => log("gateway socket error"))
      ws.addEventListener("close", (event) => {
        const closeEvent = event as unknown as { code: number; reason: string }
        log(`gateway closed code=${closeEvent.code}`)
        if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
        state.heartbeatTimer = undefined
        state.ready = false
        if (state.shutdown) return
        if (closeEvent.code === 4004) {
          log("Discord rejected the token (401/4004). Not reconnecting.")
          return
        }
        scheduleReconnect()
      })
    }

    async function onGatewayMessage(raw: { data: string | Buffer }): Promise<void> {
      let payload: GatewayPayload
      try {
        payload = JSON.parse(typeof raw.data === "string" ? raw.data : String(raw.data))
      } catch {
        return
      }

      if (typeof payload.s === "number") state.lastSeq = payload.s

      switch (payload.op) {
        case OP_HELLO: {
          const interval = Number(payload.d?.["heartbeat_interval"] ?? 45_000)
          startHeartbeat(interval)
          if (state.lastSeq && state.sessionID) {
            gatewaySend({
              op: OP_RESUME,
              d: { token: config.token, session_id: state.sessionID, seq: state.lastSeq },
            })
          } else {
            gatewaySend({
              op: OP_IDENTIFY,
              d: {
                token: config.token,
                intents: GATEWAY_INTENTS,
                properties: { os: "linux", browser: "opencode", device: "opencode" },
                presence: { since: null, status: "online", activities: [], afk: false },
              },
            })
          }
          return
        }
        case OP_HEARTBEAT:
          gatewaySend({ op: OP_HEARTBEAT, d: state.lastSeq || null })
          return
        case OP_HEARTBEAT_ACK:
          state.acked = true
          return
        case OP_RECONNECT:
          log("gateway requested reconnect")
          state.ws?.close(1000, "op7")
          return
        case OP_INVALID_SESSION:
          if (payload.d === true) {
            // resumable: Discord wants the RESUME on the same connection after a 1–5s delay
            log("invalid session; will attempt resume")
            setTimeout(
              () =>
                gatewaySend({
                  op: OP_RESUME,
                  d: { token: config.token, session_id: state.sessionID, seq: state.lastSeq },
                }),
              1_000 + Math.floor(Math.random() * 4_000),
            )
            return
          }
          log("session invalidated; fresh identify next time")
          state.sessionID = ""
          state.lastSeq = 0
          state.ws?.close(1000, "op9-hard")
          return
      }

      if (payload.op !== OP_DISPATCH || !payload.t || !payload.d) return
      const type = payload.t as string
      const data = payload.d as Any

      switch (type) {
        case "READY":
          state.sessionID = data?.["session_id"] ?? ""
          state.ready = true
          state.reconnectAttempts = 0
          log(`connected as @${data?.["user"]?.username ?? "unknown"}`)
          state.recentMessageIDs.clear()
          requestPresence()
          return
        case "RESUMED":
          log("gateway resumed")
          requestPresence()
          return
        case "MESSAGE_CREATE":
          onDiscordMessage(data)
          return
      }
    }

    function onDiscordMessage(data: Any): void {
      try {
        if (!state.ready) return
        if (!data?.["id"] || typeof data["content"] !== "string" || !data["content"].trim()) return
        if (data["webhook_id"]) return
        if (data["author"]?.["bot"]) return
        const messageType = Number(data["type"] ?? 0)
        if (messageType !== 0 && messageType !== 19) return // default + reply only
        if (data["guild_id"] !== config.guildID) return
        if (!config.channelIDs.includes(data["channel_id"])) return
        if (state.recentMessageIDs.has(data["id"])) return // dedupe on resume replays
        state.recentMessageIDs.add(data["id"])
        if (state.recentMessageIDs.size > 5000) {
          const iterator = state.recentMessageIDs.values()
          for (let index = 0; index < 1000; index++) {
            const oldest = iterator.next().value
            if (oldest === undefined) break
            state.recentMessageIDs.delete(oldest)
          }
        }
        // forward the author so the session knows who said what
        const author = String(data["author"]?.["global_name"] || data["author"]?.["username"] || "")
        enqueue({
          channelID: data["channel_id"],
          messageID: data["id"],
          author,
          text: data["content"],
        })
      } catch (error) {
        log(`onDiscordMessage failed: ${error}`)
      }
    }

    // --- lifecycle --------------------------------------------------------------
    // reassert the presence once a minute so the shown model stays current
    // even when OpenCode's model changes outside of a Discord request
    const presenceRefresh = setInterval(() => requestPresence(), 60_000)

    try {
      await connectGateway()
    } catch (error) {
      log(`initial gateway connect failed: ${error}`)
      scheduleReconnect()
    }

    return () => {
      clearInterval(presenceRefresh)
      state.shutdown = true
      try {
        state.ws?.close(1000, "opencode-unload")
      } catch {
        /* ignore */
      }
    }
  },
}
