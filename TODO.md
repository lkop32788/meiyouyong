# OmniClick 修复进度与待办

> 最后更新：2026-09-15 ｜ 后端测试 **125 passed / 279 assertions**（起点 2）

这份文件记录一轮系统性排查与修复的进度。排查结论是：**问题不是"有些功能没做完"，而是多条核心链路在静默失败**——没有测试、没有监控、错误被 `.catch(() => {})` 之类的写法吞掉，所以一直没人发现。

---

## 一、当前 PR 链

**6 个 PR 依次堆叠，每个基于前一个。建议按序合并。**

| PR | 分支 | 内容 |
|---|---|---|
| [#6](https://github.com/lkop32788/meiyouyong/pull/6) | `fix/remediation-batch-1` → `master` | 权限边界、路由可达性、job 层死代码、测试基建 |
| [#7](https://github.com/lkop32788/meiyouyong/pull/7) | `feat/ops-supervision` | 队列切 Redis、systemd 进程监管 |
| [#8](https://github.com/lkop32788/meiyouyong/pull/8) | `feat/conversation-transfer` | 会话转接 UI、已读接口 |
| [#9](https://github.com/lkop32788/meiyouyong/pull/9) | `feat/inbound-consumer` | 打通入站链路 |
| [#10](https://github.com/lkop32788/meiyouyong/pull/10) | `fix/security-hardening` | Redis 暴露面、仓库内快照、生产调试模式 |
| [#11](https://github.com/lkop32788/meiyouyong/pull/11) | `feat/telegram-adapter` | Telegram 收发两端 |

⚠️ **链条越长，任何一环需要改动都会牵连后面全部。优先合并。**

---

## 二、已完成

### 安全

- **主管提权** —— `update`/`destroy` 只校验 `canOverrideAssignment()`，而它对 supervisor 返回 true。主管可自我提权为管理员、重置管理员密码、停用管理员。新增 `assignableRoles()` / `canManageMember()` 显式矩阵
- **会话越权** —— 渠道过滤只在 `index()`，`show`/`resolve`/`reopen`/`assign`/`snooze` 与消息读写全无校验。抽出 `Conversation::scopeVisibleToAgent()` 并在所有取数入口套用
- **Redis 无密码暴露在 `0.0.0.0`** —— 改用打包的 systemd 服务，绑定 `127.0.0.1`
- **`dump.rdb` 被 git 跟踪**，且 Redis `dir` 就是仓库根目录。网关会把**解密后的渠道密钥**明文缓存进 Redis（TTL 5 分钟），快照落在工作区即等于凭据入库
- **生产环境 `APP_DEBUG=true`**，异常会返回完整堆栈与解析后的配置

### 从未成功运行过的代码

| 位置 | 问题 |
|---|---|
| 队列层 | `QUEUE_CONNECTION=rabbitmq` 在 `config/queue.php` 里根本没定义，每次 dispatch 都抛异常 |
| `ConsumeRabbitMQ` | 队列参数与网关不一致，`PRECONDITION_FAILED`，消费者启动不了 |
| `ProcessedWebhookEvent` | 模型文件不存在，入站第一行就 `Class not found` |
| `updateAfterMessage` | `DB::raw()` 撞上 `casts => 'integer'` |
| `HourlyVolumeAggregationJob` | `ch.channel_type` 列不存在，硬 SQL 错误 |
| `BuildAudienceJob` | 同列名错误 + `OPENJSON`（T-SQL），导致每个活动被标记 `failed` |
| 4 处 `send()` | 参数个数不匹配，`ArgumentCountError` |
| `AnalyticsController` | T-SQL 跑在 MySQL 上，两个接口 500 |
| `/system` 模块 | 路由前缀 `system`，前端 baseURL `/api`，三个页面全 404 |

### 静默失败

- `PUT /conversations/{id}/read` 后端不存在，前端 `.catch(() => {})` 吞掉 → 未读数永远清不掉
- `AnalyticsPage` 的 `Promise.all` 无 `.catch` → 一个接口失败，五个标签页全空
- `useConversationStore` 未做 snake→camel 映射 → **整个会话头部是空的**
- `MESSAGE_STATUS_UPDATE` 不带 `conversation_id` → 一直推给空房间
- 死信队列以 `#` 绑定在 **direct** 交换机上 → 过期消息被直接丢弃
- CSAT 先发送后写守卫行 → 发送失败重试会**向真实客户重复发调查**
- 首条消息重复计数 → 新会话收到一条消息显示未读 2

### 基建

- **测试从 sqlite 换到 MySQL**。仓库已出过三个方言 bug，而 sqlite 不支持 `DAYOFWEEK` / `TIMESTAMPDIFF` / `JSON_CONTAINS` 中的任何一个——测试一直在给虚假信心
- 全部进程纳入 systemd（网关、实时、队列 worker、调度器 timer、7 个入站消费者）
- `time.37182.club` 从**对每个用户 502** 变成 200

---

## 三、待办

### P0 —— 阻塞其他工作

- [ ] **合并现有 6 个 PR**。链条太长，越拖成本越高
- [ ] **应用迁出 `/root`**（如 `/srv/omniclick`）
      `/root` 是 `drwx------`，**www-data 无法穿越**。这是 php-fpm 切换的硬前置，不是装个包就行

### P1 —— 用户可见的缺口

- [ ] **消息模板 UI** —— 后端是完整的 WhatsApp 模板报备流程（提交 Meta、审批回调、`wa_template_id`），**零界面**。而 `CampaignController` 接受 `template_id`、前端从不传 → **群发功能残缺**（WhatsApp 超 24 小时窗口必须用已报备模板）。注意后端**没有 PUT 路由**
- [ ] **php-fpm 切换** —— 当前 `php artisan serve` 是**单 worker**，而 nginx 给 `/api/ai/` 的超时是 300 秒：一个人点 AI 生成会阻塞**全部** API 最长 5 分钟。这是目前真正影响用户的生产缺陷
- [ ] **分析导出下载路由** —— job 写文件到 `storage/app/exports/`，但**没有任何路由能把它给用户**。要么加签名下载路由，要么去掉导出按钮
- [ ] **快捷回复增删改 UI** —— 前端只 GET
- [ ] **活动收件人视图** —— `GET /campaigns/{id}/recipients` 无界面，看不到谁发失败
- [ ] **会话延后 UI** —— `/snooze` 接口在，UI 只有状态色

### P2 —— 功能补全

- [ ] **webchat 渠道** —— 唯一还没有适配器的可创建类型。需要出站适配器 + 入站端点 + 前端嵌入组件。无第三方依赖，路径其实比第三方渠道短
- [ ] **sms 入站** —— 出站有 Twilio 适配器，无入站路由与归一化器
- [ ] **表情回应** —— 要么三层全做（Mongo 字段 + `formatMessage` 输出 + 适配器发给渠道），**要么把表情选择器藏起来**。只加接口会得到只写不读的字段，而前端是乐观更新，会从「刷新前撒谎」变成「持续撒谎」
- [ ] **热力图数据源** —— `inbound_count` 需要 MongoDB 消息聚合，目前无人写入。注意**不能**按 `resolved_at` 分桶：周一进来周五解决的会话会把全部消息记到周五，那不是慢，是假数据
- [ ] 手动健康巡检 / QR 同步 / FB 断开 —— 三个接口无 UI 入口

### P3 —— 清理与加固

- [ ] **渠道健康巡检的 `disconnected` 语义** —— 目前 `ChannelHealthService::checkWhatsappQr()` 的 `match` 没有该分支，落到 `default => 'down'`。已用 `--no-deactivate` 拆弹，但根因未解：「只是退出登录」不应等同于「故障」。修好之后还要再决定是否恢复自动停用
- [ ] **网关零测试** —— 连测试目录都没有，尽管 `CLAUDE.md` 写着 `npm test`
- [ ] **RabbitMQ 监听 `*:5672`** —— 默认 `guest` 只允许本机连接，暴露程度低于 Redis，但值得收到 `127.0.0.1`
- [ ] `deploy.sh` 只管前端，不迁移、不重启后端
- [ ] 死代码：`CompanySubscription`（无引用）、`NAV_ITEMS`（定义后从不读）、`usePresenceStore.setAgents`（从未调用，导致在线列表刷新即空）
- [ ] `UserAuditLog` 只写不读，无查询接口
- [ ] Facebook 入站归一化内联在路由里，未放进 `normalizer/`
- [ ] `AgentDailyRollupJob` 的 `messages_sent` 硬编码为 0
- [ ] `users.last_seen_at` 只在登录时写，语义其实是「最后登录」

---

## 四、已做的决策（避免重复讨论）

| 议题 | 决定 | 理由 |
|---|---|---|
| Laravel 队列 | **Redis** | `config/queue.php` 无 rabbitmq 连接，社区驱动不支持 L13。RabbitMQ 保留给网关→后端的入站管道（那是手写消费者，与 Laravel Queue 无关） |
| 分析 SQL 方言 | **MySQL** | 以实际部署为准，改写 T-SQL |
| 客服分配 | **手动** | `dispatcher:requests` 有 3 个发布者、**0 个订阅者**，自动分配服务不在本仓库。转接 UI 是最短路径 |
| 渠道类型 | **一个都不删** | 用户明确要求「不丢失渠道」。telegram 已补齐，webchat 待做 |
| 测试数据库 | **独立 schema** | `RefreshDatabase` 会清空 `DB_DATABASE` 指向的库，绝不能是应用库 |

---

## 五、踩过的坑（别重蹈）

- **不要在仓库目录下手工执行 `redis-server`** —— 不带配置文件启动时 `dir` 默认取当前工作目录，快照会落回工作区。用 `systemctl enable --now redis-server`
- **不要跑 `vendor/bin/pint`** —— 全仓 90+ 个文件不合规（主因是通用的 `=>` 对齐风格与默认预设冲突），跑它会产生全仓重排
- **`app()->instance($k, null)` 绑不上** —— 容器解析实例用 `isset()` 判断，而 `isset(null)` 为 false。要用闭包绑定
- **`Redis::shouldReceive()` 建的是完整 mock** —— 任何未打桩的方法都会抛异常，需要 `shouldIgnoreMissing()`
- **`ONLY_FULL_GROUP_BY` 下 `DAYOFWEEK(x)-1` 与 `DAYOFWEEK(x)` 不算同一表达式** —— 要按别名分组
- **Telegram 对被拉黑/未知会话返回 HTTP 200 且 `ok=false`** —— 只看状态码会把失败当成已送达
- **`composer` 以 root 运行会中止** —— 直接用 `php artisan test`，或设 `COMPOSER_ALLOW_SUPERUSER=1`
- **`/root` 是 700** —— 任何以 www-data 运行的东西都读不到这里的代码

---

## 六、参考实现

`/root/wabapanel` 是一个同类项目，本仓库已从它借鉴过 WhatsApp QR 流程（见 `gateway/services/baileysManager.js:6`）与渠道连接流程（`ChannelConnectionController.php:15`）。

可继续参照的部分：

| 渠道 | 参照文件 |
|---|---|
| Telegram | `src/services/telegramService.js`（80 行，已用于 #11） |
| Facebook Messenger | `src/services/qrAutomation.js:38` —— `/me/messages?access_token=` 的正确形态 |
| WhatsApp Cloud | `src/services/whatsappService.js` |
| Instagram | `src/services/igAutoDmService.js` |

**LINE 与 webchat 在 wabapanel 里没有实现**，无处可抄。
