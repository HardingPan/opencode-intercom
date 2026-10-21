/**
 * opencode-heartbeat — 定时唤醒会话的零上下文调度器
 *
 * 形式:OpenCode 插件(单文件),但不注册任何工具、不进任何会话目录——
 * 对模型完全隐形,不占一丝上下文。
 *
 * 机制:轮询 ~/.config/opencode/heartbeat.json 中由用户定义的调度,
 * 到点通过 ctx.session.synthetic 注入消息唤醒目标会话(与 intercom 相同
 * 的已验证机制:queue + resume,不打断正在忙碌的会话)。
 *
 * 调度只能由用户创建:直接编辑配置文件,或让任一会话里的 agent 替你改
 * (agent 自身没有创建调度的工具,触发权完全在用户手里)。
 *
 * 配置格式(每 30 秒重读一次,改完即生效,无需重启):
 *
 *   [
 *     {
 *       "every": "30m",              // 间隔:数字+m/h,如 5m、30m、2h
 *       "session": "ses_xxx",        // 目标会话 id
 *       "text": "定时检查:……",       // 唤醒时注入的指令(需自包含)
 *       "enabled": true              // 可选,默认 true;false = 暂停
 *     }
 *   ]
 *
 * 运行记录:~/.config/opencode/heartbeat.log(每次触发与错误各一行)
 *
 * 已知边界(诚实说明):
 * - 下次触发时刻存于内存;插件重载/服务重启后从「当前时刻 + 间隔」重新起算
 * - 目标会话忙时消息排队等它空闲(不中断其工作)
 * - 检查耗时超过间隔时,下一次触发会排队叠加,靠队列自然串行
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

interface Beat {
  readonly every?: string
  readonly session?: string
  readonly text?: string
  readonly enabled?: boolean
}

interface PluginContext {
  readonly session: { synthetic: (input: Record<string, unknown>) => Promise<unknown> }
}

const CONFIG = join(homedir(), ".config", "opencode", "heartbeat.json")
const LOG = join(homedir(), ".config", "opencode", "heartbeat.log")
const LOCK = join(homedir(), ".config", "opencode", "heartbeat.lock")

const log = (line: string) => {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // 日志失败不影响调度
  }
}

/**
 * 领导锁:插件会随每个 location 各加载一份实例,若不加协调,同一条调度
 * 会被 N 份实例重复触发。锁带时效(2 个周期未续期即视为失效),持有者
 * 每次心跳续期;持有者所在进程退出后,其余实例自动接管。
 */
const MY_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`

function tryLead(): boolean {
  try {
    let lock: { id?: string; at?: number } = {}
    try {
      lock = JSON.parse(readFileSync(LOCK, "utf8")) as { id?: string; at?: number }
    } catch {
      // 无锁文件 = 可认领
    }
    if (lock.id === MY_ID) {
      writeFileSync(LOCK, JSON.stringify({ id: MY_ID, at: Date.now() }))
      return true
    }
    const fresh = typeof lock.at === "number" && Date.now() - lock.at < 2 * TICK
    if (fresh) return false // 别的实例健在,让给它
    writeFileSync(LOCK, JSON.stringify({ id: MY_ID, at: Date.now() }))
    return true
  } catch {
    return false // 锁文件不可读写时宁可不调度,避免重复触发
  }
}

/** "30m" / "2h" → 毫秒;非法值返回 null(该条目被跳过) */
function parseEvery(raw: string | undefined): number | null {
  const match = /^(\d+)(m|h)$/.exec(String(raw ?? "").trim())
  if (!match) return null
  const value = Number(match[1])
  if (value <= 0) return null
  return value * (match[2] === "h" ? 3600_000 : 60_000)
}

const TICK = 30_000

export default {
  id: "opencode-heartbeat",
  setup: (ctx: PluginContext) => {
    // 内存中的下次触发时刻,按「session::text」为键(改文案即重置计时)
    const nextFire = new Map<string, number>()

    const tick = async () => {
      if (!tryLead()) return // 非领导实例不调度,避免多 location 重复触发
      let beats: Beat[] = []
      try {
        beats = JSON.parse(readFileSync(CONFIG, "utf8")) as Beat[]
        if (!Array.isArray(beats)) return
      } catch {
        return // 无配置文件或 JSON 非法 = 静默空转,不报错
      }

      const now = Date.now()
      for (const beat of beats) {
        const interval = parseEvery(beat.every)
        if (!interval || !beat.session || !beat.text?.trim() || beat.enabled === false) continue

        const key = `${beat.session}::${beat.text}`
        if (!nextFire.has(key)) nextFire.set(key, now + interval)

        if (now >= (nextFire.get(key) ?? Infinity)) {
          nextFire.set(key, now + interval)
          try {
            await ctx.session.synthetic({
              sessionID: beat.session,
              description: "heartbeat 定时唤醒",
              delivery: "queue",
              resume: true,
              text: `[heartbeat 定时任务]\n${beat.text.trim()}`,
            })
            log(`fire ${beat.every} → ${beat.session}`)
          } catch (error) {
            log(`error ${beat.session}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
    }

    void tick()
    const timer = setInterval(() => void tick(), TICK)
    return () => clearInterval(timer)
  },
}
