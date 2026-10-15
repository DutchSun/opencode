# SSE 事件流

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置见 [`00-preamble.md`](./00-preamble.md)。运行用例前先 `source test-env.sh 3 && source test-lib.sh`（以下用例直接使用 `$BASE`/`$MODEL`/`jexec`）。



## 九、SSE 事件流

**事件格式差异**：
- 全局 SSE：`data: {"directory":"...","project":"...","payload":{"id":"...","type":"...","properties":{}}}\n\n`
- 实例 SSE：`data: {"id":"...","type":"...","properties":{}}\n\n`
- 会话 SSE（`GET /session/:id/event`，格式同实例 SSE）：仅推送 `properties.sessionID` 匹配该会话的事件，sessionID 在路径中自动路由、无需 `x-opencode-directory` 头

**通用采集脚本**：所有 SSE 用例统一使用 [`scripts/sse-dump.mjs`](./scripts/sse-dump.mjs)（订阅 → 输出拍平后的事件 JSON 行，全局/实例格式已统一）：

```bash
# 标准三段式：后台订阅 → 执行业务动作 → 断言事件日志
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" <采集秒数> "$DIR" > /tmp/sse.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/sse.log 2>/dev/null && break; sleep 0.5; done   # 等订阅建立
# ... 业务动作（curl 发消息等）...
wait $SSE_PID
# grep/jq 断言 /tmp/sse.log
```

实例级 `/event` 需要先取 `DIR`：

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")
```

---

### T9.1 全局事件流：订阅与初始连接事件

> 验证：响应头、初始 `server.connected` 事件

```bash
curl -s -N --max-time 3 -D - -o /dev/null "$BASE/global/event" | grep -i "content-type\|cache-control"

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/global/event" 3 > /tmp/t91.log
head -1 /tmp/t91.log | jexec "d.get('type')"
```
**期望**：`content-type` 含 `text/event-stream`，`cache-control` 为 `no-cache, no-transform`，首个事件 `type` 为 `server.connected`

---

### T9.2 全局事件流：创建 session 触发事件

> 验证：全局 SSE 能收到 session 生命周期事件

```bash
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/global/event" 12 > /tmp/t92.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t92.log 2>/dev/null && break; sleep 0.5; done

curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' > /dev/null
wait $SSE_PID

grep -m1 '"type":"session.created"' /tmp/t92.log
```
**期望**：收到 `session.created` 事件，包含 `sessionID`

---

### T9.3 全局事件流：心跳机制

> 验证：约 10 秒后收到 `server.heartbeat`

```bash
time bun docs/test-cases/scripts/sse-dump.mjs "$BASE/global/event" 12 > /tmp/t93.log
grep -c server.heartbeat /tmp/t93.log
```
**期望**：`server.heartbeat` ≥ 1（首次心跳约 10s）

---

### T9.4 实例事件流：订阅与初始连接事件

> 验证：实例级 SSE 连接、`x-opencode-directory` 头、初始事件

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

curl -s -N --max-time 3 -D - -o /dev/null -H "x-opencode-directory: $DIR" "$BASE/event" | grep -i content-type
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 3 "$DIR" > /tmp/t94.log
head -1 /tmp/t94.log | jexec "d.get('type')"
```
**期望**：`content-type` 为 `text/event-stream`，首个事件 `type` 为 `server.connected`

### T9.5 实例事件流：会话消息事件（message.part.updated）

> 验证：LLM 响应过程中 SSE 推送消息相关事件

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 50 "$DIR" > /tmp/t95.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t95.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 45 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"说一个字\"}],\"model\":$MODEL}" > /dev/null
wait $SSE_PID

grep -c '"type":"message.part.updated"\|"type":"message.part.delta"' /tmp/t95.log
grep -c '"type":"session.idle"' /tmp/t95.log
```
**期望**：`message.part.updated`/`message.part.delta` ≥ 1（事件含 `properties.sessionID`），`session.idle` ≥ 1

### T9.6 实例事件流：工具调用事件

> 验证：工具调用的 SSE 生命周期事件（pending → running → completed/error）

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 80 "$DIR" > /tmp/t96.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t96.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 75 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行 echo hello_sse_test\"}],\"model\":$MODEL}" > /dev/null
wait $SSE_PID

# 提取 tool part 的状态流转
python3 -c "
import json
stats = []
for line in open('/tmp/t96.log'):
    part = json.loads(line).get('properties', {}).get('part', {})
    if part.get('type') == 'tool':
        stats.append(part.get('state', {}).get('status'))
print('tool statuses:', stats)
print('has lifecycle:', 'pending' in stats and any(s in stats for s in ('running','completed','error')))
"
```
**期望**：收到 `message.part.updated`（`part.type === 'tool'`），状态流转 `pending` → `running` → `completed`（或 `error`，取决于 sandbox 环境）

### T9.7 实例事件流：权限请求事件

> 验证：`permission.asked` 事件通过 SSE 推送，并可程序化回复

> **前提**：不要在全局 config 中配 `permission.edit: allow`（否则不会触发 `permission.asked`）。如果已配，可临时移除：
> ```bash
> curl -s -X PATCH "$BASE/global/config" \
>   -H 'Content-Type: application/json' \
>   -d '{"permission":{"bash":"allow","edit":"ask","write":"ask","glob":"allow","grep":"allow","list":"allow","read":"allow","webfetch":"allow"}}'
> ```
>
> **根因说明**：`evaluate()` 默认返回 `{ action: "ask" }`。当 config 未配置 permission 时，所有工具调用都需权限确认。HTTP API 模式下无 UI 回复权限请求，工具会卡在 `running` 状态。本用例通过 SSE 监听 `permission.asked` 后自动回复来验证。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 80 "$DIR" > /tmp/t97.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t97.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 75 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"use the write tool to write hello to /workspace/sse-perm-test.txt\"}],\"model\":$MODEL}" > /dev/null &

# 轮询日志捕获 permission.asked 并自动回复
for i in $(seq 1 40); do
  PLINE=$(grep -m1 '"type":"permission.asked"' /tmp/t97.log 2>/dev/null)
  if [ -n "$PLINE" ]; then
    PID=$(echo "$PLINE" | jexec "d['properties']['id']")
    echo "permission.asked id=$PID"
    curl -s -X POST "$BASE/session//permissions/" \
      -H 'Content-Type: application/json' -d '{"response":"always"}'
    echo "replied: always"
    break
  fi
  sleep 2
done
wait $SSE_PID 2>/dev/null
```
**期望**：收到 `permission.asked` 事件并成功回复（若 `edit` 权限已配 `allow` 则 session 正常完成无权限弹窗）

### T9.8 实例事件流：多会话事件隔离

> 验证：两个 session 的事件通过 `sessionID` 正确路由，无交叉污染

```bash
SID_A=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
SID_B=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID_A" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 60 "$DIR" > /tmp/t98.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t98.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 55 -X POST "$BASE/session/$SID_A/message" \
  -H 'Content-Type: application/json' -d "{\"parts\":[{\"type\":\"text\",\"text\":\"说A\"}],\"model\":$MODEL}" > /dev/null &
curl -s --max-time 55 -X POST "$BASE/session/$SID_B/message" \
  -H 'Content-Type: application/json' -d "{\"parts\":[{\"type\":\"text\",\"text\":\"说B\"}],\"model\":$MODEL}" > /dev/null &
wait $SSE_PID

python3 -c "
import json
a=b=0
for line in open('/tmp/t98.log'):
    sid = json.loads(line).get('properties',{}).get('sessionID')
    a += sid == '$SID_A'; b += sid == '$SID_B'
print(f'A events: {a}, B events: {b}')
print('✅ both > 0' if a>0 and b>0 else '❌')
"
```
**期望**：两个 session 各自收到事件（计数 > 0），事件 `sessionID` 无交叉

### T9.9 实例事件流：会话状态变更事件（session.status / session.idle）

> 验证：LLM 处理期间 `session.status` 事件，完成后 `session.idle` 事件

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 50 "$DIR" > /tmp/t99.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t99.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 45 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' -d "{\"parts\":[{\"type\":\"text\",\"text\":\"说一个字\"}],\"model\":$MODEL}" > /dev/null
wait $SSE_PID

grep -o '"type":"session\.\(status\|idle\)"' /tmp/t99.log | sort | uniq -c
```
**期望**：先收到 `session.status`（busy），完成后收到 `session.idle`

### T9.10 实例事件流：异步 prompt 触发事件

> 验证：`POST /session/:id/prompt_async` 返回 204，事件通过 SSE 推送

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 50 "$DIR" > /tmp/t910.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t910.log 2>/dev/null && break; sleep 0.5; done

curl -s -o /dev/null -w "prompt_async: %{http_code}\n" -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' -d "{\"parts\":[{\"type\":\"text\",\"text\":\"说一个字\"}],\"model\":$MODEL}"
wait $SSE_PID

grep -c '"type":"message.part.updated"\|"type":"message.part.delta"' /tmp/t910.log
```
**期望**：`prompt_async` 返回 204，SSE 收到 `message.part.updated` / `message.part.delta`

### T9.11 实例事件流：文件变更事件

> 验证：文件写入操作触发 `file.edited` / `file.watcher.updated` 事件

> **前提**：
> 1. Sandbox TCP 转发必须启动（`lsof -i :30040 | grep LISTEN`），否则 write 工具卡在 sandbox 初始化
> 2. 权限需配 `edit: allow`（通过 `PATCH /global/config {"permission":{"edit":"allow",...}}`），否则工具卡在权限等待
> 3. 写文件路径必须在项目目录内（如 `/workspace/`），写 `/tmp/` 会触发 `external_directory` 权限
>
> **根因说明**：write 工具通过 `ctx.sandbox` 在沙箱中执行写操作，sandbox 不可达时 Promise 永远 pending（工具显示 `running`）。默认权限 `"ask"` 无 UI 回复也会卡住。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 80 "$DIR" > /tmp/t911.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t911.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 75 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"use the write tool to write hello to /workspace/sse-file-test.txt\"}],\"model\":$MODEL}" > /dev/null &

# 若出现权限请求则自动回复（同 T9.7）
for i in $(seq 1 40); do
  PLINE=$(grep -m1 '"type":"permission.asked"' /tmp/t911.log 2>/dev/null)
  if [ -n "$PLINE" ]; then
    PID=$(echo "$PLINE" | jexec "d['properties']['id']")
    curl -s -X POST "$BASE/session//permissions/" \
      -H 'Content-Type: application/json' -d '{"response":"always"}' > /dev/null
    break
  fi
  grep -q '"type":"file.edited"\|"type":"file.watcher.updated"' /tmp/t911.log 2>/dev/null && break
  sleep 2
done
wait $SSE_PID 2>/dev/null

grep -m1 '"type":"file.edited"\|"type":"file.watcher.updated"' /tmp/t911.log
```
**期望**：收到 `file.edited` 或 `file.watcher.updated` 事件（sandbox 可达 + 权限已配 `allow` 时）

### T9.12 全局事件流：dispose 事件

> 验证：`POST /global/dispose` 触发 `server.instance.disposed` 事件

```bash
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/global/event" 8 > /tmp/t912.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t912.log 2>/dev/null && break; sleep 0.5; done

curl -s -o /dev/null -w "dispose: %{http_code}\n" -X POST "$BASE/global/dispose"
wait $SSE_PID

grep -i disposed /tmp/t912.log
```
**期望**：收到含 `disposed` 的事件，或连接被服务端关闭

### T9.13 实例事件流：连接断开后重连

> 验证：SSE 连接可重复建立，每次都收到 `server.connected`

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 3 "$DIR" > /tmp/t913a.log
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 3 "$DIR" > /tmp/t913b.log
head -1 /tmp/t913a.log | jexec "d.get('type')"
head -1 /tmp/t913b.log | jexec "d.get('type')"
```
**期望**：两次连接都收到 `server.connected`

### T9.14 实例事件流：多客户端监听同一会话

> 验证：一个会话执行任务时，多个 SSE 客户端同时监听都能收到相同的事件序列

> **场景**：模拟多用户（如编辑器 + 终端 + CI 监控）同时通过 SSE 观察同一个会话的执行过程。验证 Bus 的 PubSub 模式能正确广播到所有订阅者。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

# 3 个客户端并行监听
for c in a b c; do
  bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 55 "$DIR" > /tmp/t914$c.log &
done
for c in a b c; do
  for i in $(seq 1 20); do grep -q server.connected /tmp/t914$c.log 2>/dev/null && break; sleep 0.5; done
done

curl -s --max-time 50 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"say hello in one sentence\"}],\"model\":$MODEL}" > /dev/null
wait

for c in a b c; do
  echo "client $c: $(grep -c '"type":"message\.' /tmp/t914$c.log) message events, idle=$(grep -c session.idle /tmp/t914$c.log)"
done
```
**期望**：3 个 SSE 客户端都收到 `server.connected`、至少一个 `message.*` 事件、`session.idle`，且事件类型列表一致

### T9.15 实例事件流：中途加入的客户端收到后续事件

> 验证：会话执行过程中新连接的 SSE 客户端能收到后续事件（不要求回放历史）

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

# 客户端 A：一开始就连接
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 55 "$DIR" > /tmp/t915a.log &
for i in $(seq 1 20); do grep -q server.connected /tmp/t915a.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 50 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"say hello\"}],\"model\":$MODEL}" > /dev/null &

# 客户端 B：2 秒后中途加入
sleep 2
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 50 "$DIR" > /tmp/t915b.log &
wait

echo "A: $(wc -l < /tmp/t915a.log) events"
echo "B: $(wc -l < /tmp/t915b.log) events"
grep -c '"type":"message\.' /tmp/t915b.log
```
**期望**：客户端 B 中途加入后仍能收到 `server.connected` 和后续事件（`session.idle` 等）

> **实测结论（有据）**：B 中途加入能收到完整事件流（含 `message.part.*`、`tool`、`session.idle`），多次受控实验验证通过。
>
> **偶发现象（未复现）**：测试中曾出现 2 次"B 只收到 `server.connected` + `server.heartbeat`、无任何 `message` 事件"。随后 **28 轮多角度压力复现**（常规 dispose+中途订阅 / 激进 dispose+0.5s+B 1s / T9.14 3并发SSE+T9.15 完整序列）**全部 0 失败**，无法稳定复现。统计上若真实失败率 ≥10%，28 轮全过的概率仅 5%，故失败率大概率 <10%。
>
> **根因未定位**：在无稳定复现路径前，不对根因下任何结论。曾推测的 takeUntil 终止 / dispose 重建窗口 / T9.14 累积状态，均**未被复现验证支持，已撤回**。
>
> **再次出现时的抓取方法**：给 `packages/opencode/src/bus/index.ts` 的 `subscribing`/`publishing` 日志补 `directory` 字段（`yield* InstanceState.directory`），即可判断失败 SSE 流的"订阅实例"与"message publish 实例"是否错位。

---

### T9.16 实例事件流：会话更新与删除事件（session.updated / session.deleted）

> 验证：`PATCH /session/:id` 触发 `session.updated`，`DELETE /session/:id` 触发 `session.deleted`

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 20 "$DIR" > /tmp/t916.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t916.log 2>/dev/null && break; sleep 0.5; done

curl -s -X PATCH "$BASE/session/$SID" -H 'Content-Type: application/json' -d '{"title":"sse-updated"}' > /dev/null
curl -s -X DELETE "$BASE/session/$SID" > /dev/null
wait $SSE_PID

grep -m1 '"type":"session.updated"' /tmp/t916.log | jexec "d['properties']['info']['title']"
grep -c '"type":"session.deleted"' /tmp/t916.log
```
**期望**：收到 `session.updated`（`properties.info.title=sse-updated`）与 `session.deleted`（计数 ≥1）

### T9.17 实例事件流：消息删除事件（message.removed / message.part.removed）

> 验证：删除消息/part 触发 `message.removed` / `message.part.removed`

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")
curl -s --max-time 45 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' -d "{\"parts\":[{\"type\":\"text\",\"text\":\"hi\"}],\"model\":$MODEL}" > /dev/null

MID=$(curl -s "$BASE/session/$SID/message" | python3 -c "
import json,sys
msgs=json.load(sys.stdin, strict=False)
print([m for m in msgs if m.get('info',{}).get('role')=='assistant'][-1]['info']['id'])
")
PID=$(curl -s "$BASE/session/$SID/message" | python3 -c "
import json,sys
msgs=json.load(sys.stdin, strict=False)
print(msgs[-1]['parts'][0]['id'])
")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 15 "$DIR" > /tmp/t917.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t917.log 2>/dev/null && break; sleep 0.5; done

curl -s -X DELETE "$BASE/session/$SID/message/$MID" > /dev/null
wait $SSE_PID

grep -c '"type":"message.removed"' /tmp/t917.log
```
**期望**：删除消息后收到 `message.removed`（计数 ≥1）；`message.part.removed` 需通过删 part 端点触发（`DELETE /session/:id/message/:mid/part/:pid`），两者均可选验证

### T9.18 实例事件流：消息状态事件（message.updated）

> 验证：`POST /session/:id/prompt_async` 消息处理完成后触发 `message.updated`

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 50 "$DIR" > /tmp/t918.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t918.log 2>/dev/null && break; sleep 0.5; done

curl -s -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' -d "{\"parts\":[{\"type\":\"text\",\"text\":\"说一个字\"}],\"model\":$MODEL}" > /dev/null
wait $SSE_PID

grep -c '"type":"message.updated"' /tmp/t918.log
```
**期望**：收到 `message.updated` ≥ 1（assistant 消息落库时触发）

### T9.19 实例事件流：会话错误事件（session.error）

> 验证：非法模型 ID 发送消息触发 `session.error`

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 20 "$DIR" > /tmp/t919.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t919.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 15 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hi"}],"model":{"providerID":"Yd-DeepSeek","modelID":"nonexistent-model-xyz"}}' > /dev/null
wait $SSE_PID

grep -m1 '"type":"session.error"' /tmp/t919.log | jexec "d['properties'].get('error',{}).get('name')"
```
**期望**：收到 `session.error` 事件（`properties.error` 含错误信息；非法模型实测触发 `UnknownError`，可能与预期 `ProviderModelNotFoundError` 有差异，事件发出即可）

### T9.20 实例事件流：diff 事件（session.diff）

> 验证：`POST /session/:id/revert` 触发 `session.diff`
>
> ⚠️ **revert 必须传 `messageID`**（来自会话中的 user 消息）。空 body 时 revert 找不到目标消息，直接返回不发布 diff 事件。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")
curl -s --max-time 45 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' -d "{\"parts\":[{\"type\":\"text\",\"text\":\"hi\"}],\"model\":$MODEL}" > /dev/null
MID=$(curl -s "$BASE/session/$SID/message" | python3 -c "
import json,sys
msgs=json.load(sys.stdin, strict=False)
u=[m for m in msgs if m.get('info',{}).get('role')=='user'][0]
print(u['info']['id'])
")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 20 "$DIR" > /tmp/t920.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t920.log 2>/dev/null && break; sleep 0.5; done

curl -s -X POST "$BASE/session/$SID/revert" -H 'Content-Type: application/json' -d "{\"messageID\":\"$MID\"}" > /dev/null
wait $SSE_PID

grep -c '"type":"session.diff"' /tmp/t920.log
```
**期望**：收到 `session.diff` ≥ 1（`properties.diff` 为 diff 数组，可为空数组）

### T9.21 实例事件流：agent/model 切换事件

> 验证：`session.agent.switched` / `session.model.switched` 事件
>
> **触发路径说明（实测确认）**：这两个事件由 V2 `Session.switchModel` / `Session.switchAgent` 发布（`packages/core/src/session.ts`）。**HTTP PATCH `/session/:id` 的 `UpdatePayload` 不支持 `model`/`agent` 字段**（仅 directory/title/metadata/permission/time.archived），PATCH model 会被静默忽略、不触发任何事件。当前 HTTP API 层无直接 switch 端点，事件由 LLM 工具调用（如 TUI/CLI 侧切换）或内部流程触发。本用例标记为**待补端点后验证**，当前通过 `session.updated`（T9.16）覆盖会话级变更。

```bash
# 待 HTTP switch 端点就绪后执行。当前 PATCH model 不会触发事件：
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 25 "$DIR" > /tmp/t921.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t921.log 2>/dev/null && break; sleep 0.5; done

# PATCH model 不会触发 session.model.switched（UpdatePayload 不支持 model 字段）
curl -s -X PATCH "$BASE/session/$SID" -H 'Content-Type: application/json' \
  -d '{"model":{"providerID":"Yd-DeepSeek","modelID":"glm-4.6"}}' > /dev/null
wait $SSE_PID

echo "model.switched count: $(grep -c '"type":"session.model.switched"' /tmp/t921.log) (期望 0，见说明)"
echo "session.updated count: $(grep -c '"type":"session.updated"' /tmp/t921.log)"
```
**期望**：PATCH model 因 `UpdatePayload` 不支持被静默忽略，`session.model.switched`=0、`session.updated`=0。待 HTTP switch 端点就绪后，再验证 `session.model.switched`（`properties.model.modelID` 为新模型）与 `session.agent.switched`

### T9.22 实例事件流：资源生命周期事件（command.executed / todo.updated / mcp.tools.changed）

> 验证：自定义命令执行、todo 更新、MCP server 连接分别触发对应事件

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 25 "$DIR" > /tmp/t922.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t922.log 2>/dev/null && break; sleep 0.5; done

# 创建并执行自定义命令（CommandCreatePayload 用 template 字段；执行 payload 必填 command 字段）
curl -s -X POST "$BASE/session/$SID/commands/create" \
  -H 'Content-Type: application/json' -d '{"name":"sse-test-cmd","description":"t","template":"say hi","agent":"build","model":"Yd-DeepSeek/deepseek-v4-flash"}' > /dev/null
curl -s -X POST "$BASE/session/$SID/command" \
  -H 'Content-Type: application/json' -d '{"command":"sse-test-cmd","arguments":""}' > /dev/null
wait $SSE_PID

grep -c '"type":"command.executed"' /tmp/t922.log
```
**期望**：执行自定义命令收到 `command.executed` ≥ 1。`todo.updated`（AI 更新 todo 时）与 `mcp.tools.changed`（MCP server 连接/断开时）为按需补充验证项

### T9.23 全局事件流：事件 envelope 字段完整性

> 验证：全局 SSE 事件的 `directory`/`project`/`payload` 字段结构
>
> ⚠️ 不能用 `sse-dump.mjs`（它会拍平 payload 层）。必须用原始 curl 查看未拍平的行。

```bash
curl -s -N --max-time 8 "$BASE/global/event" > /tmp/t923raw.log &
CURL_PID=$!
sleep 2
curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' > /dev/null
wait $CURL_PID

python3 -c "
import re
for line in open('/tmp/t923raw.log'):
    m = re.search(r'data: (.+)', line)
    if not m: continue
    raw = m.group(1)
    if 'session.created' in raw:
        print(raw[:300]); break
"
```
**期望**：全局事件为 `{"directory":"/workspace","project":"global","payload":{"id":"evt_*","type":"session.created","properties":{...}}}`，`directory`/`project`/`payload` 三者齐全

### T9.24 实例事件流：事件 ID 格式

> 验证：事件 `id` 为 `evt_*` 前缀，且连接生命周期事件与业务事件一致

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 10 "$DIR" > /tmp/t924.log
python3 -c "
import json, itertools
for line in itertools.islice(open('/tmp/t924.log'), 3):
    d = json.loads(line)
    print(d.get('id','?'), d.get('type','?'))
"
```
**期望**：事件含 `id`（`evt_*` 前缀），类型分别为 `server.connected` / `server.heartbeat`

### T9.25 实例事件流：负向测试（缺 x-opencode-directory 头）

> 验证：无 `x-opencode-directory` 头时实例 SSE 的行为
>
> **实测结论**：缺头时 middleware 回退到 `Flag.OPENCODE_DEFAULT_DIRECTORY`（`/workspace`），**仍返回 200 + `server.connected`**，属于正常连接而非拒绝。因此负向判定标准是「事件仍能收到，但归属默认目录」，而非连接被拒。

```bash
# 无头请求：应返回 200 + text/event-stream + server.connected
curl -s -N --max-time 3 -D - "$BASE/event" | head -3
```
**期望**：HTTP 200、`content-type: text/event-stream`、首行 `server.connected`（回退默认目录连接成功）。若未来行为改为 400 拒绝，则标准同步调整

### T9.26 实例事件流：write 工具参数早期可用性（running 态预渲染）

> 验证：web 端「HTML/PPT 生成边写边看」模式的数据基础 —— write tool part 在 `running` 态（参数生成完毕、工具刚要执行）即携带完整 `state.input.content`，前端可在 **completed 之前、整个回合（session.idle）之前** 渲染 HTML，无需等 `POST /message` 同步返回
>
> 背景：tool part 状态机为 `pending`（LLM 生成参数中，input 为空）→ `running`（参数完整，`input.filePath`/`input.content` 全量可用，**此时即可预渲染**）→ `completed`（文件已写盘，`state.output`/`metadata` 就位）。pending 阶段无参数增量事件（`tool-input-delta` 在 V1 链路被丢弃），仅能显示进度提示。
>
> **前提**（同 T9.11）：
> 1. Sandbox TCP 转发已启动（`lsof -i :30040 | grep LISTEN`）
> 2. write 权限配 `allow`（或依赖本用例的 permission.asked 自动回复）
> 3. 写入路径在项目目录内（`/workspace/`）

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 150 "$DIR" > /tmp/t926.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t926.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 140 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"use ONLY the write tool (not bash) to create /workspace/prerender-test.html containing a minimal HTML page with title 'sse prerender test' and one heading\"}],\"model\":$MODEL}" > /dev/null &

# 权限自动回复（write 未配 allow 时）
for i in $(seq 1 60); do
  PLINE=$(grep -m1 '"type":"permission.asked"' /tmp/t926.log 2>/dev/null)
  if [ -n "$PLINE" ]; then
    curl -s -X POST "$BASE/session//permissions/" \
      -H 'Content-Type: application/json' -d '{"response":"always"}' > /dev/null
    break
  fi
  grep -q '"type":"session.idle"' /tmp/t926.log 2>/dev/null && break
  sleep 2
done
wait $SSE_PID 2>/dev/null

python3 -c "
import json
writes = []   # (行号, status, content长度, output非空)
idle_line = None
for n, line in enumerate(open('/tmp/t926.log')):
    d = json.loads(line)
    if d.get('type') == 'session.idle':
        idle_line = n
    if d.get('type') != 'message.part.updated': continue
    part = d.get('properties', {}).get('part', {})
    if part.get('type') != 'tool' or part.get('tool') != 'write': continue
    state = part.get('state', {})
    writes.append((
        n,
        state.get('status'),
        len(state.get('input', {}).get('content') or ''),
        bool(state.get('output')),
    ))

statuses = [w[1] for w in writes]
print('write statuses:', statuses)
running = next((w for w in writes if w[1] == 'running'), None)
completed = next((w for w in writes if w[1] == 'completed'), None)

assert 'pending' in statuses, '缺少 pending 事件'
assert running, '缺少 running 事件'
assert running[2] > 0 and '<html' in json.dumps(open('/tmp/t926.log').readlines()[running[0]]).lower(), 'running 态 input.content 应含完整 HTML'
assert completed, '缺少 completed 事件'
assert running[0] < completed[0], 'running 应早于 completed'
assert completed[3], 'completed 应有 output'
if idle_line: assert running[0] < idle_line, 'running 应早于 session.idle（回合未结束即可渲染）'
print('✅ running 态 content=%d 字节，行号 running=%d < completed=%d%s' % (
    running[2], running[0], completed[0], f' < idle={idle_line}' if idle_line is not None else ''))
"
```
**期望**：write tool part 依次出现 `pending` → `running` → `completed`；`running` 态事件已携带完整 `input.content`（含 `<html`，字节数 > 0），且其出现顺序早于 `completed` 与 `session.idle` —— 即前端收到 running 事件即可 iframe 预渲染（srcdoc/blob），早于工具执行完成与整个回合结束

### T9.27 实例事件流：工具参数流式增量（message.part.delta / field=raw）

> 验证：方案 A —— LLM 生成工具参数期间（pending 阶段），processor 将参数 JSON 片段节流（200ms）推送为 `message.part.delta`（`field: "raw"`），前端可在参数生成过程中实时预览正在写的 HTML（PPT 场景"边写边看"）
>
> 背景：服务端在 `tool-input-delta` 分支累积参数文本并节流 flush（`processor.ts` 的 `flushToolInput`），经 `updatePartDelta` 发内存事件（不落库，刷新/回放不重放）；`running` 态 `part.updated` 仍为定稿值。本用例需镜像包含该改动（`opencode-saas-sandbox-test:tool-input-stream` 及之后）。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 150 "$DIR" > /tmp/t927.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t927.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 140 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"use ONLY the write tool (not bash) to create /workspace/stream-test.html containing an HTML page with title 'stream test' and three paragraphs\"}],\"model\":$MODEL}" > /dev/null &

for i in $(seq 1 70); do
  PLINE=$(grep -m1 '"type":"permission.asked"' /tmp/t927.log 2>/dev/null)
  if [ -n "$PLINE" ]; then
    curl -s -X POST "$BASE/session//permissions/" \
      -H 'Content-Type: application/json' -d '{"response":"always"}' > /dev/null
    break
  fi
  grep -q '"type":"session.idle"' /tmp/t927.log 2>/dev/null && break
  sleep 2
done
wait $SSE_PID 2>/dev/null

python3 -c "
import json
raw_deltas = []    # (行号, partID, delta)
write_running = None
for n, line in enumerate(open('/tmp/t927.log')):
    d = json.loads(line)
    if d.get('type') == 'message.part.delta':
        p = d.get('properties', {})
        if p.get('field') == 'raw': raw_deltas.append((n, p.get('partID'), p.get('delta') or ''))
    if d.get('type') == 'message.part.updated':
        part = d.get('properties', {}).get('part', {})
        if part.get('type') == 'tool' and part.get('tool') == 'write' and part.get('state', {}).get('status') == 'running':
            write_running = (n, part['id'], part['state']['input'])

assert len(raw_deltas) >= 2, f'raw delta 应多条（节流推送），实际 {len(raw_deltas)}'
assert write_running, '缺少 write running 事件'
rid, rpart, rinput = write_running
delta_parts = [x for x in raw_deltas if x[1] == rpart]
assert delta_parts, 'raw delta 的 partID 应匹配 write tool part'
assert max(x[0] for x in delta_parts) < rid, 'raw delta 应全部早于 running 定稿'
raw = ''.join(x[2] for x in delta_parts)
assert rinput.get('filePath') in raw and rinput.get('content', '')[:40] in raw.replace('\\\\n', chr(10)).replace('\\\\\"', '\"'), '拼接 raw 应覆盖完整参数'
print('✅ %d 条 raw delta（partID 匹配），拼接 %d 字节，全部早于 running 定稿（行 %d）' % (len(delta_parts), len(raw), rid))
"
```
**期望**：pending 期间收到 **≥2 条** `message.part.delta`（`field: "raw"`，partID 与 write tool part 一致，节流 200ms 批量）；拼接后包含完整参数（filePath + content）；全部早于 `running` 态 `message.part.updated`。前端消费模式：SSE 按 partID 累积 raw → 容错提取 `content` 字段尾部（部分 JSON，需处理 `\n`/`\"` 转义）→ 实时渲染；收到 running `part.updated` 后丢弃 raw 用 `state.input` 定稿

---

### T9.28 会话事件流：订阅与初始连接事件（GET /session/:id/event）

> 验证：按会话过滤的 SSE 端点（REST 风格子资源）。与实例级 `/event` 的区别：`sessionID` 在路径中，自动完成 workspace 路由，**无需 `x-opencode-directory` 头**
>
> **前提**：镜像需包含 session 事件流端点（`session.event`）。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

curl -s -N --max-time 3 -D - -o /dev/null "$BASE/session/$SID/event" | grep -i "content-type\|cache-control"
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/session/$SID/event" 3 > /tmp/t928.log
head -1 /tmp/t928.log | jexec "d.get('type')"
```
**期望**：`content-type` 含 `text/event-stream`、`cache-control` 为 `no-cache, no-transform`；首个事件 `type` 为 `server.connected`（事件格式与实例 `/event` 一致：`{"id","type","properties"}`）

---

### T9.29 会话事件流：只推该会话的事件（隔离性）

> 验证：同一实例下两个 session，订阅 A 的会话流，B 的事件不得进入
>
> 设计：用 PATCH title 触发 `session.updated`（轻量、不依赖 LLM/sandbox）。两个 session 在订阅**前**创建完毕，避免 `session.created` 干扰断言。

```bash
SID_A=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
SID_B=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
sleep 1

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/session/$SID_A/event" 12 > /tmp/t929.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t929.log 2>/dev/null && break; sleep 0.5; done

curl -s -X PATCH "$BASE/session/$SID_A" -H 'Content-Type: application/json' -d '{"title":"sse-a-updated"}' > /dev/null
curl -s -X PATCH "$BASE/session/$SID_B" -H 'Content-Type: application/json' -d '{"title":"sse-b-updated"}' > /dev/null
wait $SSE_PID

echo "updated count: $(grep -c '"type":"session.updated"' /tmp/t929.log) (期望 1)"
grep -m1 '"type":"session.updated"' /tmp/t929.log | jexec "d['properties']['sessionID']"
echo "B leak: $(grep -c "$SID_B" /tmp/t929.log) (期望 0)"
```
**期望**：`session.updated` 恰好 1 条且 `properties.sessionID` 为 `SID_A`；整份日志中 `SID_B` 出现 0 次（B 的 `session.updated` 被 server 端过滤，而非客户端过滤）

---

### T9.30 会话事件流：负向测试（session 不存在）

> 验证：不存在的 sessionID 返回 404（handler 内 `requireSession` 校验）

```bash
curl -s -o /dev/null -w "%{http_code}\n" -N --max-time 3 "$BASE/session/ses_httpapi_missing/event"
```
**期望**：`404`

---

### T9.31 会话事件流：发送异步消息并监听事件（POST /session/:id/prompt_stream）

> 验证：「发送异步消息」+「监听会话事件」合并接口。一次请求：服务端发起异步 prompt 并返回 SSE 流，客户端直接消费该回合的事件，**回合结束（session.idle）后服务端主动关流**，无需客户端自己编排 prompt_async + event 两步
>
> **前提**：镜像需包含 `session.prompt_stream` 端点。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

START=$(date +%s)
curl -s -N --max-time 90 -D /tmp/t931-headers.txt "$BASE/session/$SID/prompt_stream" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"只回复两个字：收到\"}],\"model\":$MODEL}" > /tmp/t931.log
CURL_EXIT=$?
END=$(date +%s)
echo "curl_exit=$CURL_EXIT elapsed=$((END-START))s"
grep -i "content-type" /tmp/t931-headers.txt

python3 -c "
import re, json
types = re.findall(r'\"type\":\"([a-z.\-]+)\"', open('/tmp/t931.log').read())
print('total events:', len(types))
print('has idle:', 'session.idle' in types)
print('idle is last:', types[-1] == 'session.idle' if types else False)
"
```
**期望**：`HTTP 200` + `content-type: text/event-stream`；流内含完整回合事件（`server.connected` → `message.*` / `session.status`(busy) → `session.status`(idle) → `session.idle`）；**`session.idle` 为最后一帧且 curl_exit=0**（服务端在回合结束后主动关流，而非 --max-time 截断）。prompt 发起失败时通过流内 `session.error` 事件体现（与 prompt_async 语义一致）

---

### T9.32 会话事件流：prompt_stream 错误路径（session.error + 关流）

> 验证：非法模型发送 prompt_stream 时，`session.error` 事件通过流推送，且回合终止后流仍以 `session.idle` 正常关闭（错误不影响流生命周期管理）

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

START=$(date +%s)
curl -s -N --max-time 60 "$BASE/session/$SID/prompt_stream" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hi"}],"model":{"providerID":"Yd-DeepSeek","modelID":"nonexistent-model-xyz"}}' > /tmp/t932.log
CURL_EXIT=$?
END=$(date +%s)
echo "curl_exit=$CURL_EXIT elapsed=$((END-START))s"

grep -o '"type":"session.error"' /tmp/t932.log | head -1
grep -o '"name":"[^"]*"' /tmp/t932.log | head -1
python3 -c "
import re
types = re.findall(r'\"type\":\"([a-z.\-]+)\"', open('/tmp/t932.log').read())
print('idle-last:', types[-1] == 'session.idle' if types else False)
"
```
**期望**：流内依次出现 `session.error`（`properties.error.name=UnknownError`，与 T9.19 一致）与 `session.idle`；**idle 为最后帧且 curl_exit=0**（错误回合同样触发服务端关流，客户端不会挂死）

---

### T9.33 会话事件流：prompt_stream 多会话并发隔离

> 验证：两个 session 同时执行 prompt_stream，各自的流只包含本会话事件（`properties.sessionID` 无交叉），且各自独立关流
>
> **注意**：sessionID 含大写字母，正则字符类须用 `[A-Za-z0-9]`（实测踩坑：`[a-z0-9]` 会漏配得出"空集"的假象）

```bash
SID_A=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
SID_B=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

curl -s -N --max-time 60 "$BASE/session/$SID_A/prompt_stream" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"只回复A"}],"model":$MODEL}' > /tmp/t933a.log &
PA=$!
sleep 0.3
curl -s -N --max-time 60 "$BASE/session/$SID_B/prompt_stream" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"只回复B"}],"model":$MODEL}' > /tmp/t933b.log &
PB=$!
wait $PA $PB

python3 -c "
import re
for name, sid, f in [('A','$SID_A','/tmp/t933a.log'),('B','$SID_B','/tmp/t933b.log')]:
    content = open(f).read()
    sids = set(re.findall(r'\"sessionID\":\"(ses_[A-Za-z0-9]+)\"', content))
    types = re.findall(r'\"type\":\"([a-z.\-]+)\"', content)
    idle_last = types[-1] == 'session.idle' if types else False
    leak = sids - {sid}
    print(f'{name}: idle-last={idle_last}, cross-leak={leak or \"none\"}')
"
```
**期望**：A/B 两条流各自 `sessionID` 集合只含本会话（cross-leak=none），均以 `session.idle` 结尾并独立关流（curl_exit=0）

---

### T9.34 会话事件流：prompt_stream 负向测试（session 不存在）

> 验证：不存在的 sessionID 调用 prompt_stream 返回 404（`requireSession` 先于流建立）

```bash
curl -s -o /dev/null -w "%{http_code}\n" -N --max-time 3 \
  -X POST "$BASE/session/ses_httpapi_missing/prompt_stream" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hi"}],"model":$MODEL}'
```
**期望**：`404`

---

### T9.35 会话事件流：断连续传（GET /session/:id/event?after=\<seq\>）

> 验证：SSE 断连窗口内错过的 durable 事件可通过 `?after=` 补发 —— 「快照-002 卡死」问题（前端断连后 UI 停在"思考中"，刷新才恢复）的服务端修复。durable 事件（`session.created/updated/deleted`、`message.updated/removed`、`message.part.updated/removed`，aggregate=sessionID）持久化在 `event` 表；非 durable 事件（`message.part.delta`/`session.diff`/`session.error`）不补发，由客户端重连后 refetch 对齐。
>
> **修复内容**（`handlers/session.ts` subscribeEvents + `handlers/event.ts` eventResponse）：
> 1. `?after=<seq>`：连接时先从 `event` 表补发 `seq > after` 的 durable 事件（不经过 location 过滤），再接实时流；实时侧丢弃 `seq <= liveAfterSeq` 的事件防重复（补发/实时衔接窗口零重复）
> 2. SSE 事件新增顶层 `seq` 字段（durable 事件为自增序号，非 durable/连接级事件无此字段）——客户端记录收到的最大 seq 作为重连游标
> 3. location 过滤容错：无 `location` 的事件（全局/replay 路径发布）不再被静默丢弃（`eventVisible`）
>
> **前提**：镜像/本地代码含 `SessionEventQuery`（session.event 端点 query 加 `after`）。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

# 客户端 A：连接后立即断开（模拟断连）
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/session/$SID/event" 3 > /tmp/t935a.log
grep -c server.connected /tmp/t935a.log

# 断连窗口内产生 durable 事件（session.updated）
curl -s -X PATCH "$BASE/session/$SID" -H 'Content-Type: application/json' -d '{"title":"t935-gap"}' > /dev/null

# 场景1：不带 after 重连 → 不回放（原行为回归）
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/session/$SID/event" 3 > /tmp/t935b.log
echo "no-after updated count (期望 0): $(grep -c session.updated /tmp/t935b.log)"

# 场景2：带 after=-1 全量补发
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/session/$SID/event?after=-1" 3 > /tmp/t935c.log
python3 -c "
import json
types = [json.loads(l)['type'] for l in open('/tmp/t935c.log')]
print('types:', types)
assert types[0] == 'server.connected'
assert types.count('session.created') == 1 and types.count('session.updated') == 1, '补发恰好各一次'
"

# 场景3：after=0 部分补发（跳过 seq=0 的 created）
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/session/$SID/event?after=0" 3 > /tmp/t935d.log
echo "after=0: created=$(grep -c session.created /tmp/t935d.log) (期望 0), updated=$(grep -c session.updated /tmp/t935d.log) (期望 1)"

# 场景4：负向参数
curl -s -o /dev/null -w "after=-5: %{http_code}\n" --max-time 3 "$BASE/session/$SID/event?after=-5"
curl -s -o /dev/null -w "after=abc: %{http_code}\n" --max-time 3 "$BASE/session/$SID/event?after=abc"
```
**期望**：
- 场景1：无 after 时 0 条 `session.updated`（不回放，保持原行为）
- 场景2：`server.connected → session.created → session.updated`，各恰好一次
- 场景3：`created=0, updated=1`（部分续传只补 after 之后的事件）
- 场景4：非法 after（<-1 / 非数字）返回 `400`
- 补发事件带顶层 `seq` 字段（durable 事件），客户端可用作下次重连游标

---

### T9.36 会话事件流：断连续传并发窗口（补发/实时衔接不丢不重）

> 验证：`?after=` 补发进行时新事件持续产生（listener 已注册、store 边界 target 已定）——补发与实时流衔接窗口事件**零丢失、零重复**。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
curl -s -X PATCH "$BASE/session/$SID" -H 'Content-Type: application/json' -d '{"title":"t936-1"}' > /dev/null
curl -s -X PATCH "$BASE/session/$SID" -H 'Content-Type: application/json' -d '{"title":"t936-2"}' > /dev/null

# 连接（after=-1 全量补发）后立刻并发 PATCH 3 次
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/session/$SID/event?after=-1" 12 > /tmp/t936.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t936.log 2>/dev/null && break; sleep 0.5; done
for i in 1 2 3; do curl -s -X PATCH "$BASE/session/$SID" -H 'Content-Type: application/json' -d "{\"title\":\"t936-c$i\"}" > /dev/null; done
wait $SSE_PID

python3 -c "
import json
updates = []
for l in open('/tmp/t936.log'):
    d = json.loads(l)
    if d['type'] == 'session.updated': updates.append(d.get('seq'))
updates.sort()
print('seqs:', updates)
assert updates == [1,2,3,4,5], f'补发(1,2)+并发(3,4,5) 应恰好各一次, 实际 {updates}'
print('✅ 衔接窗口零丢失零重复')
"
```
**期望**：`session.updated` 的 seq 序列恰好为 `[1,2,3,4,5]`（补发 1,2 + 实时 3,4,5，各一次）

---

### T9.37 实例事件流：无 location 事件不再被静默丢弃（eventVisible 容错）

> 验证：`eventResponse` 的 location 过滤语义修正 —— 无 `location` 的事件（replay 路径/全局服务发布）此前被 `event.location?.directory === instance.directory` 无条件丢弃（心跳照发、连接看似健康，最难排查）。修复后无 location 事件放行，有 location 且不匹配的仍被隔离。
>
> 单测覆盖（`packages/opencode/test/server/httpapi-event.test.ts` 的 `eventVisible` describe，5 个用例）：
> 1. 有 location + directory 不匹配 → 拒绝（隔离语义保留）
> 2. 有 location + directory 匹配 → 放行
> 3. **无 location → 放行**（修复点）
> 4. workspaceID 匹配/不匹配 → 对应放行/拒绝
> 5. 调用方 filter（如 sessionEventFilter）叠加生效
>
> ```bash
> cd packages/opencode && bun test test/server/httpapi-event.test.ts
> ```
> **期望**：`eventVisible` describe 下 5 个用例全部通过（`delivers instance events` 的 fail 为 SQLite fixture 既有基线问题，与本项无关）

---

## 测试结果

| 用例 | 结果 | 备注 |
|------|------|------|
| T9.1 | ✅ | content-type、cache-control、server.connected 均验证通过 |
| T9.2 | ✅ | 全局 SSE 收到 session.created 事件 |
| T9.3 | ✅ | 10.0s 后收到 server.heartbeat |
| T9.4 | ✅ | 实例级 SSE 需 x-opencode-directory 头 |
| T9.5 | ✅ | 收到 message.part.updated 等 8 种事件类型 |
| T9.6 | ✅ | 工具生命周期 pending→running→error（sandbox 环境下 bash 可能 error） |
| T9.7 | ✅ | `permission.asked` 事件通过 SSE 推送，可程序化回复。需权限未配 `allow` 时触发 |
| T9.8 | ✅ | 两个 session 各自收到事件，无交叉 |
| T9.9 | ✅ | session.status(×4) → session.idle |
| T9.10 | ✅ | prompt_async 返回 204，SSE 正常推送 |
| T9.11 | ✅ | 收到 `file.edited` 事件。前提：sandbox 转发已启动 + 权限配 `edit:allow` + 写项目目录内路径 |
| T9.12 | ✅ | 收到 server.instance.disposed 事件 |
| T9.13 | ✅ | 断开重连均收到 server.connected |
| T9.14 | ✅ | 3 个 SSE 客户端同时监听，均收到相同 10 种事件类型 |
| T9.15 | ✅ | 中途加入收到完整事件流；曾现偶发"B 只收 connected+heartbeat"（28 轮未复现，详见用例备注） |
| T9.16 | ✅ | session.updated（PATCH title）/ session.deleted（DELETE）均收到 |
| T9.17 | ✅ | message.removed（删消息收到）；message.part.removed 走删 part 端点 |
| T9.18 | ✅ | message.updated（异步消息落库触发 6 次） |
| T9.19 | ✅ | session.error（非法模型触发，error.name=UnknownError） |
| T9.20 | ✅ | session.diff（revert 需传 messageID 才触发） |
| T9.21 | ⚠️ 待端点 | session.model.switched 走 V2 switchModel，HTTP PATCH 的 UpdatePayload 不支持 model 字段（静默忽略，不触发事件），待 switch 端点就绪后验证 |
| T9.22 | ✅ | command.executed（执行 payload 需 `command` 字段，创建用 `template` 字段） |
| T9.23 | ✅ | 全局事件 envelope 为 `{directory,project,payload}`（需原始 curl，sse-dump 会拍平） |
| T9.24 | ✅ | 事件 id 为 `evt_*` 前缀 |
| T9.25 | ✅ | 缺 x-opencode-directory 头时回退默认目录（OPENCODE_DEFAULT_DIRECTORY），仍返回 200 + server.connected，非拒绝 |
| T9.26 | ✅ | write tool part pending→running→completed；running 态即含完整 input.content（155B HTML），顺序 running < completed < session.idle，web 端可在回合结束前预渲染 |
| T9.27 | ✅ | pending 期间 5 条 message.part.delta（field=raw，partID 匹配，拼接 354B 完整参数），全部早于 running 定稿；镜像 tool-input-stream，改动后 T9.26 回归通过 |
| T9.28 | ✅ | content-type=text/event-stream、cache-control=no-cache, no-transform、首事件 server.connected；无需 x-opencode-directory 头 |
| T9.29 | ✅ | session.updated 恰好 1 条且属于 SID_A，SID_B 全日志 0 泄漏（server 端过滤生效） |
| T9.30 | ✅ | 不存在 sessionID 返回 404 |
| T9.31 | ✅ | prompt_stream 一次请求完成发送+监听：200 + text/event-stream，13 个事件（connected→message.*→status(busy)→status(idle)→session.idle），idle 为最后帧且服务端主动关流（curl_exit=0，7s） |
| T9.32 | ✅ | 非法模型：session.error（error.name=UnknownError）照常推送，流仍以 session.idle 关流（curl_exit=0，<1s），客户端不挂死 |
| T9.33 | ✅ | A/B 并发 prompt_stream 各自 sessionID 无交叉（cross-leak=none），均独立以 idle 关流；注意 sessionID 含大写字母，正则须 [A-Za-z0-9] |
| T9.34 | ✅ | 不存在 sessionID 的 prompt_stream 返回 404 |
| T9.35 | ✅ | after 续传：无 after 0 回放（原行为）、after=-1 全量补发各一次、after=0 部分补发（created=0/updated=1）、非法 after 400；补发事件带顶层 seq 游标 |
| T9.36 | ✅ | 并发衔接窗口 seqs=[1,2,3,4,5]，补发(1,2)+实时(3,4,5) 零丢失零重复 |
| T9.37 | ✅ | eventVisible 5 个单测通过（无 location 放行 / 有 location 隔离保留 / workspace 过滤 / 调用方 filter 叠加） |

> 注：T9.16-T9.25 为覆盖补全用例，已在本轮验证（组合 1：远端 PG + 远端 Sandbox）。T9.21 的 `session.agent.switched`/`session.model.switched` 需 HTTP switch 端点就绪后验证；`todo.updated`/`mcp.tools.changed` 为按需补充项。

> 注：2026-07-17 重构为标准三段式（sse-dump.mjs 后台订阅 + 业务动作 + 日志断言），原始内联 bun 脚本见 git 历史。

> 复测记录（2026-09-06，组合 3：本地 PG + 本地 OpenSandbox，镜像 `opencode-saas-sandbox-test:t0906-tool-input-stream`）：**T9.1–T9.27 全部通过**（T9.21 为待端点项，PATCH model 静默忽略 0/0 符合记录）。本轮差异点：
> - T9.7：write /workspace 沙箱写默认放行，`permission.asked`=0，走文档期望的另一分支（无弹窗、正常完成，`file.edited`/`session.diff`/`session.idle` 俱全）
> - T9.12：`POST /global/dispose` 返回 200 并推送 `server.instance.disposed` + `global.disposed`；dispose 后 session API 仍 200（实例自愈），后续用例不受影响
> - T9.15：首次用 "say hello" 短任务时 B 只收到 connected+heartbeat（2s 内 message 已结束，SSE 不回放历史——符合设计）；改用 150 词故事长任务后 B 收到 109 message 事件 + idle。**B 加入时机必须在执行中**，用例 prompt 不宜过短
> - T9.24：文档原 python 命令 `open(...)[...]` 有文件对象切片 bug，实测用 `itertools.islice` 替代执行；建议修文档
> - T9.26/T9.27：在新镜像复测通过，且 T9.26 日志中可直接看到 4 条 raw delta（方案 A 生效）

> 复测记录（2026-09-07，**本地新代码直跑**：`bun run ./src/index.ts serve --port 14098` + 本地 PG `127.0.0.1:15432`，未走镜像）：**T9.28–T9.30 全部通过**。隔离性（T9.29）用 PATCH title 触发 `session.updated`，实测 A 流恰好 1 条事件且 sessionID 为 A，SID_B 泄漏 0；T9.30 返回 404。注意 `/session/:id/event` 由 sessionID 路径参数完成 workspace 路由，`sse-dump.mjs` 第三个 directory 参数不传。

> 复测记录（2026-09-07，同上环境，真实 LLM `Yd-DeepSeek/deepseek-v4-flash`）：**T9.31 通过**。`POST /session/:id/prompt_stream` 返回 200 + text/event-stream，流内 13 个事件完整覆盖回合生命周期，`session.idle` 为最后帧且服务端主动关流（curl_exit=0，耗时 7s）。

> 复测记录（2026-09-07，同上环境）：**T9.32–T9.34 通过**。T9.32 错误回合实测事件序列 `...→session.status(busy)→session.error→session.status(idle)→session.idle`（error.name=UnknownError），idle 关流 curl_exit=0；T9.33 并发双流 sessionID 零交叉、独立关流；T9.34 返回 404。新增端点说明：`GET /session/:id/event` 见 T9.28–T9.30。

> 复测记录（2026-09-07，本地 PG + 远端沙箱，镜像含 NUL guard 修复（`db.pg.ts` 剥离 jsonb 参数 `\u0000`，详见 structured-output.md 复测记录））：**T9.28–T9.34 回归全部通过**（含 T9.31/32/33 的完整 LLM 回合、错误路径关流与并发隔离）。

> 复测记录（2026-09-12，**本地新代码直跑**：`bun run ./src/index.ts serve --port 14098` + 远端 PG 转发 `127.0.0.1:15432`）：**T9.35–T9.37 全部通过**，origin 为「快照-002」会话卡死排查（前端断连后 UI 停在"思考中" 1103s，刷新才恢复；服务端事件完整入库）。本轮变更：
> - `GET /session/:id/event` 新增 `?after=<seq>` 断连续传：durable 事件（session/message/part 的 created/updated/removed）从 `event` 表补发后接实时流，衔接窗口经 `liveAfterSeq` 去重（T9.36 seqs=[1,2,3,4,5] 验证零丢失零重复）
> - SSE 事件新增顶层 `seq` 字段（客户端重连游标）；非 durable 事件（`message.part.delta` 等）不补发，由客户端 refetch 对齐
> - `eventVisible` 提取 + 无 `location` 事件放行（此前被静默丢弃）
> - 回归：T9.1/T9.3/T9.4/T9.5/T9.30 及 T9.29 隔离性（恰好 1 条 updated、零泄漏）均通过；`eventVisible` 单测 5/5（`httpapi-event.test.ts`，`delivers instance events` 的 fail 为 SQLite fixture 既有基线，与本轮无关）
> - 前端配套（待前端侧落地）：断连重连时对活跃会话带 `?after=<lastSeq>`；配合心跳看门狗（>25~30s 无字节即重建连接）

> **复测记录（2026-09-16，镜像 `person-model-connect`（feat/opencode-1.18.31 工作区：个人模型隔离 + 公共优先 + provider 脱敏 + autokeepalive），本地 PG + 远端 K8s 沙箱，真实 LLM `Yd-DeepSeek/deepseek-v4-flash`）：T9.1–T9.37 全部通过**（T9.21 为待端点项，PATCH model 静默忽略 0/0 符合记录）。要点：
> - T9.5 消息事件 34 条、T9.8 双会话 A=45/B=48 无交叉、T9.14 三客户端均收全事件、T9.15 中途加入 B 收 120 条 message 事件 + idle
> - T9.7 走「write 默认放行」分支（无 permission.asked，正常完成，文档允许）
> - T9.26 write running 态 155B HTML（running=31 < completed=34 < idle=65 行号序）；T9.27 5 条 raw delta 拼接 354B 全部早于 running 定稿
> - T9.31 prompt_stream 45 事件 idle 末帧 curl=0（3s）；T9.32 错误回合 err+idle 正常关流；T9.33 双流零交叉
> - T9.35 四场景（无 after 不回放 / after=-1 全量各一次 / after=0 部分补发 / 非法 400×2）；T9.36 seqs=[1,2,3,4,5]
> - T9.37 `eventVisible` 5/5；`delivers instance events`/`keeps the event stream open` 2 个 fail 为 SQLite fixture 既有基线（stash 基线对比同样 2 fail，非本轮引入）
> - 执行提示：整批脚本易因 SSE 窗口叠加超时，建议按 5-8 个用例分批执行；T9.25 断言勿用 `head -3` 截断头（content-type 在第 4 行）

> **复测记录（2026-10-12，镜像 `opencode-saas-sandbox-test:t1012`（HEAD `152c8587db` + 工作区 flag.ts 改动，含 periodic snapshot refresh commit），组合 1（远端 PG + 远端 K8s 沙箱），真实 LLM `Yd-GLM/glm-5.3`，分 10 批执行）：T9.1–T9.37 全部通过**（T9.21 为待端点项，PATCH model 静默忽略 0/0 符合记录）。要点：
> - T9.5 消息事件 64 条、T9.6 bash `pending→running→completed` 完整流转、T9.8 双会话 A=72/B=63 无交叉、T9.14 三客户端均 62 条 message 事件、T9.15 中途加入 B 收 250 条 message 事件 + idle
> - T9.7 走「write 默认放行」分支（permission.asked=0，file.edited + idle 俱全，文档允许）
> - T9.26 running 态 162B HTML（running=83 < completed=84 < idle=121 行号序）；T9.27 **24 条** raw delta 拼接 383B 全部早于 running 定稿
> - T9.31 prompt_stream 34 事件 idle 末帧 curl=0（11s，回复「收到」语义断言通过）；T9.32 错误回合 UnknownError + idle 正常关流（3s）；T9.33 双流零交叉独立关流
> - T9.35 四场景（无 after 不回放 / after=-1 全量各一次 / after=0 部分补发 / 非法 400×2）；T9.36 seqs=[1,2,3,4,5] 零丢失零重复；T9.37 `eventVisible` 6 pass / 2 fail（`keeps the event stream open` / `delivers instance events` 超时，SQLite fixture 既有基线，与 09-16 stash 对比一致）
>
> **本轮差异与踩坑（4 项，均非功能缺陷）**：
> 1. **T9.11 / T9.26 首跑 write 挂 running**（2 次）：write 参数定稿后工具执行挂起（终态停 running、文件未落盘），同 session 稍后 exec 连通正常——远端 K8s 沙箱偶发不可达，write Promise 无重试挂死（文档前提已知症状）。重跑均通过；**缓解：长用例前先 exec warmup 预热沙箱**。另注意：write 挂死时若脚本收尾杀掉后台同步 curl，会连带触发 `Tool execution aborted`（首跑 T9.11 的 abort 即此因），业务 curl 应 `wait` 自然结束
> 2. **T9.16 `session.deleted` 偶发丢失**（首跑 + 一次复测共 2 次，随后三路对照 + 2 连跑共 4 次全收到）：DELETE 返回 200 但会话流未推 deleted。已定位机制——`Session.remove` 的 `events.remove(sessionID)` 清除 `event_sequence` 行，`event.aggregate_id` 的 DEFERRED FK CASCADE 会把刚写入的 deleted 事件行级联清掉（表内已确认 0 行），会话流 catch-up 查表时拿不到；实时 notify 路径正常（三路全局/实例/会话流均收到）。定性偶发时序窗口，建议跟进：deleted 事件的 durable 补发与行级联清理的竞态
> 3. **T9.25 断言修正**：curl 原始 body 首行是 SSE 分帧空行，且 `data: ` 前缀需剥离后再 JSON 解析（直接 `head -1 | jexec` 判空误报 FAIL），用 `grep -m1 '^data:' | sed 's/^data: //'` 取首事件
> 4. **新镜像启动日志新增周期性 ERROR**（与 SSE 无关，记录在案）：`periodic snapshot scan query failed`——HEAD snapshot refresh commit 的扫描查询用 jsonb 操作符 `session.sandbox->>'persistMode'`，但远端 PG 该列为 `text`（`operator does not exist: text ->> unknown`）。prompt/SSE/工具链路不受影响；需给远端 PG 跑列类型迁移或代码侧兼容
>
> 执行提示补充：write 类长用例（T9.26/T9.27）窗口 150s 且参数生成（GLM-5.3 流式写 HTML）占约 60-90s，SSE 采集窗口要覆盖到 `session.idle`，判定脚本注意 `wait` 同步 curl 后再收尾。

---
