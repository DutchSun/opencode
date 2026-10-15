# 结构化输出（Structured Output / format json_schema）

> 相关接口：`POST /session/:id/message`（同步）、`POST /session/:id/prompt_async`（异步）、`POST /session/:id/prompt_stream`（发送+监听合并接口，见 sse.md T9.31）。
>
> **接口范围**：`format` 仅 `PromptInput` 携带，`command` / `shell` 端点（`CommandInput`/`ShellInput`）**不支持**结构化输出。
>
> 用法：请求体带 `format: {type: "json_schema", schema: <JSON Schema>, retryCount?: 2}`。服务端注入 `StructuredOutput` 工具 + `toolChoice: required` 强制模型按 schema 产出；结果落在 assistant 消息 `info.structured` 字段。`type: "text"`（或不传 format）为普通文本模式。
>
> 运行用例前先 `source ../test-env.sh 3 && source ../test-lib.sh`（以下用例直接使用 `$BASE`/`$MODEL`/`$PG_URL`/`jexec`）。
>
> **环境前提**：镜像需包含 format 读回修复（`message-v2.ts` 的 `info()` 对存储 format re-decode）。修复前症状：带 format 的 user 消息落库后 `GET /session/:id/message` 返回 400（`Expected OutputFormatJsonSchema`）——根因是 `OutputFormat` 为 `Schema.Class` union，HTTP 响应 encode 需要类实例，而 PG bridge 读回的是普通 JSON 对象。
>
> ⚠️ **请求体书写**：含 `$MODEL` 的 JSON 必须用双引号转义写法（`-d "{\"model\":$MODEL,...}"`）。单引号 heredoc 内 `$MODEL` 不展开，会发出字面量非法 JSON 得到 400（首轮全量执行实测踩坑）。

---

### TSO.1 同步接口：format 透传与 structured 结果

> 验证：`POST /session/:id/message` 带 format，响应 assistant 消息 `info.structured` 符合 schema

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"北京是中国的首都吗？\"}],\"model\":$MODEL,\"format\":{\"type\":\"json_schema\",\"schema\":{\"type\":\"object\",\"properties\":{\"answer\":{\"type\":\"boolean\"},\"city\":{\"type\":\"string\"}},\"required\":[\"answer\",\"city\"]}}}" \
  | jexec "d['info'].get('structured')"
```
**期望**：`{"answer": true, "city": "北京"}`（值由模型生成，结构与 required 字段一致；`finish` 为 `tool-calls` 属正常——structured 已产出）

---

### TSO.2 消息回读：format/structured 经 GET 完整返回（列表 + 单条）

> 验证：带 format 的 user 消息落库后，`GET /session/:id/message`（列表）与 `GET /session/:id/message/:messageID`（单条）均正常返回（修复回归用例，两条读路径共用 `info()`）

```bash
# 先按 TSO.1 发一条带 format 的消息，然后：
curl -s -o /tmp/tso2.json -w "list GET %{http_code}\n" "$BASE/session/$SID/message"
python3 -c "
import json
msgs = json.load(open('/tmp/tso2.json'), strict=False)
user = next(m for m in msgs if m['info']['role'] == 'user')
assistant = next(m for m in msgs if m['info']['role'] == 'assistant')
print('user.format:', (user['info'].get('format') or {}).get('type'))
print('assistant.structured:', json.dumps(assistant['info'].get('structured'), ensure_ascii=False))
print('user MID:', user['info']['id'])
"

MID=<上方输出的 user MID>
curl -s -o /tmp/tso2b.json -w "single GET %{http_code}\n" "$BASE/session/$SID/message/$MID"
python3 -c "
import json
d = json.load(open('/tmp/tso2b.json'), strict=False)
print('single user.format:', (d['info'].get('format') or {}).get('type'))
"
```
**期望**：两次 GET 均 200；列表与单条的 `user.format` 均为 `json_schema`；`assistant.structured` 与 TSO.1 一致。修复前列表 400（`Expected OutputFormatJsonSchema ... at [0]["info"]["format"]`）

---

### TSO.3 异步接口：prompt_async + 轮询 structured 落库

> 验证：`prompt_async` 返回 204，structured 异步落库可轮询

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
curl -s -o /dev/null -w "prompt_async=%{http_code}\n" -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"天空是什么颜色？单个中文词回答\"}],\"model\":$MODEL,\"format\":{\"type\":\"json_schema\",\"schema\":{\"type\":\"object\",\"properties\":{\"color\":{\"type\":\"string\"}},\"required\":[\"color\"]}}}"

for i in $(seq 1 40); do
  R=$(curl -s "$BASE/session/$SID/message" | python3 -c "
import json,sys
msgs = json.load(sys.stdin, strict=False)
a = [m for m in msgs if m.get('info',{}).get('role')=='assistant']
s = a[-1]['info'].get('structured') if a else None
print(json.dumps(s, ensure_ascii=False) if s else 'WAIT')
" 2>/dev/null)
  [ "$R" != "WAIT" ] && [ -n "$R" ] && { echo "structured: $R"; break; }
  sleep 2
done
```
**期望**：`prompt_async=204`；轮询最终拿到 `structured`（如 `{"color": "蓝色"}`）

---

### TSO.4 prompt_stream：流内推送 structured

> 验证：合并接口（sse.md T9.31）带 format，`message.updated` 事件携带 structured，流以 idle 关闭

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

curl -s -N --max-time 120 "$BASE/session/$SID/prompt_stream" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"一周有几天？\"}],\"model\":$MODEL,\"format\":{\"type\":\"json_schema\",\"schema\":{\"type\":\"object\",\"properties\":{\"days\":{\"type\":\"integer\"}},\"required\":[\"days\"]}}}" \
  > /tmp/tso4.log
echo "curl_exit=$?"

python3 -c "
import json, re
structured = None
for line in open('/tmp/tso4.log'):
    m = re.match(r'data: (.+)', line)
    if not m: continue
    try: ev = json.loads(m.group(1))
    except: continue
    if ev.get('type') == 'message.updated':
        s = ev.get('properties', {}).get('info', {}).get('structured')
        if s: structured = s
print('stream structured:', json.dumps(structured, ensure_ascii=False))
types = re.findall(r'\"type\":\"([a-z.\-]+)\"', open('/tmp/tso4.log').read())
print('idle-last:', types[-1] == 'session.idle')
"
```
**期望**：`curl_exit=0`；流内 `message.updated` 携带 structured（如 `{"days": 7}`）；`session.idle` 为最后帧

---

### TSO.5 负向：非法 format 请求被 400 拒绝

> 验证：format type 非法（非 text/json_schema）或 schema 值非法时，请求体 decode 失败

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

# 变体 1：非法 type
curl -s -o /tmp/tso5.json -w "bad type http=%{http_code}\n" --max-time 15 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"hi\"}],\"model\":$MODEL,\"format\":{\"type\":\"xml\",\"schema\":{}}}"
jexec "d['name']" < /tmp/tso5.json

# 变体 2：schema 值非对象
curl -s -o /dev/null -w "bad schema http=%{http_code}\n" --max-time 15 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"hi\"}],\"model\":$MODEL,\"format\":{\"type\":\"json_schema\",\"schema\":42}}"
```
**期望**：两个变体均 `http=400`；变体 1 报 `Expected OutputFormat, got {"type":"xml"...}`（kind=Payload）

---

### TSO.6 显式 text format：普通文本模式不受影响

> 验证：`format: {"type":"text"}` 显式传文本模式，行为与不传 format 一致（无 StructuredOutput 工具介入）

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

curl -s --max-time 60 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"只回复两个字：收到\"}],\"model\":$MODEL,\"format\":{\"type\":\"text\"}}" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
print('structured:', d['info'].get('structured'))
print('has text reply:', any(p.get('type')=='text' and p.get('text') for p in d.get('parts',[])))
"
```
**期望**：`structured` 为 null；assistant 正常返回文本 part（无结构化介入）

---

### TSO.7 存量脏数据容错：非法 format 不炸消息列表

> 验证：修复引入的容错分支——存储中的 format 若为历史/脏数据（decode 失败），`GET /session/:id/message` 丢弃该字段返回 200，而非 400
>
> **前提**：能直连测试 PG（`$PG_URL`）

```bash
SID=<任一带 format user 消息的 session>
psql "$PG_URL" -c "
UPDATE message SET data = jsonb_set(data, '{format}', '{\"type\":\"xml\",\"legacy\":true}'::jsonb)
WHERE session_id='$SID' AND data->>'role'='user'"

curl -s -o /tmp/tso7.json -w "GET %{http_code}\n" "$BASE/session/$SID/message"
python3 -c "
import json
msgs = json.load(open('/tmp/tso7.json'), strict=False)
print([(m['info']['role'], m['info'].get('format')) for m in msgs])
"
```
**期望**：GET 200；user 消息 `format` 为 `None`（脏值被丢弃），列表其余消息正常返回

---

## 测试结果

| 用例 | 结果 | 备注 |
|------|------|------|
| TSO.1 | ✅ | structured={"answer": true, "city": "北京"}，finish=tool-calls（structured 已产出属正常） |
| TSO.2 | ✅ | 列表与单条 GET 均 200；user.format=json_schema、assistant.structured 完整回读（修复回归：修复前列表 400） |
| TSO.3 | ✅ | prompt_async=204，轮询到 structured={"color": "蓝色"} |
| TSO.4 | ✅ | 流内 structured={"days": 7}，idle 为最后帧，curl_exit=0 |
| TSO.5 | ✅ | 非法 type=xml → 400（Expected OutputFormat）；schema=42 → 400 |
| TSO.6 | ✅ | 显式 format={"type":"text"}：structured=null，正常文本回复 |
| TSO.7 | ✅ | PG 手工写入非法 format（type=xml）后 GET 200，user.format 被丢弃为 None |

> 复测记录（2026-09-07，本地 PG + 远端沙箱（K8s 30040 转发），镜像 `opencode-saas-sandbox-test:so-test`，真实 LLM `Yd-DeepSeek/deepseek-v4-flash`）：**TSO.1–TSO.7 全部通过**。
>
> 复测记录（2026-09-07，同环境，镜像含 NUL guard 修复——`db.pg.ts` 在 postgres.js `client.unsafe` 统一剥离参数中的 `\u0000` 转义，否则含 Vite 虚拟模块名 `\0virtual:...` 的报错文本会令 part/event jsonb 写入失败、prompt 静默挂死）：**TSO.1–TSO.7 回归全部通过**（TSO.1 structured={"answer": false, "capital": "北京"}）。
>
> 复测记录（2026-09-14，镜像 `hitl-cbf2276a-wip2`（含 pgJsonb/LEASE_TOOLS/偏离修复），本地 PG + 远端沙箱）：**TSO.1–TSO.7 全部通过**——TSO.1 ✅（`{"answer": true, "city": "Beijing"}`，结构符合 required）/ TSO.2 ✅（列表+单条 GET 均 200，format/structured 完整回读）/ TSO.3 ✅（204 + 轮询 `{"color": "蓝色"}`）/ TSO.4 ✅（stream 内 `{"days": 7}`，idle 为最后帧，curl_exit=0）/ TSO.5 ✅（bad type=xml → 400 BadRequest；schema=42 → 400）/ TSO.6 ✅（structured=None + 文本回复）/ TSO.7 ✅（PG 直写非法 format 后 GET 200，user.format 丢弃为 None——pgJsonb 列解码下容错分支依然健在）。
>
> **复测记录（2026-09-16，镜像 `person-model-connect`（feat/opencode-1.18.31 工作区：个人模型隔离 + 公共优先 + provider 脱敏 + autokeepalive），本地 PG + 远端 K8s 沙箱，真实 LLM `Yd-DeepSeek/deepseek-v4-flash`）：TSO.1–TSO.7 全部通过**——TSO.1 ✅（`{"answer": true, "city": "北京"}`）/ TSO.2 ✅（列表+单条 GET 200，format/structured 完整回读）/ TSO.3 ✅（204 + 轮询 structured）/ TSO.4 ✅（stream 内 structured，idle 末帧 curl=0）/ TSO.5 ✅（xml/42 → 400×2）/ TSO.6 ✅（text 格式 structured=null 正常文本）/ TSO.7 ✅（脏 format 容错 200）。附注：TSO.1 首跑 FAIL 为断言脚本把 jexec 的 Python repr 当 JSON 解析（`{'a': True}` 单引号），修正判定后通过，非功能问题。
>
> - 修复说明：TSO.2/TSO.7 覆盖本轮修复——`OutputFormat` 是 Schema.Class union，HTTP 响应 encode 仅接受类实例；PG bridge 的 `message-v2.ts info()` 原样透传普通 JSON 对象导致 encode 失败。修复为读取时对 format 字段 re-decode（decode 失败丢弃该可选字段，不炸列表）。
> - 接口范围：`command` / `shell` 端点的输入 schema 无 format 字段，不支持结构化输出（代码确认 `ShellInput`/`CommandInput` 定义）。
> - 已知限制：模型拒绝/未产出结构化输出时走 `StructuredOutputError`（`info.error`），触发条件依赖模型行为，未做稳定复现用例；`retryCount`（默认 2）重试机制当前未实现（失败路径 retries 硬编码 0），列为后续增强。
>
> **复测记录（2026-10-12，镜像 `opencode-saas-sandbox-test:152c8587db`，组合 1（远端 PG + 远端 K8s 沙箱），模型切换为 `Yd-GLM/glm-5.3`（非默认 deepseek-v4-flash））：TSO.1–TSO.7 全部通过，语义值按文档期望精确断言**——TSO.1 ✅（structured 精确等于 `{"answer": true, "city": "北京"}`，finish=tool-calls 属正常）/ TSO.2 ✅（列表+单条 GET 200，user.format=json_schema + structured 完整回读）/ TSO.3 ✅（204 + 轮询 `{"color": "蓝色"}`，PG 侧 `data->>'structured'` 精确匹配）/ TSO.4 ✅（流内 `{"days": 7}`，idle 末帧，curl_exit=0）/ TSO.5 ✅（xml → 400 `Expected OutputFormat, got {"type":"xml","schema":{}} at ["format"]`；schema=42 → 400）/ TSO.6 ✅（text 格式 structured=null，回复精确含「收到」）/ TSO.7 ✅（PG 直写脏 format UPDATE 2 条后 GET 200，user.format 全部丢弃为 None，assistant 消息不受影响）。
>
> 附注：TSO.1 断言脚本再次踩中 09-16 附注记录的 jexec repr 坑（`{'city': '北京', 'answer': True}` 单引号 repr 不能用 `json.loads` 解析），本轮改为原始 JSON 响应直接解析判定；功能无问题。GLM-5.3 在结构化输出链路（StructuredOutput 工具注入 + toolChoice=required + format 读回/容错）行为与 deepseek-v4-flash 一致。

---
