/**
 * opencode-intercom — 极简跨会话通信插件(OpenCode 2)
 *
 * 设计目标:把「会话间通信」的上下文成本压到最低。
 *   - 只注册一个工具(action 分发:list / read / send),而非一套五个
 *   - 工具走 Code Mode(codemode: true):不进每个会话的常驻工具目录,
 *     模型需要时通过 execute 检索调用,不用时几乎零上下文占用
 *   - 单文件、无 TUI、无线程存储、零依赖
 *
 * 消息机制(参考并精简自 jmfirth/opencode-messaging,MIT):
 *   - 读:HTTP 调本机 OpenCode 服务的只读接口(会话列表 / 消息历史)
 *   - 写:ctx.session.synthetic 注入合成消息,走 OpenCode 持久 inbox
 *     queue = 对方空闲时落地;steer = 紧急打断
 *
 * 安全默认:
 *   - 默认只能发给与当前会话同目录的会话(插件配置 accept:"any" 放开)
 *   - 发送限速:每会话 30 条 / 5 分钟(内存计数,防两个 agent 互刷)
 *   - read / send 拒绝以当前会话自己为目标
 *   - 工具断言 permission 动作 "intercom",可在 permissions 里管控
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

// ---------------------------------------------------------------------------
// 结构类型(只声明本插件实际读取的字段)
// ---------------------------------------------------------------------------

interface SessionLike {
  readonly id: string
  readonly parentID?: string
  readonly agent?: string
  readonly title?: string
  readonly location?: { readonly directory?: string }
  readonly time?: { readonly updated?: number }
}

interface SenderContext {
  readonly sessionID: string
  readonly agent: string
}

interface IntercomInput {
  readonly action: "list" | "read" | "send"
  readonly session?: string
  readonly text?: string
  readonly all?: boolean
  readonly steer?: boolean
  readonly limit?: number
}

interface ToolDraft {
  add(tool: {
    name: string
    description: string
    options?: { codemode?: boolean; permission?: string }
    input: Record<string, unknown>
    execute: (input: IntercomInput, context: SenderContext) => Promise<{ content: string }>
  }): void
}

interface PluginContext {
  readonly options?: Record<string, unknown>
  readonly tool: { transform: (fn: (draft: ToolDraft) => void) => Promise<void> | void }
  readonly session: { synthetic: (input: Record<string, unknown>) => Promise<unknown> }
}

// ---------------------------------------------------------------------------
// 服务访问(会话列表与消息历史不在插件 session 域上,走本机 HTTP API)
// ---------------------------------------------------------------------------

const SERVICE = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
  "opencode",
  "service.json",
)

async function api(path: string): Promise<any> {
  let service: { url?: string; password?: string }
  try {
    service = JSON.parse(readFileSync(SERVICE, "utf8"))
  } catch {
    throw new Error(`读不到 OpenCode 服务注册文件:${SERVICE}`)
  }
  const response = await fetch(`${service.url}${path}`, {
    headers: { authorization: `Basic ${Buffer.from(`opencode:${service.password}`).toString("base64")}` },
  }).catch(() => {
    throw new Error(`连不上 OpenCode 服务:${service.url}`)
  })
  if (response.status === 404) throw new Error("会话不存在(先用 action=list 查最新 id)")
  if (!response.ok) throw new Error(`服务返回 ${response.status}:${path}`)
  return response.json()
}

const sessions = async (): Promise<SessionLike[]> => (await api("/api/session")).data ?? []

const running = async (): Promise<Record<string, unknown>> =>
  api("/api/session/active")
    .then((body) => body.data ?? {})
    .catch(() => ({}))

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const clamp = (text: string, max = 800) => {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…(截断)` : t
}

const ago = (ts?: number) => {
  if (!ts) return "?"
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return "刚刚"
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`
  return `${Math.floor(s / 86400)}天前`
}

/** 发送限速:内存计数,插件重载即清零(限速的是速度,不是深度)。 */
const RATE = { limit: 30, windowMs: 5 * 60_000 }
const sendLog = new Map<string, number[]>()
function rateGate(sessionID: string) {
  const now = Date.now()
  const recent = (sendLog.get(sessionID) ?? []).filter((t) => now - t < RATE.windowMs)
  if (recent.length >= RATE.limit)
    throw new Error(`发送限速:每会话 ${RATE.limit} 条 / ${RATE.windowMs / 60000} 分钟`)
  recent.push(now)
  sendLog.set(sessionID, recent)
}

/** 把一条历史消息渲染成单个带标签块;空消息返回 null 跳过。 */
function render(message: unknown): string | null {
  const entry = (message ?? {}) as {
    type?: string
    exit?: number
    command?: unknown
    text?: unknown
    content?: unknown
  }

  if (entry.type === "shell") {
    const status = entry.exit === 0 ? "ok" : `exit ${entry.exit}`
    return `[shell] $ ${clamp(String(entry.command ?? ""), 200)} (${status})`
  }

  if (entry.type === "synthetic") {
    const body = clamp(String(entry.text ?? ""))
    return body ? `[system] ${body}` : null
  }

  if (entry.type === "user") {
    const text = clamp(String(entry.text ?? ""))
    return text ? `[user] ${text}` : null
  }

  if (entry.type === "assistant") {
    const text = (Array.isArray(entry.content) ? (entry.content as { type?: string; text?: unknown }[]) : [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .trim()
    return text ? `[assistant] ${clamp(text)}` : null
  }

  return null
}

/** 收件人看到的信封:谁发的、怎么回。 */
const envelope = (from: SessionLike | undefined, context: SenderContext, text: string) =>
  [
    `[intercom 来自会话 ${context.sessionID}(${basename(from?.location?.directory ?? "?")}/${from?.agent ?? "?"})「${from?.title ?? ""}」]`,
    clamp(text, 4000),
    `[如需回复:调用 intercom 工具,action=send,session="${context.sessionID}"]`,
  ].join("\n")

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

const LIST_LIMIT = 40
const READ_CHARS = 6000

export default {
  id: "opencode-intercom",
  setup: async (ctx: PluginContext) => {
    const accept = (ctx.options?.accept as string | undefined) ?? "same-directory"

    await ctx.tool.transform((tools: ToolDraft) => {
      tools.add({
        name: "intercom",
        description:
          "同一 OpenCode 服务内跨会话通信(对讲机)。action=list:列出其他会话,返回 id/目录/agent/状态/标题" +
          "(默认仅当前目录的顶层会话,all=true 列全部);action=read:只读获取某会话近期对话,不干扰对方" +
          "(limit 控制条数,默认 10);action=send:向某会话投递消息——对方会被唤醒并在它自己的对话里处理," +
          "回复稍后以消息形式出现在本会话,发送本身不阻塞。send 的消息需自包含(对方看不到本会话上下文)," +
          "发送前建议先 read 对方近期对话。仅 send 有副作用。" +
          "纪律:仅当用户明确要求通信、或回复已收到的 intercom 消息时才执行 send;" +
          "禁止未经用户指示主动向其他会话发送汇报、通知或状态更新。",
        options: { codemode: true, permission: "intercom" },
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "read", "send"], description: "要执行的操作" },
            session: { type: "string", description: "目标会话 id(read/send 必填,来自 list 结果)" },
            text: { type: "string", description: "send 消息正文,需自包含" },
            all: { type: "boolean", description: "list:包含其他目录与子会话,默认 false" },
            steer: { type: "boolean", description: "send:true=紧急打断对方;默认 false 排队等待" },
            limit: { type: "number", description: "read:返回近期消息条数,默认 10,上限 50" },
          },
          required: ["action"],
        },
        execute: async (input: IntercomInput, context: SenderContext) => {
          // ---- list:枚举其他会话 ----
          if (input.action === "list") {
            const [all, active] = await Promise.all([sessions(), running()])
            const self = all.find((s) => s.id === context.sessionID)

            const peers = all
              .filter((s) => s.id !== context.sessionID)
              .filter((s) => input.all || !s.parentID)
              .filter((s) => input.all || !self || s.location?.directory === self.location?.directory)
              .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
              .slice(0, LIST_LIMIT)

            if (peers.length === 0)
              return {
                content: input.all ? "服务中没有其他会话。" : "当前目录没有其他会话;传 all=true 可列全部。",
              }

            return {
              content: peers
                .map((s) => {
                  const tags = [active[s.id] ? "running" : "", s.parentID ? "subagent" : "", ago(s.time?.updated)]
                    .filter(Boolean)
                    .join(",")
                  return `${s.id} [${basename(s.location?.directory ?? "")}/${s.agent ?? "?"}] (${tags}) ${s.title ?? ""}`
                })
                .join("\n"),
            }
          }

          // ---- read:只读对方近期对话 ----
          if (input.action === "read") {
            if (!input.session) throw new Error("read 需要 session(id 来自 action=list)")
            if (input.session === context.sessionID)
              throw new Error("read 不能以当前会话为目标——你已有自己的历史")

            const limit = Math.min(Math.max(Math.floor(input.limit ?? 10), 1), 50)
            const body = await api(
              `/api/session/${encodeURIComponent(input.session)}/message?limit=${limit}&order=desc`,
            )
            const blocks = ((body.data ?? []) as unknown[])
              .map(render)
              .filter((block): block is string => Boolean(block))
              .reverse()

            if (blocks.length === 0) return { content: "对方还没有可读的消息。" }

            // 超长时保留最近的(而不是最早的)
            const kept: string[] = []
            let total = 0
            for (const block of [...blocks].reverse()) {
              if (total + block.length > READ_CHARS) break
              kept.unshift(block)
              total += block.length
            }
            const dropped = blocks.length - kept.length
            return {
              content: (dropped > 0 ? [`(已省略 ${dropped} 条更早消息)`, ...kept] : kept).join("\n\n"),
            }
          }

          // ---- send:投递消息并唤醒对方 ----
          if (!input.session) throw new Error("send 需要 session(id 来自 action=list)")
          if (input.session === context.sessionID) throw new Error("send 不能以当前会话为目标")
          if (!input.text?.trim()) throw new Error("send 需要非空 text")

          const all = await sessions()
          const target = all.find((s) => s.id === input.session)
          if (!target) throw new Error(`没有 id 为 ${input.session} 的会话——先 action=list 查最新 id`)
          const self = all.find((s) => s.id === context.sessionID)

          if (accept === "none") throw new Error("插件配置 accept:none,发送已禁用")
          if (
            accept === "same-directory" &&
            self &&
            target.location?.directory !== self.location?.directory
          )
            throw new Error(
              `默认策略只允许同目录发送(目标在 ${basename(target.location?.directory ?? "?")});` +
                '插件配置 accept:"any" 可放开',
            )

          rateGate(context.sessionID)
          const delivery = input.steer ? "steer" : "queue"

          await ctx.session.synthetic({
            sessionID: input.session,
            description: `intercom 来自「${self?.title ?? "?"}」(${basename(self?.location?.directory ?? "?")}/${context.agent})`,
            delivery,
            resume: true,
            text: envelope(self, context, input.text),
          })

          return {
            content:
              `已投递给 ${input.session} [${basename(target.location?.directory ?? "")}/${target.agent ?? "?"}],方式 ${delivery}。` +
              (delivery === "queue" ? "对方空闲时处理。" : "将在对方下一个安全点打断处理。") +
              "如有回复,会以消息形式稍后到达本会话。",
          }
        },
      })
    })
  },
}
