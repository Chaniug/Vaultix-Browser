# 技术文档索引

按阶段分篇。**入口文件只放指针和当前状态**，每篇独立可读，避免上下文膨胀。

## 当前状态

- 设计阶段，P0 契约尚未定稿。
- 已确认的两条硬约束：
  - **许可证**：上游 KeePassXC-Browser 与 bitwarden/clients 均为 GPL-3.0 → 本项目同协议。
  - **后端形态**：KDBX 不在扩展内解密（走 KeePassRPC）；Bitwarden 官方云与 Vaultwarden 共用 Client API，仅 base URL 不同。

## 文档

| 文档 | 内容 | 状态 |
|---|---|---|
| [01-统一契约.md](01-统一契约.md) | `CredentialItem` / `BackendAdapter` 接口定义，来源标记策略 | 待写 |
| [02-KeePassRPC适配器.md](02-KeePassRPC适配器.md) | 配对流程、NaCl 加密、六个 action、代理与权限 | 待写 |
| [03-Bitwarden适配器.md](03-Bitwarden适配器.md) | SDK 集成、登录/2FA、sync、组织密钥、base URL 切换 | 待写 |
| [04-填充引擎.md](04-填充引擎.md) | 表单识别、字段映射、TOTP、Shadow DOM | 待写 |
| [05-锁定与安全.md](05-锁定与安全.md) | 会话密钥生命周期、锁定时机、MV3 service worker 约束 | 待写 |

## 决策记录

重大选择以"问题 → 选项 → 结论 → 理由"四段记录，追加到对应文档末尾，不单开文件。
