# 综合 E2E 场景

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。

> **前置条件**（参考 `local-test-env.md`）：
> 1. Sandbox TCP 转发已启动（`lsof -i :30040 | grep LISTEN`）
> 2. 权限已配置（`PATCH /global/config {"permission":{"bash":"allow","edit":"allow","write":"allow",...}}`）

## 十、综合 E2E 场景

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。以下用例直接用 `$BASE` `$PG_URL`，不重复定义。

### T10.1 完整开发流程：创建项目 → 验证结构 → 运行

> 验证：创建 Python 项目骨架、检查文件结构、运行代码输出 `hello`

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# Step 1: 创建项目骨架（4 个文件）
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"Create a Python project at /workspace/myapp with:\n1. myapp/__init__.py (empty)\n2. myapp/main.py with def main(): print(\"hello\")\n3. tests/__init__.py (empty)\n4. tests/test_main.py that imports myapp.main\nUse the write tool for each file."}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin, strict=False);[print(p.get('text','')[:200]) for p in d.get('parts',[]) if p.get('type')=='text']"
```

```bash
# Step 2: 检查文件结构（使用 exec API 直连沙箱）
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"find /workspace/myapp -type f -name \"*.py\" | sort"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin, strict=False);print('exit:',d.get('exitCode'));print(d.get('stdout',''))"
# 期望输出 4 个 .py 文件路径
```

```bash
# Step 3: 运行代码验证
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/myapp && python3 -c \"from myapp.main import main; main()\""}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin, strict=False);print('exit:',d.get('exitCode'));print('stdout:',d.get('stdout','').strip())"
# 期望输出: hello
```
**期望**：4 个 .py 文件创建成功，`python3` 运行输出 `hello`

> **路径说明（实测）**：prompt 指定项目根为 `/workspace/myapp`，AI 会在此目录下创建 `myapp/` 与 `tests/` 子包（标准 Python 项目结构，即 `/workspace/myapp/myapp/__init__.py`、`/workspace/myapp/tests/__init__.py` 等）。因此 `find` 应在 `/workspace/myapp` 下查找，运行需 `cd /workspace/myapp`（使 `myapp` 包可被 import）。原文档命令误用 `/workspace/tests`（与项目根平级）和 `cd /workspace`，与 prompt 语义不符，已修正。

### T10.2 完整开发流程：代码修改 + diff 验证

> 验证：修改已有文件后通过 diff 确认变更，再运行验证

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# Step 1: 创建初始文件
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"Use the write tool to create /workspace/calc.py with:\ndef add(a, b): return a + b\ndef multiply(a, b): return a * b"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin, strict=False);[print(p.get('text','')[:200]) for p in d.get('parts',[]) if p.get('type')=='text']"
```

```bash
# Step 2: 修改代码（添加 subtract 函数）
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"Use the edit tool to add a subtract function to /workspace/calc.py: def subtract(a, b): return a - b"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin, strict=False);[print(p.get('text','')[:200]) for p in d.get('parts',[]) if p.get('type')=='text']"
```

```bash
# Step 3: 验证修改结果
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && python3 -c \"from calc import add, subtract; print(add(2,3)); print(subtract(5,2))\""}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin, strict=False);print('exit:',d.get('exitCode'));print('stdout:',d.get('stdout','').strip())"
# 期望输出: 5\n3
```
**期望**：edit 工具成功修改文件，`subtract(5,2)` 输出 `3`

### T10.3 SSE 监听完整开发流程

> 验证：通过 SSE 事件流观察完整的创建→修改→执行流程

```bash
timeout 120 bun -e "
const BASE = 'http://localhost:14096'
const sess = await (await fetch(BASE + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const info = await (await fetch(BASE + '/session/' + sess.id)).json()
const DIR = info.directory
const SID = sess.id
console.log('session:', SID)

const ctrl = new AbortController()
const timer = setTimeout(() => { ctrl.abort(); console.log('⏭️ timeout'); process.exit(0) }, 110000)

const r = await fetch(BASE + '/event', { headers: { 'x-opencode-directory': DIR }, signal: ctrl.signal })
const reader = r.body.getReader()
const decoder = new TextDecoder()
const eventLog = []

setTimeout(async () => {
  // 先创建文件
  await fetch(BASE + '/session/' + SID + '/message', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: 'Use the write tool to create /workspace/hello.py with: print(\"hello from SSE test\")' }], model: { providerID: 'Yd-DeepSeek', modelID: 'deepseek-v4-flash' } })
  })
}, 500)

while (true) {
  try {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value)
    const blocks = chunk.split('\n\n').filter(l => l.trim())
    for (const block of blocks) {
      const line = block.split('\n').find(l => l.startsWith('data: '))
      if (!line) continue
      const evt = JSON.parse(line.slice(6))
      const p = evt.payload || evt
      eventLog.push({ type: p.type, time: new Date().toISOString().slice(11,19) })

      if (p.type === 'permission.asked') {
        await fetch(BASE + '/session/' + SID + '/permissions/' + p.properties.id, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ response: 'always' })
        })
      }

      if (p.type === 'file.edited') {
        console.log('📄 file.edited:', p.properties.file)
      }

      if (p.type === 'session.idle') {
        clearTimeout(timer)
        const types = [...new Set(eventLog.map(e => e.type))].sort()
        const timeline = eventLog.map(e => e.time + ' ' + e.type).join('\\n')
        console.log('--- Event Timeline ---')
        console.log(timeline)
        console.log('--- Summary ---')
        console.log('total events:', eventLog.length)
        console.log('unique types:', types.length)
        console.log('types:', types.join(', '))
        const hasFileEdit = types.includes('file.edited')
        const hasMsgUpdate = types.some(t => t.startsWith('message.'))
        const hasSessionIdle = types.includes('session.idle')
        console.log(hasFileEdit && hasMsgUpdate && hasSessionIdle ? '✅ E2E SSE flow verified' : '❌ missing events')
        await reader.cancel()
        process.exit(0)
      }
    }
  } catch(e) { if (!ctrl.signal.aborted) console.error(e); break }
}
"
```
**期望**：SSE 事件时间线包含 `server.connected` → `message.*` → `file.edited` → `session.idle` 完整流程

### T10.4 多轮对话上下文保持

> 验证：多轮对话中 LLM 能记住前几轮的上下文

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# Round 1: 设定上下文
echo "=== Round 1 ==="
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"Remember this secret number: 42. Just reply OK."}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin, strict=False);[print(p.get('text','')[:100]) for p in d.get('parts',[]) if p.get('type')=='text']"

# Round 2: 验证记忆
echo "=== Round 2 ==="
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"What was the secret number I told you?"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin, strict=False);[print(p.get('text','')[:100]) for p in d.get('parts',[]) if p.get('type')=='text']"
```
**期望**：Round 2 回答包含 `42`

---

## 测试结果

| 用例 | 结果 | 备注 |
|------|------|------|
| T10.1 | ✅ | 4 个 .py 文件创建成功，`python3 -c "from myapp.main import main; main()"` 输出 hello |
| T10.2 | ✅ | edit 工具添加 subtract 函数，`subtract(5,2)` 输出 3 |
| T10.3 | ✅ | SSE 监听 79 个事件、14 种类型，含 file.edited 完整时间线 |
| T10.4 | ✅ | Round 1 设定 42，Round 2 正确回忆 42 |

> **复测记录（2026-09-16，镜像 `person-model-connect`（feat/opencode-1.18.31 工作区：个人模型隔离 + 公共优先 + provider 脱敏 + autokeepalive），本地 PG + 远端 K8s 沙箱，真实 LLM `Yd-DeepSeek/deepseek-v4-flash`）**：T10.1–T10.4 全部通过。**本轮 AI 消息统一改走流式接口**（`POST /session/:id/prompt_stream`，即 `test-lib.sh` 的 `stream_prompt`，实时渲染正文增量 + `[tool]` 状态流转），断言仍以 exec API / 消息终态为准：
>
> | 用例 | 结果 | 备注 |
> |---|---|---|
> | T10.1 | ✅ | 流式观察 write×4 → exec 验证 4 个 .py → 运行输出 `hello` |
> | T10.2 | ✅ | 流式 write → 流式 edit（subtract）→ exec 输出 `5`/`3` |
> | T10.3 | ✅ | `/event` SSE 监听 59 个事件、11 种类型，含 `file.edited` → `session.idle` 完整时间线（该用例本体即流式，保持原同步触发） |
> | T10.4 | ✅ | 两轮流式对话，Round 2 终态回复 `42` |
>
> 附注：autokeepalive 下 session 创建即启动沙箱，T10.1/T10.2 的首次工具调用无沙箱冷启动等待。

> **复测记录（2026-10-12，镜像 `opencode-saas-sandbox-test:152c8587db`，组合 1（远端 PG + 远端 K8s 沙箱），模型切换为 `Yd-GLM/glm-5.3`（非默认 deepseek-v4-flash），文档原文 prompt）：T10.1–T10.4 全部通过。**
>
> | 用例 | 结果 | 备注 |
> |---|---|---|
> | T10.1 | ✅ | write×4 落盘（`/workspace/myapp/{myapp,tests}/` 4 个 .py，exec `find` 实锤）；exec 运行 `from myapp.main import main; main()` 输出 `hello`。AI 总结自报 pytest 未装属环境现状，不影响断言 |
> | T10.2 | ✅ | write(calc.py) → read+edit(completed) 添加 subtract；exec 输出 `5` / `3` |
> | T10.3 | ✅ | `/event` SSE 监听 210 个事件、13 种类型，`server.connected` → `message.*` → `file.edited` → `session.idle` 完整时间线；本轮出现 `permission.asked`（脚本自动应答 `always`，随后 `permission.replied`），判定脚本原有应答逻辑生效 |
> | T10.4 | ✅ | Round 1 回复 `OK`，Round 2 正确回答 `42` |
>
> 附注：T10.3 的 bun 脚本（`t103_sse.mjs`）本轮以文件方式执行，模型字段替换为 Yd-GLM/glm-5.3，其余逻辑与文档原文一致（含 `join('\n')` 时间线输出的原语义）。

