# opencode-intercom

同一 OpenCode 服务内,让任意两个会话互相对讲——**极简实现,上下文成本趋近于零**。

## 为什么重写

参考实现(jmfirth/opencode-messaging,MIT,机制被本项目复用)注册了 **5 个常驻工具**:
每个工具的完整定义都会进入**每一个会话的每一次模型请求**,哪怕从来不用;再叠加 TUI
半边、线程视图、限速配置等一整套结构。

本插件的做法:

| | 参考实现 | opencode-intercom |
|---|---|---|
| 工具数量 | 5 个常驻 | **1 个** |
| 注册方式 | `codemode: false`(常驻目录) | **Code Mode 按需检索** |
| 不使用时的上下文成本 | 每会话持续占用 | **≈ 0**(模型需要时才检索到) |
| 文件 | src + lib×7 + TUI 半边 + 脚本 | **单文件** |
| 依赖 | 无 | 无 |

工具走 Code Mode:不进常驻工具目录,模型需要跨会话通信时通过 `execute` 检索
`intercom` 即可调用。(注意:没有 `execute` 权限的受限 agent——如 explore——无法使用。)

## 安装

```bash
npm run sync     # 复制 src/intercom.ts → ~/.config/opencode/plugins/intercom.ts
npm run unsync   # 卸载
```

改完源码重跑 `npm run sync`,新会话生效。

## 使用

### 唯一的发起入口:斜杠命令

| 命令 | 作用 |
|---|---|
| `/ask <会话标题或id> <内容>` | 向目标会话发问;内容可省略,默认请求对方简要汇报 |
| `/sessions` | 列出所有其他会话(id、标题、目录、状态) |

命令是 markdown 模板(`commands/*.md`,安装到 `~/.config/opencode/commands/`),
TUI 斜杠菜单直接可见、保存即热生效。`$1` 是目标(含空格可用引号包裹),
`$2` 是消息内容。示例:

```text
/ask 场景重生成加速
/ask m2运维 部署窗口定了吗?
/ask "标题含空格 的会话" 具体内容
/sessions
```

命令把带「[用户通过 /ask 命令发起」标记的请求交给当前会话的 agent,
由它调用 intercom 工具完成发送并把投递结果转告用户。

### agent 的边界

- **发起通信只能由人通过 `/ask` 触发**——斜杠命令只能人工输入
- agent 的 intercom 工具仅允许:① **回复**收到的 intercom 消息(按信封中的回复地址);
  ② 执行带 `/ask` 命令标记的指令;③ `list` / `read` 只读查询
- 用户用自然语言要求发消息时,agent 会引导改用 `/ask`

收到的消息长这样(带回复地址,对方回复会送回你的会话):

```
[intercom 来自会话 ses_xxx(SIM_RUN/build)「标题」]
迁移做完了,可以 rebase
[如需回复:调用 intercom 工具,action=send,session="ses_xxx"]
```

## 行为细节

- **send 不阻塞**:消息进入对方 inbox,对方在自己的对话里处理;对方被唤醒,回复稍后到达
- **delivery**:`queue`(默认,对方空闲时落地)/ `steer`(紧急打断,慎用)
- **read 零打扰**:只读对方消息历史,对方忙也能读;拒绝读自己
- **默认只允许同目录发送**,防跨项目误伤;配置 `"accept": "any"` 放开:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": [{ "package": "/Users/you/workspace/opencode-intercom", "options": { "accept": "any" } }]
}
```

(松散文件安装则无需配置,选项留默认。)

- **限速**:每会话 30 条 / 5 分钟(内存计数),防两个 agent 互相刷消息死循环
- **权限**:发送动作在运行时断言 `intercom_send` 权限(插件主动断言——声明式权限
  宿主不会自动强制),查询(list/read)不触发权限检查。折中闸门示例——仅发送需批准:

```jsonc
{ "permissions": [{ "action": "intercom_send", "resource": "*", "effect": "ask" }] }
```

批准时选「总是允许」只会放行**那一个目标会话**(断言以目标会话 id 为资源)。

## heartbeat:定时唤醒(零上下文调度器)

同仓库的第二个插件 `src/heartbeat.ts`:按用户定义的间隔向指定会话注入
唤醒消息,让它在自己的对话里执行检查任务。**不注册任何工具**,对模型
完全隐形,不占上下文;agent 没有任何接口创建调度——触发权完全在用户手里。

调度配置:`~/.config/opencode/heartbeat.json`(每 30 秒重读,改完即生效):

```json
[
  {
    "every": "30m",
    "session": "ses_xxx",
    "text": "定时检查:查看各机任务状态,无事回一句『各机正常』,有异常简要说明。",
    "enabled": true
  }
]
```

| 字段 | 说明 |
|---|---|
| `every` | 间隔:数字+m/h(5m、30m、2h) |
| `session` | 目标会话 id(用 `/sessions` 查看) |
| `text` | 唤醒时注入的指令,需自包含 |
| `enabled` | `false` 暂停该条,默认 `true` |

管理方式(与 /ask 同构,**只能由人工触发**):
- `/beat` 斜杠命令——其 shell 块在命令求值期执行,不经 agent 的工具权限流,
  agent 无法模拟:
  - `/beat` 查看全部调度
  - `/beat add 30m 会话标题或id 指令文本` 添加
  - `/beat off 2` / `/beat on 2` 暂停/恢复
  - `/beat rm 2` 删除
- 用户直接编辑 `heartbeat.json`
- 建议同时配置硬闸,阻止 agent 用文件工具改调度:

```jsonc
{ "permissions": [
  { "action": "edit", "resource": "~/.config/opencode/heartbeat.json", "effect": "deny" },
  { "action": "write", "resource": "~/.config/opencode/heartbeat.json", "effect": "deny" }
] }
```

运行记录:`~/.config/opencode/heartbeat.log`。

注意:每次唤醒都会让目标会话真实跑一轮模型(消耗 token),频率按需设置;
服务重启后从「当前时刻 + 间隔」重新起算;目标会话忙时消息排队等它空闲。

## 许可

MIT。消息注入、信封与限速的机制参考了
[jmfirth/opencode-messaging](https://github.com/jmfirth/opencode-messaging)(MIT),致谢。
