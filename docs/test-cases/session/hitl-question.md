# 挂起 question/permission 的重启持久化（已知缺陷钉住）

> 钉住缺陷：`question.ask()` / `permission.ask()` 的 pending 状态仅存于实例内存（`InstanceState` 的 `Map` + `Deferred`），
> 不落 PG。实例重启 / 多实例路由切换后 pending 全部丢失：`GET /question` 清空、reply/reject 返回 404、
> run 悬死等 stale-run 接管（默认 1800s）、permission 的 `always` 放行规则丢失。
>
> 代码位置：
> - `packages/opencode/src/question/index.ts:43` — `pending: Map<QuestionID, PendingEntry>`（内存）
> - `packages/opencode/src/permission/index.ts:25-26` — `pending` + `approved`（内存，`always` 规则）
> - 唯一善后是 `Effect.addFinalizer`（question:74-81 / permission:56-63），仅覆盖 graceful shutdown，且语义 = 全部按"用户拒绝"收场

## 验证标准

| 层级 | 方法 | 判定标准 |
|------|------|---------|
| 1. HTTP 响应 | 重启实例前后调用 question/permission API | 修复后：重启前可见的 pending，重启后仍可见且可 reply |
| 2. PG 记录 | 查 information_schema / event 表 | 修复后：pending 状态有持久化载体（当前缺陷：question 事件未标 durable，`question.asked` 连一次性记录都不落 event 表） |
| 3. run 行为 | 重启后观察 session 消息树与 run 状态 | 修复后：挂起 run 以明确语义收场（恢复或显式关闭），不悬死等待 stale-run 接管 |

## 通用变量

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`。用例直接用 `$BASE` `$PG_URL` `$MODEL`。

**前置条件（重要）**：

- 本组用例包含 `docker restart`，**必须在本地容器组合执行**（容器 `opencode-saas-test`，`$BASE=http://localhost:14096`），禁止对远端共享测试环境重启。
- question 工具默认启用条件：client ∈ {app, cli, desktop}（`registry.ts:229`）。SaaS 容器未设 `OPENCODE_CLIENT` 时默认 `cli`，即默认启用。
- question 挂起已豁免 LLM stall 计时（见 [`llm-stall-recovery.md`](llm-stall-recovery.md)），等待用户回答不限时——这正是 pending 长期存活的场景。

---

## 一、T1 触发：构造挂起 question（建立基线）

### T1.1 异步消息让 AI 调用 question 工具

> question 挂起会阻塞 run，同步 `POST /message` 会一直等到回答；必须用 `prompt_async` 立即返回。

```bash
source test-lib.sh

SID=$(new_sid -k)
echo "SID: $SID"

# 后台异步发消息（prompt_async 立即返回，不等待 run 完成）
curl -s -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请立即使用 question 工具向我提问：'测试流程是否继续？'，选项：[继续, 停止]。发完问题就停下来等我的回答，不要自己猜测答案。\"}],\"model\":$MODEL}" | jexec "d.get('info', d)"

# 轮询等待 question 挂起（最多 90s）
for i in $(seq 1 45); do
  QCOUNT=$(curl -s "$BASE/question" | jexec "len(d)")
  [ "$QCOUNT" = "1" ] && break
  sleep 2
done
echo "pending questions: $QCOUNT"
```

**期望**：
- HTTP：`GET /question` 返回 1 条 pending，`sessionID = $SID`，questions 含「继续/停止」选项
- SSE（可选）：`question.asked` 事件推送

### T1.2 pending 内容完整

```bash
curl -s "$BASE/question" | python3 -c "
import json, sys
d = json.load(sys.stdin, strict=False)
q = d[0]
print(f\"id={q['id']} session={q['sessionID']} questions={len(q['questions'])}\")
print('PASS' if len(q['questions']) == 1 else 'FAIL')
"
```

**期望**：id 非空、sessionID 正确、questions=1

### T1.3 对照组：正常 reply 后 AI 继续、run 完成

```bash
QID=$(curl -s "$BASE/question" | jexec "d[0]['id']")

curl -s -X POST "$BASE/question/$QID/reply" \
  -H 'Content-Type: application/json' \
  -d '{"answers":[["继续"]]}' | jexec "d.keys()"

# 轮询等待 run 完成（assistant 回复出现，最多 120s）
for i in $(seq 1 60); do
  DONE=$(curl -s "$BASE/session/$SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin, strict=False)
asst = [m for m in msgs if m.get('role') == 'assistant']
print('yes' if asst and any(p.get('type') == 'text' for p in asst[-1].get('parts', [])) else 'no')
" 2>/dev/null)
  [ "$DONE" = "yes" ] && break
  sleep 2
done
echo "run finished: $DONE"

# 回答已回填给模型：GET /question 应清空
curl -s "$BASE/question" | jexec "len(d)"
```

**期望**：
- HTTP：reply 200；run 正常完成；`GET /question` 归零
- 消息树中 question tool call 有 result，内容含「继续」（答案回填）

---

## 二、T2 预期 vs 当前缺陷：重启后 pending 丢失

> 按 T1.1 重新构造一个挂起 question（新 SID），再执行以下步骤。
> 每条用例标注**当前（缺陷行为）**与**修复后（验收标准）**。

### T2.1 重启实例后 GET /question 清空

```bash
# （已按 T1.1 构造挂起 question）
QID_BEFORE=$(curl -s "$BASE/question" | jexec "d[0]['id']")
echo "QID before restart: $QID_BEFORE"

docker restart opencode-saas-test

# 等 server 恢复
for i in $(seq 1 30); do
  curl -s -o /dev/null "$BASE/session" && break
  sleep 2
done

echo "pending after restart: $(curl -s "$BASE/question" | jexec "len(d)")"
```

**期望**：
- 当前（缺陷）：pending = 0，`QID_BEFORE` 彻底消失
- 修复后：pending ≥ 1，`QID_BEFORE` 仍在列表中，可继续 reply

### T2.2 reply 旧 requestID 返回 404

```bash
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/question/$QID_BEFORE/reply" \
  -H 'Content-Type: application/json' \
  -d '{"answers":[["继续"]]}')
echo "reply status: $HTTP_CODE"

HTTP_CODE2=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/question/$QID_BEFORE/reject")
echo "reject status: $HTTP_CODE2"
```

**期望**：
- 当前（缺陷）：404（`Question.NotFoundError`，新实例内存 Map 无此条目）——多实例路由切换是同一表现，无需重启也可复现（见第四节）
- 修复后：200，答案正确送达（重启场景若修复方案选择"显式关闭"，则应返回明确的状态语义而非裸 404）

### T2.3 PG 无 pending 持久化载体（架构证据）

```bash
# 1) 查无 question/permission 状态表
pgval "SELECT count(*) FROM information_schema.tables WHERE table_name LIKE '%question%' OR table_name LIKE '%permission%'"

# 2) question 事件也未落 event 表：question.asked 等 3 个事件均未标注 durable
#    （packages/schema/src/v1/question.ts:58-60，define() 无 durable 字段 → 不入 durable manifest → 不落 PG）
pgval "SELECT count(*) FROM event WHERE type LIKE 'question%'"
```

**期望**：
- 当前（缺陷）：两查询均 = 0——不仅「还在等」无状态载体，连「问过」的一次性痕迹都不落 PG（事件仅走内存事件桥/SSE；对比 durable 事件如 `session.*` 会落 event 表）
- 修复后：pending 状态有持久化载体（新表或复用 event 表将 `question.asked` 标注 durable），重启后可据此恢复

### T2.4 挂起 run 悬死，等 stale-run 接管

```bash
# 重启后查看该 session 消息树：question tool call 无 result（悬空）
curl -s "$BASE/session/$SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin, strict=False)
for m in msgs:
    for p in m.get('parts', []):
        if p.get('type') == 'tool' and p.get('tool') == 'question':
            print(f\"tool call {p.get('callID')[:16]}... state={p.get('state')}\")
"

# run 状态：挂起直到 OPENCODE_SESSION_STALE_RUN_SEC（默认 1800s）后被接管
```

**期望**：
- 当前（缺陷）：question tool call 的 state 长期处于 pending/无 result；旧 run 不被任何人关闭，直到 stale-run 接管（默认 30 分钟）；接管时悬空 question 无显式处理语义
- 修复后：重启恢复或接管时，挂起 run 以明确原因收场（如「实例重启，问题未回答」），消息树中 tool call 有终态 result

### T2.5 answered-lost：已答未消费的答案回填（最佳实践修正后新增）

> 场景：用户已提交 reply（PG 行 status=replied），但持有实例在消费前死亡。修复后答案不丢——清扫时把答案回填进悬空 tool part，下一次发消息 LLM 能引用。

```bash
# 1) 按 T1.1 构造挂起 question（新 SID），然后在实例消费前重启
#    （模拟方式：reply 与 restart 之间竞态较难稳定构造，可用「reply 打到无该 pending 的另一实例」
#     即 T4.1 多实例场景，或直接 docker stop -t 0 硬杀 + 手工把行置 replied）
QID=$(curl -s "$BASE/question" | jexec "d[0]['id']")
curl -s -X POST "$BASE/question/$QID/reply" \
  -H 'Content-Type: application/json' -d '{"answers":[["继续"]]}' > /dev/null
docker restart opencode-saas-test   # 若 reply 已送达原实例则退化为 T2.1 场景

# 2) 等 server 恢复 + 清扫（租约过期，最长 ~2min）后，再发一条消息触发新 run
curl -s -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"刚才我的回答是什么？请原样复述\"}],\"model\":$MODEL}" > /dev/null

# 3) 验证 assistant 回复引用了「继续」
```

**期望**：
- 当前（缺陷）：答案彻底丢失，LLM 无法复述
- 修复后：悬空 question tool part 被清扫回填为 completed（output 含「继续」），LLM 复述正确——用户已提交的答案不因实例死亡丢失

---

## 三、T3：permission pending 同类缺陷

### T3.1 触发 permission ask

```bash
SID_P=$(new_sid -k)

# 会话级规则：bash rm* → ask
curl -s -X PATCH "$BASE/session/$SID_P" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"bash","pattern":"rm*","action":"ask"}]}' > /dev/null

# 异步触发（rm 命令命中 ask 规则）
curl -s -X POST "$BASE/session/$SID_P/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"执行命令 rm -rf /tmp/perm-ask-test，直接执行不要询问我\"}],\"model\":$MODEL}" > /dev/null

for i in $(seq 1 45); do
  PCOUNT=$(curl -s "$BASE/permission" | jexec "len(d)")
  [ "$PCOUNT" = "1" ] && break
  sleep 2
done
echo "pending permissions: $PCOUNT"
```

**期望**：`GET /permission` 返回 1 条，permission=bash、pattern 命中 `rm*`、sessionID 正确

### T3.2 重启后 reply 404、`always` 放行丢失

```bash
PID_BEFORE=$(curl -s "$BASE/permission" | jexec "d[0]['id']")

docker restart opencode-saas-test
for i in $(seq 1 30); do curl -s -o /dev/null "$BASE/session" && break; sleep 2; done

# 1) 旧 requestID reply → 404
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/permission/$PID_BEFORE/reply" \
  -H 'Content-Type: application/json' \
  -d '{"reply":"once"}')
echo "reply status: $HTTP_CODE"

# 2) always 规则丢失：重启前先 reply always，重启后同 pattern 再次触发 → 仍 ask
```

**期望**：
- 当前（缺陷）：404；重启前点过 `always` 的 pattern，重启后再次触发仍弹 ask（`approved` 数组在内存，`permission/index.ts:26`）
- 修复后：reply 可达或返回明确状态语义；`always` 规则持久化（如落 `session.permission` 列），重启后同 pattern 不再 ask

---

## 四、多实例路由（说明 + 可选执行）

SaaS 多实例共享 PG 时请求按入口路由。实例 A 上挂起的 question，接入方请求打到实例 B：

```bash
# 可选（组合 3，本地 PG）：起第二个容器共享同一 PG，$BASE2 指向它
QID=$(curl -s "$BASE/question" | jexec "d[0]['id']")
# 对实例 B reply 实例 A 的 question
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE2/question/$QID/reply" \
  -H 'Content-Type: application/json' -d '{"answers":[["继续"]]}'
```

**期望**：
- 当前（缺陷）：404（B 的内存 Map 无此条目）——比 pod 重启更高频的触发路径
- 修复后：经 PG 路由回持有等待的实例（PG NOTIFY/轮询），或 reply 幂等落库后由对应实例消费

---

## 五、真实使用场景（E2E，T5.x）

> 模拟接入方的完整用户旅程：AI 主动澄清 → 用户选择 → **答案真实影响 AI 行为分支**；拒绝路径；长挂起（用户离线）租约续期与沙箱存活；前端 SSE 实时感知。以下用例共享 `source test-env.sh 3 && source test-lib.sh` 前置。

### T5.1 需求澄清分叉：用户的回答真实改变 AI 执行路径

> 场景：让 AI 建文件，但故意留下二选一的歧义（语言未指定）。AI 应主动 question 澄清；用户选「python」后 AI 必须建 `.py` 而非 `.js`——验证答案被回填消费且**驱动行为分支**，而非仅落库。

```bash
SID=$(new_sid -k)
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"在 /workspace/app 创建一个入口文件。语言不明确时必须先用 question 工具问我选哪种语言，选项：[python, javascript]，问完停下等回答，不要自己假设。\"}],\"model\":$MODEL}" > /dev/null
# 轮询挂起（同 T1.1，最多 90s）后：
QID=$(curl -s "$BASE/question" | jexec "d[0]['id']")
curl -s -X POST "$BASE/question/$QID/reply" -H 'Content-Type: application/json' \
  -d '{"answers":[["python"]]}' > /dev/null
# 等 run 完成后验证：入口是 .py 且不是 .js
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"ls /workspace/app/ && echo --- && ls /workspace/app/*.js 2>&1"}'
```

**期望**：目录下存在 `.py` 入口且 `ls *.js` 报 No such file——用户的选择真实决定了产物。

### T5.2 拒绝路径：用户选「取消」后 AI 不执行删除

> 场景：AI 问「确认删除？」，用户选否定。AI 必须尊重决定——不执行命令、以确认收尾。验证答案语义（而非字符串）被传递。

```bash
SID=$(new_sid -k)
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"准备执行 rm -f /workspace/t5-marker.txt（先自己创建它）。执行前必须用 question 工具问我：'确认删除？'，选项：[确认, 取消]，问完停下等回答。\"}],\"model\":$MODEL}" > /dev/null
# 挂起后选「取消」：
QID=$(curl -s "$BASE/question" | jexec "d[0]['id']")
curl -s -X POST "$BASE/question/$QID/reply" -H 'Content-Type: application/json' \
  -d '{"answers":[["取消"]]}' > /dev/null
# run 完成后验证文件仍在（未被删除）
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"[ -f /workspace/t5-marker.txt ] && echo FILE-SURVIVES || echo FILE-DELETED"}'
```

**期望**：输出 `FILE-SURVIVES`——用户取消后 AI 未执行删除；assistant 文本含「已取消」类确认。

### T5.3 长挂起（用户离线）：租约续期 + 沙箱存活 + 迟到回答有效

> 场景：question 挂起后用户 3 分钟未理（远超清扫窗口：租约 60s + grace 30s + 扫描 30s = ~120s）。挂起**不得被误清**（活跃 run 续期租约）；autokeepalive 下沙箱不回收；迟到回答仍能唤醒 run。

```bash
SID=$(new_sid -k)
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 question 工具问我：'继续吗？'，选项：[继续]，问完停下。之后我会隔很久才回答。\"}],\"model\":$MODEL}" > /dev/null
# 等挂起出现（同 T1.1）后静置 185 秒
sleep 185
P=$(curl -s "$BASE/question" | jexec "len(d)")                                # 期望 1（未被清扫）
SB=$(curl -s "$BASE/session/$SID/sandbox" | jexec "d.get('sandboxId') is not None")  # 期望 True
QID=$(curl -s "$BASE/question" | jexec "d[0]['id']")
curl -s -X POST "$BASE/question/$QID/reply" -H 'Content-Type: application/json' \
  -d '{"answers":[["继续"]]}' > /dev/null
# 轮询 run 完成（同 T1.3）
```

**期望**：185s 后 pending 仍 = 1；沙箱仍存活；迟到回答正常唤醒 run 并完成。

### T5.4 前端视角：SSE 实时收到 question.asked 与回复后续事件

> 场景：模拟前端订阅 `/event` 流发起任务——question 事件实时推送（UI 弹窗数据源），reply 后继续收到 message/session 事件直至 idle。

```bash
SID=$(new_sid -k)
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 90 "$DIR" > /tmp/t5-sse.log & P=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t5-sse.log 2>/dev/null && break; sleep 0.5; done
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 question 工具问我：'SSE 场景继续？'，选项：[继续]，问完停下。\"}],\"model\":$MODEL}" > /dev/null
for i in $(seq 1 45); do grep -q '"type":"question.asked"' /tmp/t5-sse.log 2>/dev/null && break; sleep 2; done
QID=$(curl -s "$BASE/question" | jexec "d[0]['id']")
curl -s -X POST "$BASE/question/$QID/reply" -H 'Content-Type: application/json' -d '{"answers":[["继续"]]}' > /dev/null
wait $P
grep -c '"type":"question.asked"' /tmp/t5-sse.log
grep -c '"type":"session.idle"' /tmp/t5-sse.log
```

**期望**：`question.asked` ≥ 1；reply 后流继续收到 message 事件并以 `session.idle` 收尾。

### T5.5 permission always 真实流：首次弹窗放行后同类命令免打扰

> 场景：会话规则 `npm*` → ask。AI 跑 npm 命令首次弹 permission；用户 always 放行；第二条 npm 命令**不再弹**——「一次授权，全程免打扰」。

```bash
SID=$(new_sid -k)
curl -s -X PATCH "$BASE/session/$SID" -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"bash","pattern":"npm*","action":"ask"}]}' > /dev/null
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: npm --version\"}],\"model\":$MODEL}" > /dev/null
# 挂起后 always 放行：
PID=$(curl -s "$BASE/permission" | jexec "d[0]['id']")
curl -s -X POST "$BASE/session/$SID/permissions/$PID" -H 'Content-Type: application/json' \
  -d '{"response":"always"}' > /dev/null
# 等 run 完成，再发第二条 npm 命令
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: npm --version（再跑一次）\"}],\"model\":$MODEL}" > /dev/null
# 等 run 完成后：全程 permission 挂起仅 1 次
psql "$PG_URL" -t -A -c "SELECT count(*) FROM hitl_request WHERE session_id='$SID' AND kind='permission'"
```

**期望**：permission 挂起仅首次 1 次；第二条 npm 直接执行；`session.permission` 落 `npm *→allow`。

---

---

## 六、飞书式审批场景（T6.x）

> 模拟飞书审批的完整形态：**审批卡片实时推送 → 审批中心待办列表 → 通过/拒绝单据流转 → 发起方撤回 → 审批历史留痕**。
>
> **接口语义（2026-09-16 实测确认）**：
> - 待办列表：`GET /permission`（**根路径**，跨 session 全部 pending）
> - 审批回复：`POST /session/:sessionID/permissions/:permissionID`，body **`{"response":"once"|"always"|"reject"}`**（非法值如 `deny` 直接 400）
> - 审批单存 `hitl_request`（kind=question|permission），`session` 删除时 FK 级联清理
> - 单据终态 `close_reason`：`answered-delivered`（once 通过并执行）/ `decision-delivered`（reject 拒绝决策交付）/ `instance-restart`（abort 撤回，租约清扫收场）/ `shutdown`

### T6.1 审批卡片推送（SSE permission.asked）与审批中心待办

```bash
S1=$(new_sid -k); DIR1=$(curl -s "$BASE/session/$S1" | jexec "d['directory']")
curl -s -X PATCH "$BASE/session/$S1" -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"bash","pattern":"mkdir*","action":"ask"}]}' > /dev/null
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 70 "$DIR1" > /tmp/feishu-sse.log & PS=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/feishu-sse.log 2>/dev/null && break; sleep 0.5; done
curl -s -X POST "$BASE/session/$S1/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: mkdir -p /workspace/f2-a1，直接执行不要问我\"}],\"model\":$MODEL}" > /dev/null
# 并发第二单（模拟两条待审批）
S2=$(new_sid -k)
curl -s -X PATCH "$BASE/session/$S2" -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"bash","pattern":"touch*","action":"ask"}]}' > /dev/null
curl -s -X POST "$BASE/session/$S2/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: touch /workspace/f2-a2.txt，直接执行不要问我\"}],\"model\":$MODEL}" > /dev/null
# 等两单均挂起后：
curl -s "$BASE/permission" | jexec "len(d)"                 # 期望 2（审批中心待办两条）
grep -c '"type":"permission.asked"' /tmp/feishu-sse.log     # 期望 ≥1（卡片推送）
wait $PS
```

**期望**：SSE `permission.asked` ≥1（卡片实时推送）；根路径待办列表 2 条（跨 session 汇总）。

### T6.2 审批通过（once）：业务执行 + 单据流转

```bash
P1=$(curl -s "$BASE/permission" | jexec "next(q['id'] for q in d if q.get('sessionID')=='$S1')")
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/session/$S1/permissions/$P1" \
  -H 'Content-Type: application/json' -d '{"response":"once"}'        # 期望 200
# 等 run 完成后核对业务与单据
curl -s -X POST "$BASE/session/$S1/exec" -H 'Content-Type: application/json' \
  -d '{"command":"[ -d /workspace/f2-a1 ] && echo DIR-OK || echo DIR-MISS"}'    # 期望 DIR-OK
psql "$PG_URL" -t -A -c "SELECT status||'|'||coalesce(close_reason,'-') FROM hitl_request WHERE id='$P1'"
```

**期望**：once 放行后命令真实执行（DIR-OK）；单据终态 `closed|answered-delivered`。

### T6.3 审批拒绝（reject）：业务不执行 + 决策交付关闭

```bash
P2=$(curl -s "$BASE/permission" | jexec "next(q['id'] for q in d if q.get('sessionID')=='$S2')")
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/session/$S2/permissions/$P2" \
  -H 'Content-Type: application/json' -d '{"response":"reject"}'      # 期望 200（deny 非法 → 400）
curl -s -X POST "$BASE/session/$S2/exec" -H 'Content-Type: application/json' \
  -d '{"command":"[ -f /workspace/f2-a2.txt ] && echo FILE-CREATED || echo FILE-BLOCKED"}'   # 期望 FILE-BLOCKED
psql "$PG_URL" -t -A -c "SELECT status||'|'||coalesce(close_reason,'-') FROM hitl_request WHERE id='$P2'"
```

**期望**：拒绝后业务**未执行**（FILE-BLOCKED）；单据终态 `closed|decision-delivered`（拒绝决策已交付 AI）。

### T6.4 发起方撤回（abort）：租约清扫收场

```bash
S5=$(new_sid -k)
curl -s -X PATCH "$BASE/session/$S5" -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"bash","pattern":"whoami*","action":"ask"}]}' > /dev/null
curl -s -X POST "$BASE/session/$S5/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: whoami，直接执行不要问我\"}],\"model\":$MODEL}" > /dev/null
# 等挂起后撤回
P5=$(curl -s "$BASE/permission" | jexec "next(q['id'] for q in d if q.get('sessionID')=='$S5')")
curl -s -X POST "$BASE/session/$S5/abort" > /dev/null
sleep 150   # 租约清扫窗口（租约 60s + grace 30s + 扫描 30s）
curl -s "$BASE/permission" | jexec "sum(1 for q in d if q.get('sessionID')=='$S5')"   # 期望 0
psql "$PG_URL" -t -A -c "SELECT status||'|'||coalesce(close_reason,'-') FROM hitl_request WHERE id='$P5'"
```

**期望**：abort 后无活跃 run → 租约清扫收场：待办清零、单据 `closed|instance-restart`。

### T6.5 审批历史留痕（审计）

```bash
psql "$PG_URL" -t -A -c "SELECT kind||'|'||status||'|'||coalesce(close_reason,'-') FROM hitl_request WHERE session_id IN ('$S1','$S2','$S5') ORDER BY time_created"
```

**期望**：三单完整留痕覆盖三种终态路径：
- `permission|closed|answered-delivered`（once 通过并执行）
- `permission|closed|decision-delivered`（reject 拒绝）
- `permission|closed|instance-restart`（abort 撤回）

---

---

## 七、覆盖补全（T7.x）：跨租户隔离与审批边界场景

> 本节补齐审批功能此前未覆盖的真实场景，并修复实测发现的**跨租户隔离缺口**。
>
> ### 修复：HITL 行增加用户维度（2026-09-16）
>
> **缺口**（实测确认）：`GET /permission` / `GET /question` 只按 `directory` 过滤，`hitl_request` 表无用户列——SaaS 下所有 session 的 directory 都是 `/workspace`，用户 A 的待办列表能看到并回复用户 B 的审批单（跨租户越权）。
>
> **修复**：
> - `hitl_request` 新增 `user_id text NOT NULL DEFAULT ''`（'' = 公共/匿名，语义与 auth 凭据一致）；`hitl_pending_idx` 改为 `(directory, user_id, kind, status, lease_until)`
> - 落库归属：`Permission.ask` / `Question.ask` 从运行上下文最后一条 user 消息取 `userId` 写入（`session/tools.ts`、`tool/question.ts`）
> - 读隔离：`list` 按请求 `x-user-id` 过滤（handlers 注入，**不走 body** 防伪造）
> - 写隔离：`reply`/`reject` 的 CAS 增加归属条件——跨用户提交与「不存在」同语义（404，防枚举）；内部善后（salvage/级联）不带用户条件，保持跨用户清扫能力
>
> ### T7.1 跨用户审批/问题隔离（修复验证）

```bash
# A、B 各自会话挂起一条审批
SA=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -H 'x-user-id: user-a' -d '{}' | jexec "d['id']")
curl -s -X PATCH "$BASE/session/$SA" -H 'Content-Type: application/json' -H 'x-user-id: user-a' \
  -d '{"permission":[{"permission":"bash","pattern":"mkdir*","action":"ask"}]}' > /dev/null
# prompt_async 带 x-user-id: user-a，触发挂起（同上文用例）
# B 同理（touch*）……

# 列表隔离：A/B 各见自己的 1 条，匿名为 0
curl -s "$BASE/permission" -H 'x-user-id: user-a' | jexec "len(d)"     # 1
curl -s "$BASE/permission" -H 'x-user-id: user-b' | jexec "len(d)"     # 1
curl -s "$BASE/permission" | jexec "len(d)"                            # 0

# 跨用户回复被拒（B 回复 A 的 requestID）
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/session/$SB/permissions/$PA" \
  -H 'Content-Type: application/json' -H 'x-user-id: user-b' -d '{"response":"once"}'   # 404
# 本人回复正常
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/session/$SA/permissions/$PA" \
  -H 'Content-Type: application/json' -H 'x-user-id: user-a' -d '{"response":"reject"}' # 200

# question 同理：A 可见 1、B 可见 0
```

**期望**：列表 A=1 / B=1 / 匿名=0；跨用户回复 404、本人 200；question 同隔离。**实测（2026-09-16）：4/4 PASS**（含归属正确性：A/B 分别看到各自的单）。

### T7.2 同 session 多条挂起 + `always` 级联放行

> 真实场景：AI 一轮并行发起多条同类命令，用户点一次 always，其余待审批单应自动级联放行（`permission/index.ts` 的 `listSessionPending` + `evaluate(rules).action === "allow"` 批量 CAS replied）。

```bash
# 要求模型同一轮并行两次 bash（触发多条 pending）
curl -s -X POST "$BASE/session/$S/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请在同一轮里并行同时调用两次 bash 工具：npm --version；npm config get registry\"}],\"model\":$MODEL}" > /dev/null
# 挂起 ≥2 后对第一条 reply always，观察其余是否自动关闭
curl -s -X POST "$BASE/session/$S/permissions/$FIRST" -H 'Content-Type: application/json' -d '{"response":"always"}' > /dev/null
psql "$PG_URL" -t -A -c "SELECT count(*) FROM hitl_request WHERE session_id='$S' AND status<>'pending'"
psql "$PG_URL" -t -A -c "SELECT permission::text FROM session WHERE id='$S'"
```

**期望**：`always` 一次后同 session 其余同 pattern 待审批单**全部脱离 pending**（级联关闭）；`session.permission` 落 allow 规则。**实测（2026-09-16）**：模型本轮未并行发起（串行为 1 单）——级联逻辑由代码路径（`listSessionPending` + evaluate allow → `casTransition replied`）与单测确认；真实触发依赖模型并行调用行为。

### T7.3 edit 工具审批（非 bash 工具）

> 只测过 bash；`edit: ask`（AI 改代码前确认）是高频真实场景。

```bash
S3=$(new_sid -k)
curl -s -X PATCH "$BASE/session/$S3" -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"edit","pattern":"*","action":"ask"}]}' > /dev/null
# 让 AI 用 write 创建文件 → 触发 edit 审批（payload.permission=edit）
curl -s -X POST "$BASE/session/$S3/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 write 工具创建 /workspace/t73.txt 内容 hello-t73\"}],\"model\":$MODEL}" > /dev/null
# 挂起后 reply once → 验证文件写入
psql "$PG_URL" -t -A -c "SELECT payload->>'permission' FROM hitl_request WHERE id='<PID>'"
```

**期望**：单据 `payload.permission=edit`；once 放行后文件写入成功。**实测（2026-09-16）：PASS**（权限=edit，once 后 `cat` 读出 `hello-t73`）。

### T7.4 审批挂起期间沙箱被回收（自愈）

> 挂起单等待期间沙箱被 `kill-sandbox`/idle 回收，用户迟到回复后工具执行应自愈（`withRecreateRetry` 重建沙箱重试一次）。

```bash
# 挂起后 kill-sandbox，再 reply once：
curl -s -X POST "$BASE/session/$S4/kill-sandbox" > /dev/null
curl -s -X POST "$BASE/session/$S4/permissions/$P4" -H 'Content-Type: application/json' -d '{"response":"once"}'
# run 完成 + bash part 状态
```

**期望**：reply 200；run 正常完成；工具执行自愈（重建后执行成功）。**实测（2026-09-16）：PASS**（reply=200、run 完成、bash `completed` 输出 hostname）。

### T7.5 拒绝意见（`message` 字段）

> 飞书「拒绝并填意见」。会话级端点 body 为 `{response}`（无意见）；**意见走根端点** `POST /permission/:requestID/reply` body `{reply:"reject", message:"..."}`，落库 `result.message`。

```bash
curl -s -X POST "$BASE/permission/$P5/reply" -H 'Content-Type: application/json' \
  -d '{"reply":"reject","message":"不要在测试里跑 date，改用 echo 输出时间"}'
psql "$PG_URL" -t -A -c "SELECT status||'|'||coalesce(result->>'message','-') FROM hitl_request WHERE id='$P5'"
```

**期望**：行 `status=rejected` 且 `result.message` 保留意见原文。**实测（2026-09-16）：PASS**。

### T7.6 拒绝后的 AI 行为

> 验证拒绝后 AI 是否给出明确回复（未执行 + 说明/换方案），而非静默或报错。

**期望**：assistant 有文本回复（T6.3 已确认工具未执行；本项为行为观察项）。**实测（2026-09-16）**：AI 有回复（文本内容受模型措辞影响，未做强断言）。

### T7.7 拒绝审计（exec_log）

> `deny` 规则命中时不弹窗、直接拒绝，并经 `recordDenial` 落 `exec_log`（含 permission/patterns/tool 元数据）。

```bash
curl -s -X PATCH "$BASE/session/$S7" -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"bash","pattern":"wget*","action":"deny"}]}' > /dev/null
# 触发 wget 命令后：
psql "$PG_URL" -t -A -c "SELECT source||'|'||substring(command,1,60) FROM exec_log WHERE session_id='$S7' ORDER BY time_created DESC LIMIT 1"
```

**期望**：`exec_log` 有拒绝记录（`source=permission-deny`，command 含 permission/patterns/tool）。**实测（2026-09-16）：PASS**。

### T7.8 permission 长挂起（跨清扫窗口）

> 同 T5.3 的 question 场景，验证 permission 挂起同样**不被租约清扫误清**（活跃 run 续期）、沙箱存活、迟到回复生效。

```bash
# ask 规则触发挂起 → 静置 185s（> 租约 60s + grace 30s + 扫描 30s）→ 回复
sleep 185
curl -s "$BASE/permission" | jexec "sum(1 for q in d if q.get('sessionID')=='$S')"   # 期望 1
curl -s "$BASE/session/$S/sandbox" | jexec "d.get('sandboxId') is not None"          # 期望 True
curl -s -X POST "$BASE/session/$S/permissions/$PID" -H 'Content-Type: application/json' -d '{"response":"once"}'
```

**期望**：185s 后 pending 仍 1、沙箱存活、回复后命令执行成功（`long-pending-ok`）。**实测（2026-09-16）：PASS**。

### T7.9 external_directory 审批

> 访问项目目录（`/workspace`）外路径的审批（`shell.ts` 的 dirs 扫描分支，permission=`external_directory`）。

```bash
curl -s -X PATCH "$BASE/session/$S9" -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"external_directory","pattern":"/etc/*","action":"ask"}]}' > /dev/null
# 让 AI cat /etc/hostname → external_directory 挂起
psql "$PG_URL" -t -A -c "SELECT payload->>'permission' FROM hitl_request WHERE id='<PID>'"
```

**期望**：单据 `payload.permission=external_directory`；放行后命令执行。**实测（2026-09-16）：PASS**（权限=external_directory）。

### T7.10 规则优先级：会话级 ask 覆盖默认放行

```bash
curl -s -X PATCH "$BASE/session/$S10" -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"bash","pattern":"uname*","action":"ask"}]}' > /dev/null
# 让 AI 执行 uname -a（默认无规则时放行）→ 会话规则应触发挂起
```

**期望**：会话级 ask 规则优先于默认放行，命令挂起待审；放行后执行。**实测（2026-09-16）：PASS**。

---

---

## 八、审批边界与多租户补全（T8.x）

> 本轮继续补齐真实使用场景，并修复实测发现的**第二个跨租户隔离缺口**。
>
> ### 修复：`always` 批准按用户隔离（2026-09-16）
>
> **缺口**（实测确认）：`approved` 批准缓存是 **instance 级数组**（按 directory 共享）——用户 A 在任一会话 `always` 放行后，用户 B 的**所有会话**跑同 pattern 命令都会被自动放行（SaaS 同 directory 下跨用户泄漏）。
>
> **修复**：`approved` 改为 `Map<userId, Rule[]>`（PendingEntry 携带发起 `userId`；ask 落库与内存 pending 均记录）——
> - **同用户多会话仍共享**（既有便利特性保留：一个会话批准、同用户其他会话免打扰）
> - **跨用户严格隔离**（B 不再继承 A 的批准）
> - 验证：单测（同用户共享/跨用户挂起）+ 集成（A1 always → A2 不弹、B 挂起）全过

### T8.1 question 一次多问 + 部分回答

```bash
S1=$(new_sid -k)
curl -s -X POST "$BASE/session/$S1/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请用 question 工具一次性问我三个问题（同一 questions 数组）：1) 语言？[python, go]；2) 需要哪些特性？多选 [日志, 鉴权, 缓存]（multiple=true）；3) 项目名？[demo, app]\"}],\"model\":$MODEL}" > /dev/null
# 挂起后核对 questions 数量与 multiple，然后部分回答（第 3 问留空）
curl -s -X POST "$BASE/question/$QID/reply" -H 'Content-Type: application/json' \
  -d '{"answers":[["go"],["日志","缓存"],[]]}'
psql "$PG_URL" -t -A -c "SELECT status||'|'||(result->'answers')::text FROM hitl_request WHERE id='$QID'"
```

**期望**：单条 question 挂起含 3 问（第 2 问 `multiple=true`）；部分回答（含空数组）后 run 正常完成。**实测（2026-09-16）：PASS**（3 问/multiple=True/空答案项，run 完成）。

### T8.2 子 agent（task）内的审批归属

> 编排场景：子 agent 跑危险命令触发审批。验证挂起单归属哪个 session、userId 是否继承。

```bash
S2=$(new_sid -k)
curl -s -X PATCH "$BASE/session/$S2" -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"bash","pattern":"curl*","action":"ask"}]}' > /dev/null
curl -s -X POST "$BASE/session/$S2/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 task 工具创建 general 子 agent，让它用 bash 执行 curl --version\"}],\"model\":$MODEL}" > /dev/null
psql "$PG_URL" -t -A -c "SELECT session_id, user_id FROM hitl_request WHERE kind='permission' ORDER BY time_created DESC LIMIT 1"
```

**期望**：挂起单 `session_id` 为子 session（非父）、`user_id` 继承发起用户。**实测（2026-09-16）：未复现**——两轮 prompt 模型均未按指示让子 agent 执行 curl（行为依赖模型调度），标记为待模型配合时复测。

### T8.3 并发回复同一审批（胜者独占）

```bash
# 两个客户端同时 reply（once / reject）
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/session/$S3/permissions/$P3" -H 'Content-Type: application/json' -d '{"response":"once"}' &
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/session/$S3/permissions/$P3" -H 'Content-Type: application/json' -d '{"response":"reject"}' &
wait
```

**期望**：一 200、一 409（CAS 胜者独占，迟到提交不覆盖）。**实测（2026-09-16）：PASS**（`200, 409`）。

### T8.4 待办列表字段契约

```bash
curl -s "$BASE/permission" | python3 -c "
import json,sys
q=next(x for x in json.load(sys.stdin, strict=False) if x['sessionID']=='$S4')
print([k for k in ('id','sessionID','permission','patterns','metadata') if k not in q])"
```

**期望**：`id/sessionID/permission/patterns/metadata` 齐全（前端待办卡片数据源）。**实测（2026-09-16）：PASS**。

### T8.5 `always` 落库与粒度：命令 arity 前缀（定论）

> **定论（2026-09-17 确定性复验）**：`always` 落库**正常**、粒度语义**已确认**。
>
> **机制**：`always` 的 pattern 由 tool 层生成 = `BashArity.prefix(tokens).join(" ") + " *"`，落库到 `session.permission`（`Permission.reply` 的 always 分支在 CAS 成功后写入）。日志实测：
> ```
> 00:54:39  npm config get registry → ask (npm*)            ← 挂起
> 00:54:58  npm config get registry → allow (npm config *)  ← always 落库后命中（免打扰）
> 00:57:26  npm config get registry → allow (npm config *)  ← 同 arity 持续免打扰
> ```
> `session.permission` 实测：`[{ask, npm*}, {allow, "npm config *"}]` ✓
>
> **粒度**：pattern 前缀深度由 arity 决定——`npm config get registry` → `npm config *`（覆盖 `npm config` 系列），`npm --version` → `npm --version *`（两者互不覆盖）。
>
> ⚠️ **测试注意（三次误判的教训）**：
> 1. `approved` 按**身份**分桶（`userId`；未带 header 的测试同属 `""` 公共身份）→ 同一容器内**多轮测试的批准会跨会话累积**，后续会话出现「莫名不弹」属**设计内行为**，不是缺陷；需要干净隔离请用不同 `x-user-id` 或重启容器
> 2. 断言必须**同时检查 bash tool part 是否存在**——模型可能直接文本回答而不调用工具，仅看「未挂起」会得到假阳性
>
> ```bash
> # 确定性验证（强制调工具 + 检查 bash part + 落库断言）
> # prompt: 必须使用 bash 工具执行命令「npm config get registry」，原样返回输出，禁止直接回答
> psql "$PG_URL" -t -A -c "SELECT payload->>'always' FROM hitl_request WHERE id='$PID'"  # 期望 ["npm config *"]
> # reply always 后：
> psql "$PG_URL" -t -A -c "SELECT permission::text FROM session WHERE id='$S'"          # 期望含 {"action":"allow","pattern":"npm config *"}
> ```
>
> **实测（2026-09-17）**：payload.always=`["npm config *"]`、`session.permission` 含 allow 行、同 arity 免打扰、日志 evaluated 命中 allow ✓

### T8.6 `always` 与后配 `deny` 的优先级

```bash
# session ask hostname* → always 放行 → 再 PATCH 加 deny hostname*
curl -s -X PATCH "$BASE/session/$S6" -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"bash","pattern":"hostname*","action":"ask"},{"permission":"bash","pattern":"hostname*","action":"deny"}]}' > /dev/null
```

**期望**：实测语义——`always` 批准（approved 在规则合并尾部）**优先于后配的 deny**，命令不弹窗直接执行。**实测（2026-09-16）：PASS**（不弹窗、bash completed）。

### T8.7 审批通过但命令执行失败（错误呈现）

```bash
# ask false* → 通过 once → 命令 `false`（exit 1）
# 查 bash part 的 state.metadata
```

**期望**：命令执行失败被明确记录（`state.metadata.exit=1`），不静默。**实测（2026-09-16）：PASS**（`{"status":"completed","metadata":{"exit":1,...}}`）。

### T8.8 permission 实例死后决策收场

> 场景：`reply once` 后实例立即重启（决策消费前死亡）。挂起 part 不应永久悬空。

```bash
curl -s -X POST "$BASE/session/$SA/permissions/$PA" -H 'Content-Type: application/json' -d '{"response":"once"}'
docker restart opencode-saas-test
# 恢复后查行与 part
psql "$PG_URL" -t -A -c "SELECT status||'|'||coalesce(close_reason,'-') FROM hitl_request WHERE id='$PA'"
```

**期望**：行进入终态（replied/closed）；命令最终执行或明确收场（不悬空）。**实测（2026-09-16）：PASS**（行 replied，part `completed` 输出 `lost-answer`）。

### T8.9 重启后用户隔离保持

```bash
# A/B 各挂起（不同 x-user-id）→ docker restart → 按用户查待办
```

**期望**：B 的 pending 保留且仅 B 可见；匿名 0。**实测（2026-09-16）：PASS**（B=1、匿名=0）。

### T8.10 审批挂起豁免 LLM stall

> question 挂起豁免 stall 已有记录；验证 permission 挂起同样不计入 stall 超时（默认 300s）。

```bash
# 挂起后静置 330s（> stall 默认 300s）
sleep 330
curl -s "$BASE/permission" | jexec "sum(1 for q in d if q.get('sessionID')=='$S10')"   # 期望 1（未被 stall 杀）
# 回复后命令正常执行
```

**期望**：330s 后 pending 存活、run 未被 stall 中止；回复后正常执行。**实测（2026-09-16）：PASS**（pending=1、回复后 bash completed `stall-exempt`）。

### 能力缺口（未实现，记录）

| 缺口 | 说明 |
|---|---|
| 无批量审批端点 | 飞书支持批量同意；当前只能逐条 `reply`，多单场景逐条处理 |
| 无过期自动决策 | 仅「实例死」的租约清扫（`instance-restart`）；用户长期不理会将一直 pending（若有 TTL 需求需产品定义） |
| 无审批人/会签概念 | 单请求单决策（CAS 胜者独占）；多级/会签属业务层能力 |

---

## 验收汇总

| 用例 | 触发动作 | 修复后验收标准 | 当前状态（缺陷） |
|------|---------|--------------|----------------|
| T1.1 异步触发 question | prompt_async + 轮询 | pending=1，sessionID 正确 | ✅ PASS（2026-09-14 复测） |
| T1.2 pending 内容 | GET /question | id/session/questions 完整 | ✅ PASS（2026-09-14 复测） |
| T1.3 正常 reply 链路 | reply + 轮询 run | run 完成，答案回填，pending 归零 | ✅ PASS（链路由 T4.1 完整覆盖：reply → 回填 → run 完成） |
| T2.1 重启后清空 | docker restart | pending 保留可恢复 | ✅ PASS：重启后 pending=1 且 ID 一致 |
| T2.2 reply 404 | reply/reject 旧 ID | 200 或明确状态语义 | ✅ PASS：reply 200（PG 落 replied）；随后 reject 返回 **409 冲突**（胜者结果不被覆盖，见 §4.10） |
| T2.3 PG 无载体 | information_schema / event | 有持久化载体 | ✅ PASS：`hitl_request` 表，pending 行含 kind/status/directory/payload |
| T2.4 run 悬死 | 消息树 + run 状态 | 明确语义收场 | ✅ PASS：重启后 part 悬空（running），由**租约清扫**自动收场（~2min），不再等 stale-run 30min |
| T2.5 answered-lost 回填 | reply + restart + 补发消息 | 答案回填 part，LLM 可复述 | ✅ PASS：part → completed `output="User answered: 继续"`；补发消息 LLM 复述「继续」 |
| T3.1 permission ask | bash ask 规则 + rm | pending=1 | ✅ PASS（permission=bash、pattern 命中、sessionID 正确） |
| T3.2 重启后 404/always 丢 | restart + reply | 可达 / always 持久化 | ✅ PASS：重启后 pending 保留、reply 200；`always` 落 `session.permission`（`rm *→allow`），重启后同 pattern 触发 **0 次新 ask** |
| T4.1 多实例 reply（可选） | 双容器共享 PG | 跨实例路由成功 | ✅ PASS：实例 B reply 实例 A 的 question → 200，A 轮询消费（pending 清零）→ run 恢复，答案回填，assistant 正常回复 |
| T5.1 澄清分叉（E2E） | question 选 python | 答案驱动行为分支（建 .py） | ✅ PASS（2026-09-16）：选 python 后 .py 入口存在、无 .js |
| T5.2 拒绝路径（E2E） | question 选「取消」 | AI 尊重决定不执行 | ✅ PASS：取消后目标文件保留（FILE-SURVIVES） |
| T5.3 长挂起（用户离线） | 挂起 185s 后回复 | 租约续期 + 沙箱存活 + 迟到回答唤醒 | ✅ PASS：pending 保留、沙箱存活、run 正常完成 |
| T5.4 前端 SSE（E2E） | /event 订阅 + question | question.asked 实时 + idle 收尾 | ✅ PASS：question.asked=1、session.idle 收尾 |
| T5.5 permission always（E2E） | ask 规则 + always | 首次弹窗 + 同类免打扰 | ✅ PASS（根路径 /permission 验证；once/always 矩阵见 T6.2/T6.3 与审批矩阵） |
| T6.1 审批卡片 + 待办中心 | SSE + GET /permission | 卡片实时 + 待办跨 session 汇总 | ✅ PASS：SSE permission.asked=2、待办列表 2 条 |
| T6.2 审批通过（once） | response=once | 业务执行 + 单据流转 | ✅ PASS：http=200、DIR-OK、单据 closed/answered-delivered |
| T6.3 审批拒绝（reject） | response=reject | 业务不执行 + 决策交付 | ✅ PASS：http=200、FILE-BLOCKED、单据 closed/decision-delivered（首跑误用非法值 deny 得 400） |
| T6.4 发起方撤回（abort） | abort + 等租约清扫 | 待办清零 + 撤回语义 | ✅ PASS：~150s 后待办 0、单据 closed/instance-restart |
| T6.5 审批历史留痕 | PG hitl_request 审计 | 三种终态完整留痕 | ✅ PASS：answered-delivered / decision-delivered / instance-restart 三态齐备 |
| T7.1 跨用户隔离（修复） | x-user-id 列表/回复 | A/B 互不可见、越权回复 404 | ✅ PASS：列表 A=1/B=1/匿名=0；越权 404、本人 200；question 同隔离 |
| T7.2 同 session 多单 + always 级联 | 并行多命令 + always | 其余待审批单级联关闭 | ✅ 代码级确认（`listSessionPending` + evaluate allow → 批量 replied）；本轮模型未并行发起，集成触发依赖模型行为 |
| T7.3 edit 工具审批 | edit: ask + write | 单据 permission=edit，放行后写入 | ✅ PASS：once 后 `cat` 读出 hello-t73 |
| T7.4 审批中沙箱回收 | kill-sandbox + reply | 工具执行自愈 | ✅ PASS：reply 200、run 完成、bash completed |
| T7.5 拒绝意见 | 根端点 reply+message | result.message 留痕 | ✅ PASS：status=rejected + 意见原文 |
| T7.6 拒绝后 AI 行为 | reject → assistant | 有明确回复 | ✅ PASS（行为观察项） |
| T7.7 拒绝审计 | deny 规则 → exec_log | source=permission-deny 留痕 | ✅ PASS：含 permission/patterns/tool |
| T7.8 permission 长挂起 | 185s 后回复 | 不误清 + 沙箱存活 + 执行成功 | ✅ PASS：pending=1、沙箱存活、long-pending-ok |
| T7.9 external_directory 审批 | /etc 访问 | 单据 permission=external_directory | ✅ PASS |
| T7.10 规则优先级 | 会话 ask 覆盖默认放行 | 命中挂起 | ✅ PASS |
| T8.1 question 多问 + 部分回答 | 3 问含 multiple + 空答案 | run 完成 | ✅ PASS（3 问/multiple=True/空项） |
| T8.2 子 agent 审批归属 | task → curl | 归属子 session + user 继承 | ✅ 补跑 PASS（以 API 构造 parentID 子会话模拟：挂起属于子 session、user_id 继承、同用户可见/他人不可见、回复 200；模型自主调 task 两轮未复现，改用确定性构造） |
| T8.3 并发回复 | 双端同时 reply | 200 + 409 胜者独占 | ✅ PASS |
| T8.4 待办字段契约 | GET /permission | id/sessionID/permission/patterns/metadata 齐全 | ✅ PASS |
| T8.5 always 落库 + 粒度 | 确定性复验（强制调工具） | 落库 allow 行 + arity 前缀语义 | ✅ PASS 定论（payload.always=`npm config *`、session.permission 落 allow、日志 evaluated 命中；此前三次误判系 approved 同身份累积 + 模型未调工具的假象） |
| T8.6 always vs 后配 deny | 优先级 | 实测 always 优先 | ✅ PASS |
| T8.7 通过后命令失败 | `false`（exit 1） | metadata.exit 记录 | ✅ PASS |
| T8.8 实例死后决策收场 | reply + restart | 不悬空、行终态 | ✅ PASS（replied + part completed） |
| T8.9 重启后隔离保持 | restart + 按用户查 | B=1 匿名 0 | ✅ PASS |
| T8.10 挂起豁免 stall | 330s > 300s | pending 存活 + 回复执行 | ✅ PASS |
| 修复#2 approved 隔离 | 按 userId 分桶 | 同用户共享 / 跨用户隔离 | ✅ 单测 91/91（permission+hitl）、PG 单测 26/26、集成 2/2 |

---

> **复测记录（2026-09-14，全部 PASS，P1 验收关闭）**
>
> 环境：组合 3 变体——本地 PG（`postgresql://local@host.docker.internal:15432/opencode`）+ 远端 K8s 沙箱（`host.docker.internal:30040`）；镜像 `opencode-saas-sandbox-test:hitl-d83a45a4dd`（commit `d83a45a4dd`）；双容器 14096（实例 A）/ 14097（实例 B）共享同一 PG；模型 `Yd-DeepSeek/deepseek-v4-flash`。
>
> 修复提交：`05da6cf815`（P1 初版）→ `4787c2e021`（跨实例一致性/清扫顺序/隔离硬化）→ `6af42b6c08`（jsonb 字符串/幂等键序/ask 竞态修复 + PG 单测 35 例）。
>
> 补充语义（与原用例书的差异，均为设计文档 §4.10 的放宽/收紧）：
> - 已 replied 后的**不同决策**提交（如先 reply 再 reject）返回 **409 Conflict**（`ConflictError`，message 注明当前状态），而非 200——防止迟到提交覆盖胜者结果
> - T2.4 的收场方从「等待 stale-run 接管」提前为「存活实例的租约清扫」（~120s 内：租约 60s + grace 30s + 扫描周期 30s）
> - answered-lost 的答案回填文案为 `User answered: <答案>`（question）/ `User approved (once|always)`（permission）
>
> **复测记录（2026-09-14 二次，镜像 `hitl-cbf2276a-wip2`（含 pgJsonb/LEASE_TOOLS/四偏离修复 + maintain 首刷 delay），同环境，全部 11 例重跑）**：
>
> | 用例 | 结果 | 实测 |
> |---|---|---|
> | T1.1/T1.2 | ✅ | pending=1（按 sessionID 精确过滤）；questions 完整含「继续」选项 |
> | T1.3 | ✅ | reply 200；part `completed` + 答案回填「测试流程是否继续？」=「继续」；pending 归零 |
> | T2.1 | ✅ | docker restart 后旧 QID 仍在 pending 列表 |
> | T2.2 | ✅ | reply 旧 ID 200；随后 reject **409**（冲突保护） |
> | T2.3 | ✅ | PG 行 status=pending（重启前）/ replied（reply 后） |
> | T2.4 | ✅ | 重启前 part running（悬空）→ 租约清扫自动收场：行 `closed/answered-delivered`、part `completed`「User answered: 继续」 |
> | T2.5 | ✅ | 补发消息 LLM 复述「继续」 |
> | T3.1/T3.2 | ✅ | permission ask=1；重启后 pending 保留 + reply always 200 + `session.permission` 落 `rm *→allow`；**重启后同 pattern 0 次新 ask**、rm 命令直接 completed |
> | T4.1 | ✅ | 实例 B（14097）reply 实例 A 的 question 200 → A 轮询消费 pending 清零 → part completed 答案回填 |
>
> 补充语义（与原用例书的差异，均为设计文档 §4.10 的放宽/收紧）：
> - 已 replied 后的**不同决策**提交（如先 reply 再 reject）返回 **409 Conflict**（`ConflictError`，message 注明当前状态），而非 200——防止迟到提交覆盖胜者结果
> - T2.4 的收场方从「等待 stale-run 接管」提前为「存活实例的租约清扫」（~120s 内：租约 60s + grace 30s + 扫描周期 30s）
> - answered-lost 的答案回填文案为 `User answered: <答案>`（question）/ `User approved (once|always)`（permission）

---

> **复测记录（2026-09-16，新增真实场景与飞书式审批小节，全部 PASS）**
>
> 环境：本地 PG + 远端 K8s 沙箱，镜像 `person-model-connect`（feat/opencode-1.18.31 工作区），真实 LLM `Yd-DeepSeek/deepseek-v4-flash`。
>
> 本轮覆盖 §五（T5.1–T5.5 真实用户旅程）与 §六（T6.1–T6.5 飞书式审批）：
> - **T5.1/T5.2 答案驱动行为**：question 回复真实改变 AI 产物（选 python → `.py`；选「取消」→ 不执行删除）
> - **T5.3 长挂起**：185s（> 清扫窗口 120s）pending 未被误清、autokeepalive 沙箱存活、迟到回答唤醒 run——挂起期间租约由活跃 run 续期
> - **T5.4 SSE**：question.asked 实时推送、reply 后 message 事件续流并以 session.idle 收尾
> - **T6.1–T6.5 审批闭环**：卡片推送 → 待办汇总 → once 通过（业务执行）/ reject 拒绝（业务阻断）/ abort 撤回（租约清扫）→ 三终态留痕（`answered-delivered` / `decision-delivered` / `instance-restart`）
>
> **接口语义踩坑（已写入 §六 首段）**：
> 1. 待办列表用**根路径** `GET /permission`（`GET /session/:id/permissions` 不是列表端点——首跑 T5.5 因此误判）
> 2. 审批回复 body 为 `{"response":"once"|"always"|"reject"}`——**`deny` 是非法值**（400），拒绝用 `reject`；`deny` 仅作 ruleset 的 action 值（规则命中直接拒、不弹窗，见审批矩阵 D）
> 3. `abort`（发起方撤回）不即时关闭挂起单——由租约清扫在 ~120–150s 内以 `closed|instance-restart` 收场；`DELETE /session` 则由 FK 级联立即清理
>
> **附加验证（审批矩阵）**：once 放行后同类命令**再次弹窗**（不持久）；always 放行落 `session.permission`（`npm *→allow`）且同类**免打扰**（挂起仅 1 次）；`deny` 规则**不弹窗直接拒**（无 HITL 行）。

---

> **复测记录（2026-09-16 二轮：跨租户隔离修复 + 覆盖补全 T7.x）**
>
> 环境：本地 PG + 远端 K8s 沙箱，镜像 `person-model-hitliso`（含 hitl_request.user_id 修复），真实 LLM `Yd-DeepSeek/deepseek-v4-flash`。
>
> **修复内容**：`hitl_request` 加 `user_id`（'' = 公共/匿名）；ask 时从运行上下文注入发起用户；`list` 按请求 header 过滤；`reply`/`reject` CAS 加归属条件（跨用户 = 404 防枚举，内部善后不过滤）。
>
> **验证**：单测 26/26（含新增 listPending 用户过滤 + casTransition 跨用户拒绝/善后不受限 2 例）；集成 T7.1 隔离 4/4；T7.3–T7.10 全 PASS（除 T7.2 依赖模型并行调用行为）。typecheck 58 = 基线。
>
> **接口语义补充**：
> - 拒绝意见只能走根端点 `POST /permission/:requestID/reply`（body `{reply, message}`）；会话级端点 body 仅 `{response}`，无意见字段
> - `deny` 规则的拒绝留痕在 `exec_log`（`source=permission-deny`），不在 hitl_request（不弹窗即无单据）
> - 审批挂起中沙箱被回收后，迟到回复可自愈（重建沙箱重试一次）

---

> **复测记录（2026-09-16 三轮：审批边界补全 + always 批准按用户隔离）**
>
> 环境：本地 PG + 远端 K8s 沙箱，镜像 `person-model-userapproved`，真实 LLM `Yd-DeepSeek/deepseek-v4-flash`。
>
> **修复 #2**：`approved` 由 instance 级数组改为 `Map<userId, Rule[]>`（PendingEntry 携带 userId）。动机：实测发现用户 A 的 `always` 批准会泄漏给用户 B 的所有会话（SaaS 同 directory）。保留「同用户跨会话共享」的既有便利语义（既有单测 `reply - always persists approval and resolves` 编码该语义，未破坏），仅隔离跨用户。单测 91/91、PG 单测 26/26、集成（A1→A2 共享 / B 隔离）2/2。
>
> **接口语义补充**：
> - `always` 落库与粒度已**定论（2026-09-17）**：pattern = arity 前缀 + ` *`，正确写入 `session.permission`（日志与 SQL 双证据）；此前「未落库」的怀疑系三层假象——① 模型有时不调 bash（直接文本答）② `approved` 按身份（匿名=）跨会话累积使后续不弹 ③ 查询时机。对同一容器连续跑多个审批用例时，建议用不同 `x-user-id` 隔离（approved 按身份分桶）
> - `always` 批准优先于后配的 `deny`（approved 位于规则合并尾部，findLast 命中）
> - 审批挂起豁免 LLM stall（330s > 默认 300s 仍存活），与 question 挂起一致
> - 命令执行失败经 `state.metadata.exit` 呈现（非 error 状态）
>
> **能力缺口（待产品决策）**：批量审批端点、审批过期自动决策、会签/多审批人。
>
> **本轮用例执行完整性核对（2026-09-17 定稿）**：T8.1–T8.10 均有实测运行且全部定论。其中 T8.2 首两轮因模型未在 task 子 agent 内执行命令而不可复现，后**改用 API 构造 `parentID` 子会话**做确定性验证并通过（归属/继承/隔离/回复四项）；T8.5 经**确定性复验（强制调工具 + 日志/SQL 双证据）定论为 PASS**——`always` 落库正常（`session.permission` 追加 allow 行）、粒度 = arity 前缀 + ` *`；此前三次误判均系假象（模型未调工具的假阳性 + approved 按匿名身份跨会话累积 + 查询时机），并在用例中沉淀了「断言须检查 bash tool part 存在性」「多轮测试用不同 x-user-id 隔离 approved」两条经验。

---

> **复测记录（2026-10-12，feat/opencode-1.18.31 分支全量 38 例，最终全 PASS）**
>
> 环境：组合 1——**远端 PG + 远端 K8s 沙箱**，容器 `opencode-saas-test` @14096（镜像 `opencode-saas-sandbox-test:152c8587db`，分支头 commit），模型 `Yd-DeepSeek/deepseek-v4-flash`。自动脚本两轮：第一轮全量 T1.1–T8.10（20 PASS / 20 FAIL），第二轮重跑 8 例 + 数据复核改判，**最终 38/38 全 PASS**。
>
> **⚠️ 本轮最重要发现：消息结构 schema 变更（1.18.31 merge 后）**
> `/session/:id/message` 的消息对象从旧版顶层 `role`/`id` 变为 `{info: {id, sessionID, role, time: {created, completed}}, parts: [...]}`，且 parts 采用 step 语义（`step-start`/`reasoning`/`tool`/`text`/`step-finish`）。**本文件所有用例中按 `m.get('role')` 过滤 assistant 的 python 片段已全部失效**（过滤结果恒为空 → 误判「无文本/run 未完成」）。正确写法：`m['info']['role']=='assistant'` + 按 `m['info']['time']['created']` 排序取最新。第一轮 20 例 FAIL 中 12 例纯由此导致（复核后文本全部存在：T1.3「你选择了继续」/T2.5 复述「继续」/T5.3「已收到，继续」/T7.7 deny 拒绝说明/T5.5「11.17.0」/T8.10「root」等）。
>
> **语义更新（与旧复测记录的差异）**：
> - **T2.4 清扫时间**：实测租约清扫收场可超过 150s（本轮一次 ~3-4 分钟才 `closed|instance-restart`）——旧记录「~120s」偏乐观，用例等待建议放宽至 240s；收场语义本身正确（行终态 + question part error）
> - **T7.2 级联粒度**：本轮模型真实并行发起了 2 单（`npm --version` + `npm config get registry`），对第一条 always 后第二条**未级联**——级联按 **arity 前缀**执行（allow 落的是 `"npm --version *"`，不匹配 `npm config get registry`），与 T8.5 arity 定论一致。用例期望应表述为「同 arity 前缀的其余待审批单级联关闭」
> - **T7.5 status 语义**：根端点 reject 带意见 → 行终态为 `closed|decision-delivered`（旧记录的 `status=rejected` 已统一进 closed 语义，与 T6.3 会话级 reject 一致），`result.message` 意见原文保留 ✓
>
> **测试方法沉淀（脚本坑，复用注意）**：
> 1. macOS `date` 不支持 `%3N`（毫秒时间戳）——生成 since 时间戳会带字面 `3N` 导致内嵌 python 比较语法错误、wait 函数静默永远超时
> 2. bash 后台子 shell 的变量赋值不回传父 shell（T8.3 并发 HTTP code 需落临时文件）
> 3. `grep -c` 计**行数**不计匹配次数（单行内多次 completed 会漏计，用 `grep -o | wc -l`）
> 4. `GET /permission`/`GET /question` 列表与 PG 直查存在秒级刷新延迟——双通道判定时勿在 PG 首中后立即断言「列表不可见」
> 5. 同一 `x-user-id` 身份的 approved 会跨会话累积（既有设计）——连续跑审批用例仍建议按用例独立身份隔离
>
> **环境事件**：测试中段 OrbStack daemon 崩溃一次（docker.sock 消失，`pkill OrbStack && open -a OrbStack` 恢复），与被测系统无关。
>
> **遗留观察项（未定论，低优先级）**：第一轮 T7.8 的挂起行于 11:32:53 被一次**非脚本发起的 `{"reply":"always"}`** 关闭（随后 T7.10 的同 pattern `uname*` 命令未再挂起，症状吻合 approved 匿名桶被该 reply 写入）；第二轮复测 T7.8 全程正常未复现。来源未溯源（本机其他容器连的是不同库 `opencode-v2-test`，已排除）。
