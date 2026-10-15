# dsh-badge-notify

DSH 任务栏徽标：在 **Windows 任务栏的 DSH 图标周围**（贴着图标轮廓，不是任务栏外围）
叠画一个鼠标穿透的浮层。

- **数字徽标**：ChatGPT 风格——黑底圆角方块 + 白色数字＝**未读**的已完成会话数。
  徽标**坐在图标右上角上方**（中心抬升 `badge.lift`×徽标边长，默认 0.5＝徽标底边正贴着图标顶边），
  所以不再遮住图标本身。
  - 「未读」与 DSH 侧边栏的小绿点**同义**：会话跑完时你正在看它就不计数；跑完后你打开它即视为已读，计数自动减掉
  - 想改回「所有完成都计数」：`badge.unreadOnly: false`
- **提示点**：中心落在图标左边缘线上，自上而下排列。**每种提示只有一个点**（`dots.group: "kind"`）
  - 黑点 = 有提问待回答（`user-questions/request`）——需要人工介入
  - 黄点 = 有权限申请待批准（`approval/request`）
  - 第一个点与徽标**同一水平线**（左上角位置），第二个点落在左边中点；同类的多个待处理仍只有一个点
  - 想回到“每个待处理项一个点”，把 `dots.group` 改成 `"item"`

## 形态

- **Host 半端**（`lib/index.js`，跑在 DSH 进程里）：订阅 `agent/status`（running→idle 记一次
  完成）、`user-questions/request`、`approval/request`（waterfall 观察者，用 `prepend` 抢在
  应答方之前，否则请求被应答方 claim 后就看不到了）。状态写入 `state.json`，并注册
  `/api/dsh-badge-notify/*` 三条 loopback 路由与系统提示词说明。
- **浮层半端**（`assets/BadgeNotify.ps1`，独立进程）：用 **UI Automation** 定位 DSH 的任务栏按钮
  （`Appid: com.deepseek.dsh`，不需要提权、不碰跨进程内存），再从按钮自身像素里量出
  **图标本体** 的位置，最后用 `UpdateLayeredWindow` 画带 alpha 的黑底白字徽标与提示点。
- **鼠标穿透**（默认）：`WS_EX_TRANSPARENT`，不挡任务栏图标的点击。窗口不进 Alt+Tab、不抢焦点。
- **脱离宿主**：宿主 spawn 时 `windowsHide`（CREATE_NO_WINDOW），DSH 重启不影响已在跑的浮层。

## 图标定位（为什么要量像素）

任务栏按钮（UIA 给的 66×72）比图标本体大得多，直接把徽标贴在按钮角落就会落在**图标外围**
——所以浮层会截取按钮一帧，取众数色当背景，对差异像素做**连通分量**分析，取最靠近中心的那一块
（真图标），得到**字形外接框**。这条路上有两类噪声被自动排除：相邻按钮的边缘带、
运行中应用的下划线指示条。量不出来时回退到“按钮中心按 `iconScale` 取方形”的几何估算。

锚点用的是这个外接框（`anchor.iconPad` 放大系数，默认 `1.0`＝正好是字形轮廓）：

- 徽标中心 = 外接框**右上角**再向上抬 `badge.lift`×徽标边长（默认 0.5）
- 提示点中心 = 外接框**左边缘**；第一个点默认与徽标中心同高（`dots.start: badge`），
  之后按 `点径 + dots.gap` 依次向下，直到图标底边（点太多时自动压缩间距并缩小点径）

因为标记在轮廓上/轮廓外，浮层画布比图标外接框四周大 `pad` 像素（= 抬升量/半标记 + 描边 + 2），
窗口也相应外扩。27×20 的鲸鱼图标上实测：`pad=20`，画布 67×60，徽标 16px、提示点 15px。

**量像素时必须先把浮层藏起来**：否则自己画的徽标会被当成“图标墨迹”，连通分量一轮比一轮大
（实测 30→32→35→38px 每 30 秒膨胀一次），徽标和提示点会慢慢爬离图标。

## 配置

`%LOCALAPPDATA%\DshBadgeNotify\config.json`（用户文件：缺失才写；架构版本 `configVersion` 变化时
刷新，旧文件备份为 `config.json.bak`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `anchor.target` | `icon` | `icon`＝贴图标本体；`button`＝贴整个按钮矩形 |
| `anchor.referencePx` | `27` | 调参时用的图标基准边：所有**绝对像素**键都按 `基准边/referencePx` 缩放，换机器等比 |
| `anchor.iconScale` | `0.5` | 量不出图标时的方形边长比例（相对按钮短边） |
| `anchor.iconPad` | `1.0` | 字形外接框放大系数：`1.0`＝锚点正好在字形轮廓上 |
| `anchor.calibrate` | `true` | 关掉就只用几何估算 |
| `anchor.offsetX/Y` | `0` | 浮层整体位移 |
| `anchor.iconOffsetX/Y` | `0` | 图标框位移（微调到“正贴在图标上”） |
| `badge.unreadOnly` | `true` | `true`＝只统计**未读**的完成（与绿点同义）；`false`＝所有完成都计数 |
| `badge.sizeRatio` | `0.73` | 徽标边长 ÷ 图标边长（`badge.size>0` 时改用绝对像素） |
| `badge.lift` | `0.5` | 徽标中心相对图标右上角抬高多少（×徽标边长）：`0.5`＝徽标底边贴着图标顶边，`0`＝中心落在角上 |
| `badge.insetX/Y` | `0` / `3` | 徽标中心再往左/往下微调多少像素 |
| `badge.fontSizeRatio` | `0.8` | 数字字号 ÷ 徽标边长（`badge.fontSize>0` 时改用绝对像素）；数字按**真实墨迹**居中，`textOffsetX/Y` 可再光学微调 |
| `dots.sizeRatio` | `0.56` | 提示点直径 ÷ 图标边长（`dots.size>0` 时改用绝对像素） |
| `dots.gap` | `3` | 提示点之间的缝；`fit` 模式下点太多会自动压缩，保证不越过图标底边 |
| `dots.start` | `badge` | `badge`＝第一个点与徽标同一水平线；`corner`＝第一个点落在图标左上角 |
| `dots.mode` | `fit` | `fit`＝压缩点径塞进图标高度；`fixed`＝保持点径+缝，允许向图标下方溢出 |
| `dots.group` | `kind` | `kind`＝每种提示一个点（黑点/黄点各最多一个）；`item`＝每个待处理项一个点 |
| `dots.insetX` | `-3` | 提示点**中心**相对图标左边缘的横移量 |
| `dots.insetY` | `2` | 第一个点再往下多少像素 |
| `dots.max` | `2` | 最多画几个点 |
| `dots.order` | `kind` | `kind`＝先黑点后黄点；`time`＝按发生时间 |
| `clickThrough` | `true` | 鼠标穿透 |
| `pollMs` | `500` | 状态轮询间隔 |
| `buttonRefreshMs` | `4000` | 按钮矩形重读间隔（UIA 跨进程调用，别设太小：会吃 CPU） |
| `buttonSearchMs` | `120000` | 健康元素的后台重发现间隔（防 explorer 重启后句柄失效） |
| `buttonRetryMs` | `4000` | 查找失败后的重试间隔（否则一次 UIA 抖动会白屏一整个慢周期） |

改完约 2 秒内自动生效（浮层持续盯着 `config.json` 的修改时间，变了就重读、重新校准图标框并重画）。

尺寸的自适应基准是“图标方形边长”＝`max(字形宽,字形高) × iconPad`；在 27×20 的 DSH 鲸鱼图标上
即 27px。所有尺寸都是它的比例，剩下的绝对像素键再按 `基准边 / anchor.referencePx` 缩放
（本机 `referencePx = 27`，即 1:1），所以换台电脑、换 DPI、换任务栏缩放都只会等比变化。

## 手动调参（不想改配置文件时）

往数据目录写一份 `preview.json`，浮层就固定画这些标记、忽略真实事件，方便对着任务栏调
`config.json`（改完约 2 秒生效）：

```json
{ "enabled": true, "count": 8, "dots": ["question", "approval"] }
```

删掉该文件（或 `"enabled": false`）立刻回到实时状态。模板见 `assets/preview.example.json`。

## 管理 API（仅 loopback POST）

| 路由 | 作用 |
|---|---|
| `/api/dsh-badge-notify/status` | 运行状态 / pid / 已完成数 / 待处理列表 |
| `/api/dsh-badge-notify/start` | 部署（含载荷升级：内容变了就重启浮层）+ 拉起 |
| `/api/dsh-badge-notify/stop` | 停止浮层（记 `stopped.flag`，DSH 重启不会自动拉回） |
| `/api/dsh-badge-notify/clear` | 已完成计数清零 |
| `/api/dsh-badge-notify/read` | 客户端半端上报「当前主视图打开的会话集合」`{"sessionIds":[...]}`，这些会话视为已读、不再计数 |

Web GUI：**设置 → 插件 → 任务徽标**（状态点、启停、清零、待处理列表，5s 轮询）。

### 未读语义从哪来

DSH 侧边栏的绿点由客户端 `completionUnread` 决定（`dsh-client-ui-session`），它只在
`retainedBy.mainView > 0`（该会话正开在主视图）时消除。这个保留计数**只存在于浏览器侧**，
宿主完全不知情，所以插件用一个客户端半端把这份状态镜像给宿主：

- 订阅 `ctx.get('sessions')` 的列表快照 + 每个会话的 `retainInfo(id)`；
- `retainedBy.mainView > 0` 的会话即「已读」，整集 POST 到 `/read`；
- 宿主据此维护两件事：正在看的会话完成时不计入、已读的会话从计数里退掉。

不猜测点击、不使用计时器，规则与 DSH 绿点完全一致。

## 诊断

- `%LOCALAPPDATA%\DshBadgeNotify\logs\host.log`：宿主半端各阶段（apply 各步、boot 结果、
  事件命中）。这里能看到 `apply: xxx FAILED`——宿主里的异常否则只会表现为“插件没反应”。
- `%LOCALAPPDATA%\DshBadgeNotify\logs\badge-notify.log`：浮层半端。每次画面变化记一行：
  ```
  draw box 2039,2110 27x27 source=measured ink=316 glyph=27x20@32,36 bg=235,239,249
  anchor ink 2040,2115 27x20
  frame count=2 dots=1 canvas=51x44@2028,2103 pad=12 badge=16 dot=9 icon=27x20
  ```
  `draw box` 是按钮内图标框，`anchor ink` 是真正用来定位的**字形外接框**，
  `canvas` 是分层窗口的位置与大小。查“徽标跑到哪去了”看这三行最快。
  若出现 `slow tick: previous poll took ...ms (UIA may be blocking)`，说明某次 UIA 调用卡了很久
  （树劣化时会发生）；若出现 `UIA: no DSH button among N taskbar buttons: ...`，会一并列出
  任务栏上真实存在的按钮，便于核对 `buttonMatch`。
- 手动体检（会打印测到的图标框与外接框，然后退出，不进消息循环）：
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\DshBadgeNotify\BadgeNotify.ps1" -Calibrate
  ```
  输出形如 `MEASURED icon: 2039,2110 27x27 ... buttonOffset=+19,+22` +
  `ANCHOR ink  : 2040,2115 27x20`。

## 已知坑（实现记录）

- **`-shl` 会按左操作数类型截断**：`[byte]235 -shl 16` 在 PowerShell 里回绕成 0，颜色打包必须用
  乘法（`[int]$c.R * 65536`）。
- **UIA 要非沙箱进程**：在受限 token 下 `OpenProcess` 拿 explorer 会被拒、UIA 只看得到几十个元素，
  任务栏按钮根本不出现。由 DSH 宿主 spawn 的进程不受此限。
- **任务栏按钮会移动**：窗口增减都会改变它，所以按钮位置要周期性重定位，不能缓存太久。
  但 UIA 的跨进程属性读取不便宜（每 2.5s 一次实测 ~6% 单核），现在按 `buttonRefreshMs`
  读矩形、`buttonSearchMs` 才做一次任务栏内 `FindAll`，空闲占用约 0.4%。
- **UIA 树会劣化，且桌面级搜索会被坏元素永久阻塞**：实测一次 explorer 树劣化后，
  从桌面根节点搜任务栏按钮返回 190 个重复项（正常 3 个），其中某个元素属性读取直接卡死，
  把整个轮询线程钉住（CPU 33%、无日志、无重绘）。现在只在 `Shell_TrayWnd` 内搜索
  （9ms vs ~3000ms）、候选先校验再采用、坏元素跳过，并有 `slow tick` 看门狗兜底。
- **UIA 会瞬时抽风**：按钮矩形读取失败、或一次 `FindAll` 找不到按钮都可能发生。此时
  **保留上一次的矩形继续画**，下一轮立刻重试（`buttonRetryMs`），而不是当场隐藏。
- **状态文件的 mtime 不能单独当变更依据**：`state.json` 用 (mtime, 长度) 双重判断，
  另外每 2.5s 无条件重解析一次，避免“时间戳同刻改写”被漏掉。
- **`Add-Type` 编译的 C# 里不要用 `Bitmap.GetHbitmap`** 给 `UpdateLayeredWindow`：它不做
  预乘 alpha，圆角会出现亮边；本插件自己 `CreateDIBSection` 后逐像素预乘。
