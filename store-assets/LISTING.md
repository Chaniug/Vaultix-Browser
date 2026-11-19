# Vaultix Browser · Chrome 应用商店上架资料

## 基本信息

| 字段     | 值                                                                                  |
| -------- | ----------------------------------------------------------------------------------- |
| 名称     | Vaultix Browser                                                                     |
| 类别     | 生产力（Productivity）                                                              |
| 语言     | 简体中文                                                                            |
| 版本     | 0.1.0                                                                               |
| 主页     | https://github.com/Chaniug/Vaultix-Browser                                          |
| 隐私政策 | https://chaniug.github.io/Vaultix-Browser/privacy.html                              |
| 上传包   | `vaultix-browser-extension.zip`（由 `npm run build` 后的 `dist/` 打包，不要用 CRX） |

## 简短描述（≤132 字符）

```
统一填充 Bitwarden/Vaultwarden 与 KeePassXC：按站点自动匹配、一键填写用户名/密码/TOTP，新密码确认后写回密码库；主密码永不落盘。
```

## 完整描述

```
Vaultix Browser 是一个本地优先的浏览器凭证填充器：把 Bitwarden / Vaultwarden 和 KeePassXC 两类密码库接进同一个浏览器入口。不造第三个账号体系，不上传你的凭证。

【核心功能】
• 双后端统一搜索：按当前站点自动匹配两个密码库中的登录项，来源清晰标注，冲突时按可配置优先级合并。
• 一键填充：用户名、密码、TOTP 分别填充；支持 Shadow DOM 与动态表单。
• 安全写回：表单提交后提示保存新密码，你确认后写入自己选择的密码库（Bitwarden Cipher 新建/更新、KeePassRPC set-login）。
• 锁定策略：后台与空闲自动锁定，会话只存在浏览器内存中，关闭浏览器即失效。
• 复制即清理：复制密码到剪贴板后 30 秒自动清空。

【隐私与安全】
• 主密码只用于内存派生密钥，不写入磁盘、不上传、不记录。
• 明文凭证只在扩展进程内存中流转，不落盘、不打印到日志；日志只输出错误码与脱敏域名。
• 没有统计、没有广告、没有远程配置、没有开发者控制的服务器。
• 全部源码开源，可自行审阅：github.com/Chaniug/Vaultix-Browser

【使用前准备】
• Bitwarden：在设置页选择官方云或自建 Vaultwarden，填写服务地址与邮箱，然后用主密码解锁。API Key 只能授权、不能解密，因此解锁仍需主密码。
• KeePassXC：安装 keepassxc-proxy，在 KeePassXC 中允许扩展连接，再到设置页点击"配对 KeePassXC"。

【权限说明】
• activeTab + scripting：仅在你点击图标后向当前标签页注入填充脚本。
• optional_host_permissions：只对当前站点和你配置的 Bitwarden 服务地址按需申请。
• nativeMessaging：连接本机 KeePassXC 代理。
• storage：只保存非敏感配置与内存会话态。
• clipboardWrite / offscreen / notifications / contextMenus：剪贴板超时清理与状态提示。

完整隐私政策：https://chaniug.github.io/Vaultix-Browser/privacy.html
```

## 审核测试说明（填在 Test instructions 标签页）

```
这是一个凭证填充器，本身不内置任何账号。

测试 Bitwarden 路径：
1. 打开设置页，后端类型选"自建 Vaultwarden"，服务地址填你自己的测试 Vaultwarden 实例（或 Bitwarden 官方云），填入测试账号邮箱。
2. 回到弹出页，输入该测试账号主密码解锁。
3. 打开一个已保存登录项的站点，点击扩展图标，应能看到匹配的凭证并分别填充用户名/密码。
4. 提交新密码表单后，弹出保存提示；确认后可在你的测试密码库中看到新条目。

测试 KeePassXC 路径：
1. 本机安装 KeePassXC 与 keepassxc-proxy，并在 KeePassXC 设置 → Browser Integration 中启用、允许本扩展连接。
2. 设置页点击"配对 KeePassXC"，确认数据库已打开。
3. 在已保存条目的站点点击扩展图标，应能看到 KeePassXC 来源的凭证。

无需向我们提供任何账号或凭据；本项目没有可供审核登录的演示账号。
注意：扩展不会把凭证发到开发者控制的服务器；Bitwarden 请求只发往设置页填写的地址，KeePassXC 只走本机 Native Messaging。
```

## 权限逐项理由（Privacy 标签页填写参考）

| 权限                                     | 理由                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `activeTab`                              | 用户点击扩展图标时读取当前标签页 URL 以匹配凭证，并允许按需注入脚本。        |
| `scripting`                              | 在用户主动触发后向当前页面注入内容脚本，用于识别表单和执行填充。             |
| `storage`                                | 保存服务地址、邮箱、锁定策略等非敏感配置；会话态存于内存。                   |
| `nativeMessaging`                        | 与本机 keepassxc-proxy 通信，读取和写入 KeePassXC 条目。                     |
| `contextMenus`                           | 提供右键快速填充入口。                                                       |
| `clipboardWrite`                         | 用户点击复制密码时写入剪贴板。                                               |
| `notifications`                          | 提示锁定、保存结果等状态。                                                   |
| `offscreen`                              | 在 MV3 service worker 中实现剪贴板 30 秒自动清空。                           |
| `optional_host_permissions: https://*/*` | 用户需要填充的站点不固定，因此在运行时按站点申请；安装时不索取全部站点权限。 |

## 截图

| 文件                      | 内容                                     | 商店用途         |
| ------------------------- | ---------------------------------------- | ---------------- |
| `screenshot-1.png`        | 已解锁状态：双来源凭证卡片、保存提示     | 1280×800 主截图  |
| `screenshot-2.png`        | 设置页：Bitwarden / KeePassXC / 安全策略 | 1280×800         |
| `screenshot-3.png`        | 锁定状态：主密码输入与安全提示           | 1280×800         |
| `promo-920x680.png`       | 主图裁切                                 | 宣传图（可选）   |
| `small-promo-440x280.png` | 主图缩小                                 | 小宣传图（可选） |
| `icon-128.png`            | 扩展图标                                 | 商店图标         |

截图由 `scripts/make-screenshots.py` 加载真实构建产物渲染生成，非手绘效果图。

## 上传前检查清单

- [ ] 开发者账号已注册并支付一次性 5 美元费用（中国/中国香港/中国澳门/中国台湾均在支持地区）
- [ ] 隐私政策 URL 可公开访问（需先在 GitHub 仓库 Settings → Pages 开启）
- [ ] 上传 `vaultix-browser-extension.zip`，不要上传 `.crx`
- [ ] Store Listing 填入简短描述、完整描述、三张截图与图标
- [ ] Privacy 标签页：single purpose 填"凭证填充"，声明不使用数据、不分享给第三方，填入隐私政策 URL
- [ ] 逐项填写权限理由
- [ ] Test instructions 填入上面的测试说明
- [ ] Distribution 选择公开、全部国家/地区
- [ ] 提交审核；审核时间通常数天到数周
