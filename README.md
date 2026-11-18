# Vaultix Browser

> 一个浏览器扩展，同时接管 **Bitwarden 系**与 **KeePassXC** 两类密码库。
> [Vaultix](https://github.com/Chaniug/Vaultix) 的浏览器端补充——移动端与桌面浏览器共用同一套凭证。

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Manifest](https://img.shields.io/badge/Manifest-V3-orange.svg)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Status](https://img.shields.io/badge/Status-设计中-yellow.svg)](#路线图)

---

## 它解决什么

Vaultix 管住了手机，但网页登录仍要依赖别的插件。本项目把这件事收拢到**一个扩展**里：

- 访问 **Bitwarden 官方云**或**自建 Vaultwarden** → 走官方 Client API + 加密内核，本地派生密钥解密。
- 访问 **KeePassXC 数据库** → 走 KeePassRPC，由桌面端解密，扩展只拿结果。

对用户而言只有一个下拉框：这次用哪个库。对开发者而言只有一层统一条目模型 `CredentialItem`。

## 设计原则

1. **主密码不落盘。** 扩展内只保留会话期间的派生密钥；锁定策略沿用 Vaultix 的锁定时机模型。
2. **不重复造加密轮。** Bitwarden 侧复用官方 SDK / clients 解密层；KDBX 侧根本不在扩展内解密。
3. **两个后端，一层抽象。** 后端差异被 `BackendAdapter` 接口吸收，UI 与填充引擎不感知来源。
4. **GPL-3.0。** 上游 KeePassXC-Browser 与 bitwarden/clients 均为 GPL-3.0，本仓库保持同协议以兼容复用。

## 架构

```
┌──────────────────────── 浏览器扩展（MV3） ────────────────────────┐
│  统一 UI · 表单识别 · 自动填充                                    │
│                    CredentialItem（统一条目模型）                 │
│        ┌────────────────────┬────────────────────┐               │
│        │ Bitwarden 适配器    │ KeePassRPC 适配器   │               │
│        └─────────┬──────────┴──────────┬─────────┘               │
└──────────────────┼─────────────────────┼─────────────────────────┘
                   │ HTTPS Client API    │ Native Messaging + NaCl
                   ▼                     ▼
        Bitwarden 云 / Vaultwarden    KeePassXC 桌面端
        （扩展内解密）                （桌面端解密）
```

> 详细契约见 [`docs/`](docs/)（按阶段分篇，入口文档只放指针）。

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 定义 `CredentialItem` / `BackendAdapter` 契约，不涉及后端 | 待开始 |
| P1 | 接通 KeePassRPC（associate → get-logins → get-totp），验证填充 | 待开始 |
| P2 | 接通 Bitwarden（登录 → sync → 解密 → 只读列表），覆盖官方云与自建 | 待开始 |
| P3 | 双源合并搜索、来源标记、冲突选择、锁定策略 | 待开始 |

## 相关项目

- [Vaultix](https://github.com/Chaniug/Vaultix) — 安卓端主项目
- [bw2keepass](https://github.com/Chaniug/bw2keepass) — Bitwarden / KDBX 格式互转，本项目的加密格式知识来源
- [KeePassXC-Browser](https://github.com/keepassxreboot/keepassxc-browser) — KeePassRPC 协议参考（GPL-3.0）
- [bitwarden/clients](https://github.com/bitwarden/clients) — 官方客户端与 SDK（GPL-3.0）

## 许可

[GPL-3.0](LICENSE) — 与 Vaultix 及上游依赖保持一致。
