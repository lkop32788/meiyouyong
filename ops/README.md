# OmniClick 部署与进程监管

## 背景

在此之前，这套系统的所有进程都是手工前台启动、由 init 收养的孤儿：崩溃不重启、重启不恢复、没有日志归集。`realtime-server` 甚至根本没在运行，导致 `time.37182.club` 对每个用户都返回 502。也没有任何定时任务机制——`routes/console.php` 里的调度从未被触发过。

## 安装

```bash
sudo ./ops/install.sh            # 安装 + 启用 + 启动
sudo ./ops/install.sh status     # 只看状态
sudo ./ops/install.sh uninstall  # 停止并移除
```

脚本是幂等的，改完 unit 文件重跑即可。它会先停掉端口上残留的、不归任何 unit 管的手工进程，避免 systemd 启动第二份导致端口冲突。

## 包含的服务

| Unit | 作用 |
|---|---|
| `omniclick-gateway.service` | Webhook 网关（Express，:3001） |
| `omniclick-realtime.service` | Socket.io 实时服务（:3002） |
| `omniclick-queue.service` | Laravel 队列 worker（Redis 连接） |
| `omniclick-scheduler.timer` | 每分钟跑一次 `schedule:run` |

用 **systemd timer 而非 cron**：这台机器没装 cron。

## 未纳入的：`rabbitmq:consume`

入站消费者**故意没有做成 unit**。启动它等于**首次打开入站链路**，而目前 `dispatcher:requests` 有 3 个发布者、**0 个订阅者**——也就是说客服自动分配根本不存在，进来的会话会永远停在 `pending` 状态。

在会话转接 UI 落地之前启动它，只会堆出一批无人处理、也无人看得见的会话。转接接口（`POST /api/conversations/{id}/assign`）已经存在，只差界面。

## 已知限制：应用位于 `/root` 之下

所有 unit 都以 **root** 运行，因为 `/root` 是 `drwx------`（700），`www-data` **根本无法穿越进去**。

这不只是"不够优雅"，它是 **php-fpm 切换的硬前置**：php-fpm 以 www-data 运行时同样无法从 `/root` 读取代码。换句话说，切 php-fpm 需要**先把应用迁出 `/root`**（例如 `/srv/omniclick`），而不只是装个包。

迁移之后，`omniclick-queue.service` 与 fpm 池必须使用**同一个用户**——否则 `ExportReportJob` 写出的导出文件归属一个用户、Web 层归属另一个，两者还会争抢 `storage/logs/laravel.log` 的所有权。

## Redis 必须用打包的 systemd 服务

`redis-server.service` 是 Debian 包自带的，之前处于 disabled 状态，运行中的是一个在**仓库目录下手工启动**的实例。后果有三个：

| 项 | 手工实例 | 打包服务 |
|---|---|---|
| 监听地址 | `0.0.0.0:6379`，**无密码** | `127.0.0.1` + `[::1]` |
| 数据目录 | **仓库根目录**（快照写进工作区） | `/var/lib/redis` |
| 运行用户 | root | `redis` |
| 重启存活 | 否（PPID=1 孤儿进程） | 是 |

```bash
systemctl enable --now redis-server
```

本仓库的所有 unit 都声明了 `After=redis-server.service`，启用后该依赖才真正生效。

**不要在仓库目录下手工执行 `redis-server`** —— 不带配置文件启动时，`dir` 默认取当前工作目录，快照就会重新落回工作区。

## 常用命令

```bash
systemctl status omniclick-realtime
journalctl -u omniclick-queue -f          # 跟踪队列日志
systemctl list-timers omniclick-scheduler # 下次触发时间
php artisan schedule:list                 # 调度器认为该跑什么
php artisan queue:failed                  # 失败任务（落 MySQL failed_jobs 表）
```

## 回退

每个 unit 都是独立的，`systemctl stop <unit>` 即可，互不影响。队列 worker 停掉之后任务会堆在 Redis 里等待，不会丢失。
