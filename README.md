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

### 推荐入口:斜杠命令(纯人工输入,最不易误触发)

| 命令 | 作用 |
|---|---|
| `/ask <会话标题或id> <内容>` | 向目标会话发问;内容可省略,默认请求对方简要汇报 |
| `/sessions` | 列出所有其他会话(id、标题、目录、状态) |

示例:

```text
/ask 场景重生成加速
/ask m2运维 部署窗口定了吗?
/ask "标题含空格 的会话" 具体内容
/sessions
```

命令由人在 TUI 里输入才会触发——agent 的工具目录里没有命令,
物理上无法误触发;命令会向当前会话注入一条带明确授权的指令,
由 agent 调用 intercom 工具完成发送并把投递结果转告用户。

### 备用入口:自然语言

在任何会话里直接说:

> 「看看当前目录还有哪些会话在跑」→ `intercom action=list`
> 「读一下 XXX 会话最近的对话」→ `intercom action=read`
> 「告诉 XXX 会话:迁移做完了,可以 rebase」→ `intercom action=send`

### agent 自发消息:仅限回信

工具描述中内置纪律:agent 只允许在用户明确要求时发送,或回复收到的
intercom 消息;禁止未经指示的主动汇报/通知/状态更新。

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
- **权限**:工具断言 `intercom` 动作,可按需管控:

```jsonc
{ "permissions": [{ "action": "intercom", "resource": "*", "effect": "ask" }] }
```

## 许可

MIT。消息注入、信封与限速的机制参考了
[jmfirth/opencode-messaging](https://github.com/jmfirth/opencode-messaging)(MIT),致谢。
