# 04 · KeePassRPC 适配器

> P1 实现说明。协议依据公开文档 `keepassxc-protocol.md`（L-3：只按协议实现，不复制上游源码）。
> 代码入口：`src/adapters/keepassrpc/`。

## 1. 通信模型

扩展通过 `chrome.runtime.connectNative` 连接 `org.keepassxc.keepassxc_browser`（keepassxc-proxy），
走 Native Messaging，**不占 host 权限**（M-2/M-3）。用户需在 KeePassXC 设置中允许本扩展 ID。

三套密钥：

| 密钥 | 生命周期 | 用途 |
|---|---|---|
| host key | 单次会话 | KeePassXC 侧临时密钥对 |
| client key | 单次会话 | 扩展侧临时密钥对 |
| identification key | 长期配对 | 仅公钥保存在本地配置，用于识别本扩展 |

配对信息只含 `id` 与 identification **公钥**，不含任何私钥或明文凭证（S-1）。

## 2. 线协议

- `change-public-keys`：交换双方公钥，明文 JSON，响应 `success === 'true'`。
- 其余 action：payload 用 `nacl.box` 封箱（接收方公钥 + 发送方私钥 + 24 字节 nonce），Base64 后放入 `message`。
- 请求 nonce 随机生成；**响应 nonce 必须等于请求 nonce + 1**，否则视为协议错误（G4 单测覆盖）。
- `clientID` 为 24 字节随机 Base64，用于区分同一代理下的多个客户端。

已实现 action：`associate`、`test-associate`、`get-logins`、`get-totp`。
`search` 内部先 `get-logins`，条目缺少 TOTP 且具备 uuid 时再补一次 `get-totp`。

## 3. 能力声明与容错

`capabilities = { search: true, listAll: false, totp: true, customFields: false, uriMatching: false, write: false }`。

- `listAll: false`：公开协议只提供 `get-database-groups`（组树，不含条目），无法可靠枚举全部条目；
  按 C-3 不提供"半个适配器"，显式关闭该能力。
- 错误码 15（无匹配）按空结果处理；数据库锁定 / 权限拒绝收敛为稳定错误码（S-2）。
- `search` / `listAll` 永不向调用方抛异常，单条失败不影响其他来源（合并器容错）。

## 4. 测试

`tests/keepassrpc.test.mjs` 用内存模拟服务端完成真实 NaCl 加解密往返，覆盖：
握手 → 配对 → get-logins → get-totp 全链路、配对恢复、nonce 不符容错、错误码 15、固定密钥封箱向量（T-1）。

---

## 决策记录

### DEC-008 · KeePassXC 不声明 listAll 能力
- **问题**：`03-统一契约.md` 预期 `get-database-groups` 可支撑 `listAll`，但公开协议响应只含组树、不含条目。
- **选项**：A 按组遍历猜测条目 / B 声明不支持并返回空数组 / C 复制上游实现补齐未公开 action
- **结论**：B。
- **理由**：A 会漏条目且产生错误结果；C 违反 L-3；B 符合 C-3 的"完整接口 + 明确能力"，UI 据此隐藏入口。
