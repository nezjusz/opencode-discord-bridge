# opencode-discord-bridge

An [OpenCode](https://opencode.ai) plugin that bridges your OpenCode setup with a Discord server. Message the bot in configured channels and it answers with OpenCode — in its own Discord voice, not its internals.

## Features

- **Channel-pinned listening** — only reacts to messages you allow-list (one server ID + any set of channel IDs). Ignores bots, webhooks, system messages.
- **Text-only answers** — replies contain only the assistant's final message. No reasoning, no tool-call dumps, no streaming noise.
- **Knows who's talking** — prompts are labeled with the Discord author (`@alice: fix the tests`), and every channel shares one persistent OpenCode session, so it remembers the conversation and whose context it came from. Replies are threaded to the triggering message. (`includeAuthor: false` for anonymous forwarding.)
- **Live status** — while working, the bot goes Do Not Disturb with `Claude Sonnet 4.6 · thinking…` (whatever model OpenCode has set); at idle it shows `… · for OpenCode requests`. The model name is resolved live and refreshed on every request *and* every minute, so config changes show up automatically.
- **Robust gateway** — heartbeat + ack supervision, resume with sequence replay (`INVALID_SESSION` handled per Discord's spec), exponential-backoff reconnects, rate-limit-aware REST posting, event dedup, 2000-char chunking, and a timeout that interrupts hung sessions and tells you about it.
- **Zero dependencies** — talks to Discord's Gateway + REST APIs with the runtimes' built-in `WebSocket` and `fetch`.

## Discord setup

1. Create an application + bot at <https://discord.com/developers/applications>.
2. On the bot page enable **MESSAGE CONTENT INTENT** under *Privileged Gateway Intents* (required to read messages).
3. Invite it: OAuth2 → URL Generator → scopes: `bot`; permissions: **View Channels, Send Messages, Read Message History**. Make sure channel permission overrides let the bot see the target channels.
4. Enable **Developer Mode** in Discord (Settings → Advanced), then right-click your **server → Copy Server ID** and each target **channel → Copy Channel ID**.

## Configuration

Create `.opencode/discord.json` in the directory you run OpenCode from:

```json
{
  "token": "YOUR_DISCORD_BOT_TOKEN",
  "guildID": "SERVER_ID",
  "channelIDs": ["CHANNEL_ID_1", "CHANNEL_ID_2"],
  "idleText": "for OpenCode requests",
  "workingText": "thinking…",
  "timeoutMs": 120000,
  "includeAuthor": true
}
```

*(see `discord.json.example` in this repo)*

| Option | Default | Meaning |
|---|---|---|
| `token` | `$DISCORD_BOT_TOKEN` env var | Bot token. Prefer the env var so the secret doesn't sit in a file. |
| `guildID` | — (required) | Server ID the bot responds in. |
| `channelIDs` | — (required) | Only reply to messages in these channel IDs. |
| `idleText` | `"for OpenCode requests"` | Custom status when the request queue is empty. |
| `workingText` | `"thinking…"` | Custom status while working. |
| `timeoutMs` | `120000` | Wait for OpenCode this long, then interrupt and tell Discord it timed out. |
| `includeAuthor` | `true` | Forward prompts as `"@username: message text"`. |

Alternatively pass the same keys as **plugin options** in `opencode.json(c)` (they override the file):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./opencode-discord-bridge/src/index.ts",
      "options": {
        "guildID": "SERVER_ID",
        "channelIDs": ["CHANNEL_ID_1"]
      }
    }
  ]
}
```

## Install

Clone anywhere, then point OpenCode's config at it:

```jsonc
// opencode.jsonc in your project
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["../opencode-discord-bridge/src/index.ts"]
}
```

…or copy `src/index.ts` into your project at `.opencode/plugins/discord/index.ts` for auto-discovery, alongside `.opencode/discord.json`.

## Running

Start OpenCode normally from the project root:

```sh
opencode
```

Plugin log lines go to the shared server log (`~/.local/share/opencode/log/opencode.log` on Linux) prefixed with `[opencode-discord]`. Once the gateway is connected you'll see `connected as @YourBot`, and the bot turns online in your server.

## Behavior notes

- Every forwarded prompt is labeled with its author, e.g. `@alice: fix the tests`, so the shared channel session knows who said what (toggle via `includeAuthor`). Replies are threaded to the triggering message.
- The status reflects OpenCode's **default model** — the one the plugin's sessions run on. If the model can't be resolved, the status falls back to plain text.
- Requests are processed one at a time in arrival order; extras queue up and the bot stays in the "working" presence until the queue drains. If the session is busy, prompts queue inside the session rather than steering.
- Long replies are split into Discord-sized (≤1900 chars) chunks at line/space boundaries.
- One OpenCode session per Discord channel is kept via plugin storage; if the session is deleted or stale, the plugin transparently creates a new one.
- The bot never mention-pings users (`allowed_mentions` is empty).
- The plugin opens **one Discord gateway per `opencode` process** — run OpenCode from the single project directory that owns this plugin config to avoid duplicate connections.
- To reset a channel's conversation: delete its session in the OpenCode UI, or clear plugin storage.

## License

[MIT](./LICENSE)
