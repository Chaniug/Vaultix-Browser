# Chrome 应用商店上传步骤（按顺序执行）

> 沙箱里没有你的 Google 登录态，所以最后一步必须由你本人完成。其余材料已全部备好。

## 0. 已就绪的材料

| 材料 | 路径 / 地址 |
|---|---|
| 上传包（ZIP，商店只收 ZIP） | `/workspace/Vaultix-Browser/vaultix-browser-extension.zip` |
| 商店图标 | `store-assets/icon-128.png` |
| 三张截图 | `store-assets/screenshot-1.png`、`screenshot-2.png`、`screenshot-3.png` |
| 文案 / 权限理由 / 测试说明 | `store-assets/LISTING.md` |
| 隐私政策（已公开，HTTP 200） | https://chaniug.github.io/Vaultix-Browser/privacy.html |
| 主页 | https://github.com/Chaniug/Vaultix-Browser |

短描述 83 字符，符合 132 上限。

## 1. 注册开发者账号

1. 打开 https://chrome.google.com/webstore/devconsole
2. 用你自己的 Google 账号登录（建议专用于发布）。
3. 首次进入会要求同意开发者协议并支付**一次性 5 美元**注册费；中国大陆、中国香港、中国澳门、中国台湾均在支持地区。
4. 完成账号设置（含开发者名称、联系方式）。

## 2. 新建商品并上传

1. 开发者信息中心点击 **Add new item（新增商品）**。
2. 选择文件 `vaultix-browser-extension.zip` 上传。**不要上传 `.crx`**——CRX 是安装格式，商店需要 ZIP 源码包。
3. 上传成功后进入商品编辑页。

## 3. 填写 Store Listing（商店详情）

- 名称：`Vaultix Browser`
- 简短描述：复制 `LISTING.md` 里的"简短描述"
- 完整描述：复制 `LISTING.md` 里的"完整描述"
- 语言：简体中文；类别：生产力
- 图标：上传 `store-assets/icon-128.png`
- 截图：依次上传三张 `screenshot-*.png`
- 主页 URL：`https://github.com/Chaniug/Vaultix-Browser`

## 4. 填写 Privacy（隐私）

- Single purpose：`浏览器凭证填充：在 Bitwarden/Vaultwarden 与 KeePassXC 中查找、填充和保存登录凭证。`
- 数据使用：选择不收集 / 不分享用户数据，并逐项按 `LISTING.md` 的权限理由填写。
- 隐私政策 URL：`https://chaniug.github.io/Vaultix-Browser/privacy.html`
- 注意 2026-08-01 起生效的新政策：所有数据处理都必须在商店页面醒目披露；本扩展不收集数据，保持声明一致即可。

## 5. 填写 Test instructions（审核测试说明）

把 `LISTING.md` 里"审核测试说明"整段贴进去。审核员没有你的密码库账号，这段说明能避免被以"无法测试"为由拒绝。

## 6. 分发与提交

1. Distribution：选择公开（Public）、全部国家/地区。
2. 点击 **Submit for Review（提交审核）**。
3. 审核通常数天到数周；审核通过后会自动发布（也可在提交对话框里取消勾选自动发布，改为手动发布）。
4. 发布后商店会出现公开页面，所有人可搜索下载。

## 7. 提交后建议

- 把 PR #1 合并到 `main`，并把 GitHub Pages 来源从功能分支切到 `main`（仓库 Settings → Pages）。
- 后续版本升级时必须递增 `manifest.json` 的 `version`，并用同一个 `vaultix-extension.pem` 签名（扩展 ID 才能保持不变）。
- 若审核要求补充权限理由或测试账号，按通知修改后重新提交。
