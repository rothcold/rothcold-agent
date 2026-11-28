# ADR 0001: 移动端采用先 iOS 原生、后补 Android 原生的技术选型

- 状态：已选定 (调研结论，尚未开工实现)
- 日期：2026-11-27
- 适用范围：`rothcold-agent` 移动端规划 (iOS、Android)

## 决策结论

移动端不采用 uni-app、Flutter 或 React Native 等跨端框架，改用分阶段原生路线：

1. 第一阶段先做 iOS 原生客户端 (Swift + SwiftUI)，打磨移动端消息体验、网络与私有 CA 信任、附件媒体、审批与离线状态机。在此期间，Android 设备继续使用现有响应式 Web (`web/`)。
2. 第二阶段在产品交互和 API 契约稳定后，再补 Android 原生客户端 (Kotlin + Jetpack Compose)。
3. 共享逻辑不提前抽象。第一阶段由 iOS 端直接调用 `server/` 的原生 HTTP API；进入第二阶段前，再根据重复工作量评估是否将协议模型、离线队列、本地缓存或 Markdown 解析下沉到 Rust 共享核心，并通过 UniFFI 暴露给 Swift 与 Kotlin。

## 背景与项目约束

`rothcold-agent` 是私有、单所有者消息平台，仓库现有工程约束直接决定了移动端边界：

- 后端原生 API 已独立存在：`server/` (Rust + SQLite) 已提供原生会话与业务接口 (`POST /api/login`、`GET /api/me`、`GET /api/sessions`、`GET /api/directory`、`POST /api/chats`、`POST /api/chats/{chat}/turns`、`POST/GET /api/attachments`、`GET /api/notifications`、`GET/POST /api/profile`、归档、移动与审批)。原生客户端使用 `Authorization: Bearer <session>`，不发送 `Origin` 头和浏览器 Fetch 元数据。
- 私网 HTTPS 与私有 CA 校验：`README.md` 要求手机通过 LAN/VPN 下的受信任 HTTPS 访问 `/api/*`，安装并校验私有 CA，不得关闭证书验证，也不得直连环回端口或暴露 `/adapter/*`。
- 重文本与聊天交互需求：长 Markdown 阅读与代码块复制、中文输入法 (IME) 组合态、最多 8 个附件上传 (单文件 25 MiB、`503` 传输槽繁忙重试)、带鉴权头的音视频单段 Range 播放、600 ms 前台可见已读回执、实时执行审批 (绑定单一请求且不可持久化重放)、离线排队与 `unknown` 回合人工放行、`/` 命令与 Skills 提示。
- 视觉与外观约定：沿用 `COLORS.md` 的深色 (鸦青 · 缃纸) 与浅色 (鸦青 · 素笺) 角色色和对比度门槛，支持跟随系统、浅色、深色三态。
- 工程原则：Apache-2.0 协议、最少外部依赖、本地确定性构建、低信任面，不依赖闭源云构建或第三方商业插件市场。

## 备选方案与取舍

| 方案                     | 与本项目契合点                         | 未选或延后原因                                             |
| ------------------------ | -------------------------------------- | ---------------------------------------------------------- |
| 先 iOS 原生后补 Android  | 体验最好、零框架中间层、私网 CA 最顺畅 | 需在第二阶段维护第二套 UI，但分阶段可避免初期三端同步拖慢  |
| React Native (Expo 本地) | 可与 `web/` 复用 TS 逻辑和 Markdown    | 仍带 JS 运行时与依赖升级负担，跨块划词与系统扩展不如纯原生 |
| Flutter                  | 双端 UI 一致性强、Impeller 渲染成熟    | 引入 Dart 第 4 语言栈，且默认 HttpClient 不认系统私有 CA   |
| uni-app / uni-app x      | 适合同时覆盖小程序和国内多端生态       | 本项目无小程序需求，工具链耦合重，偏离开放与本地可控原则   |

选择原生的核心原因有两点：一是本项目允许先落地主力平台 (iOS)，不必为了首日双端齐发牺牲体验或引入跨端框架税；二是聊天客户端最敏感的键盘跟手、中文 IME、文本选区、系统分享扩展、Keychain/Keystore、私有 CA 校验以及带 Bearer 头的流媒体播放，在原生栈下问题最少且生命周期最长。

## 技术栈与平台边界

阶段一 (iOS 原生)：

- 语言与界面：Swift + SwiftUI，遵循 `COLORS.md` 角色配色与明暗三态，不强搬桌面布局。
- 网络与 TLS：`URLSession`，默认尊重系统已安装的私有 CA 描述文件，禁止跳过证书校验，不发送 `Origin` 头。
- 凭据与本地状态：仅将 `POST /api/login` 返回的 Bearer session 存入 iOS Keychain，不持久化 owner token；草稿、当前服务器配置与本地缓存存于 App 私有目录。
- 编辑器与交互：使用原生多行文本输入配轻量 Markdown 快捷操作，不在移动端内嵌 TipTap WebView；保持附件上传最多 8 个、`503` 重试以及 `/` 命令提示行为与后端契约一致。
- 媒体与系统能力：图片原图预览、音视频通过 `AVPlayer` 携带 `Authorization` 请求头 (或受控临时缓存) 支持 Range 播放；预留 iOS Share Extension 以支持从其他应用分享文本和文件到 Rothcold。

阶段二 (补齐 Android 原生)：

- 语言与界面：Kotlin + Jetpack Compose，复刻阶段一已验证的交互与状态机。
- 网络与 TLS：`OkHttp`，通过 `network_security_config.xml` 显式配置信任用户安装的私有 CA，不放宽明文 HTTP 或证书校验。
- 凭据与媒体：使用 Android Keystore 保护会话凭据；音视频使用 Media3 (`ExoPlayer`) 并携带 `Authorization` 请求头。
- Rust 共享层评估点：在启动 Android 前评估是否有必要把纯业务逻辑 (API 类型、目录合并、Markdown 解析、离线请求幂等与排队状态) 抽为 Rust crate 并用 UniFFI 生成 Swift/Kotlin 绑定。若客户端仍保持薄层，也可继续两端各自维护精简代码。

通用边界约束：

- 只调用受信任 HTTPS 入口下的 `/api/*`，绝不接触 `/adapter/*` 或服务端 SQLite 文件。
- 切换服务器时丢弃未发送草稿；注销设备仅撤销当前会话；不将 `Authorization` 写入任何日志。
- 保持与 `server/`、`web/`、`hermes-adapter/` 构建完全隔离。开工时建议目录放在 `mobile/ios/` 与 `mobile/android/` (如需共享核心则增加 `mobile/core/`)。

## 后续待决事项

- 后台实时提醒：目前服务端采用轮询且无外部推送，手机锁屏或应用挂起后无法及时收到新回复与执行审批提示。需在 iOS 开发前或里程碑二单独评审推送方案 (如最小自建 APNs 转发、私网推送通道等)，且通知内容须延续现有隐私原则，不包含对话正文。
- 离线缓存范围：确认移动端是否仅做内存/轻量持久化草稿与列表缓存，还是需要本地 SQLite 完整离线阅读副本。
- 自动化测试策略：iOS 与 Android 客户端需沿用隔离测试原则，仅对接合成数据库和一次性本地/测试 CA 证书，不连接所有者生产数据目录或真实 Hermes 实例。
