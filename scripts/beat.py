#!/usr/bin/env python3
"""heartbeat 调度管理器——仅供 /beat 命令(命令求值期 shell 块)与人工调用。

用法:
  beat.py                          列出全部调度
  beat.py add <every> <会话> <文本>  添加(every 如 30m/2h;会话可用标题关键词或 id)
  beat.py off <序号>               暂停第 N 条
  beat.py on <序号>                恢复第 N 条
  beat.py rm <序号>                删除第 N 条

输出会被 /beat 命令模板插入回执,由 agent 转告用户。
"""
import base64
import json
import re
import sys
import urllib.request
from pathlib import Path
from os.path import expanduser

CONFIG = Path(expanduser("~/.config/opencode/heartbeat.json"))


def load() -> list:
    try:
        data = json.loads(CONFIG.read_text())
        return data if isinstance(data, list) else []
    except Exception:
        return []


def save(beats: list) -> None:
    CONFIG.write_text(json.dumps(beats, ensure_ascii=False, indent=2) + "\n")


def api(path: str):
    svc = json.loads(Path(expanduser("~/.local/state/opencode/service.json")).read_text())
    req = urllib.request.Request(
        svc["url"] + path,
        headers={
            "authorization": "Basic "
            + base64.b64encode(f"opencode:{svc['password']}".encode()).decode()
        },
    )
    return json.load(urllib.request.urlopen(req, timeout=30))


def resolve(target: str):
    """精确 id 优先,否则按标题关键词唯一匹配;返回 (session, 错误信息)。"""
    sessions = api("/api/session")["data"]
    for s in sessions:
        if s.get("id") == target:
            return s, None
    matches = [s for s in sessions if target.lower() in (s.get("title") or "").lower()]
    if len(matches) == 1:
        return matches[0], None
    if not matches:
        return None, f"没有匹配「{target}」的会话(用 /sessions 查看)"
    lines = "\n".join(f"- {s['id']}「{s.get('title', '')}」" for s in matches[:8])
    return None, f"「{target}」匹配到多个会话,请更精确:\n{lines}"


def main() -> None:
    args = sys.argv[1:]
    # 经 /beat 命令 shell 块传入时,整个参数串可能是单个参数——先拆开
    if len(args) == 1 and " " in args[0]:
        import shlex

        try:
            args = shlex.split(args[0])
        except ValueError:
            pass

    beats = load()

    if not args or args[0] in ("list", "ls"):
        if not beats:
            print("(当前没有任何调度)")
        else:
            for i, b in enumerate(beats, 1):
                state = "启用" if b.get("enabled", True) else "暂停"
                print(f"{i}. [{state}] 每 {b.get('every')} → {str(b.get('session'))[:20]} | {str(b.get('text'))[:36]}")
        print()
        print("用法:")
        print("  /beat add <间隔> <会话标题或id> <指令文本>    添加调度")
        print("  /beat off <序号> / on <序号> / rm <序号>       暂停 / 恢复 / 删除")
        print("间隔写法:数字+m/h,如 5m、30m、2h")
        return

    cmd = args[0]

    if cmd == "add":
        if len(args) < 4:
            print("用法:/beat add <every 如 30m/2h> <会话标题或id> <指令文本>")
            return
        every, target, text = args[1], args[2], " ".join(args[3:])
        if not re.fullmatch(r"\d+[mh]", every):
            print(f"间隔格式不对:{every}(应为 数字+m/h,如 30m、2h)")
            return
        session, err = resolve(target)
        if err:
            print(err)
            return
        beats.append({"every": every, "session": session["id"], "text": text, "enabled": True})
        save(beats)
        print(f"已添加:每 {every} 唤醒「{session.get('title')}」({session['id']})\n指令:{text}")
        return

    if cmd in ("off", "on", "rm"):
        if len(args) < 2 or not args[1].isdigit() or not (1 <= int(args[1]) <= len(beats)):
            print(f"序号无效(当前共 {len(beats)} 条,用 /beat 查看列表)")
            return
        i = int(args[1]) - 1
        if cmd == "rm":
            removed = beats.pop(i)
            save(beats)
            print(f"已删除:每 {removed.get('every')} → {removed.get('session')}")
        else:
            beats[i]["enabled"] = cmd == "on"
            save(beats)
            print(f"第 {i + 1} 条已{'恢复' if cmd == 'on' else '暂停'}")
        return

    print(__doc__)


main()
