# 05 · Bitwarden 适配器

> P2 实现说明。官方云与 Vaultwarden 共用同一套代码，仅 endpoints 不同（DEC-002）。
> 代码入口：`src/adapters/bitwarden/`。

## 1. 端点解析

`resolveEndpoints(serverUrl, mode)` 统一构造地址并强制 HTTPS（S-3）：

| mode | apiBase | identityBase |
|---|---|---|
| `bitwarden.cloud` | `https://api.bitwarden.com` | `https://identity.bitwarden.com` |
| `vaultwarden` | 用户输入 origin | `${origin}/identity` |

用户填写的 origin 走运行时 `optional_host_permissions`（M-3），manifest 不写死任何第三方域名。

## 2. 登录与解密链

1. `GET /api/accounts/prelogin` 获取 KDF 参数；目前仅支持 PBKDF2-HMAC-SHA256（`kdf === 0`）。
2. `masterKey = PBKDF2(masterPassword, lowercase(email), iterations)`
3. `stretchedKey = PBKDF2(masterKey, masterPassword, iterations)` → Base64 作为登录密码哈希。
4. `POST /identity/connect/token`（`grant_type=password`，可选 2FA 码）获取 access token。
5. `GET /api/sync` 返回 `profile.key`（受保护对称密钥）与 ciphers。
6. AES-256-CBC 解出 64 字节对称密钥（前 32 加密 / 后 32 HMAC）。
7. 字段字符串 `2.iv.ciphertext.mac`：先验 HMAC-SHA256（恒定时间比较），再 AES-256-CBC 解密。

全部基于 Web Crypto API，无 WASM / 远程代码（M-4）。主密码与对称密钥只在内存，
会话快照只写入 `chrome.storage.session`（S-1），401 时尝试 refresh token 一次。

## 3. 条目映射与 URI 匹配

`Cipher` → `CredentialItem`：id / name / username / password / totp / notes / fields / uris。
URI 匹配支持 domain、host、exact、startsWith、regex、never；正则长度上限 256 且捕获语法错误。
无 URI 的条目不参与 `search`，但会出现在 `listAll`。单条解密失败只跳过该条。

## 4. 测试（T-1 / T-2）

`tests/bitwarden.test.mjs`：
- PBKDF2 主密钥 / 拉伸密钥与 Node 标准库向量一致；
- AES-256-CBC + HMAC 字段解密与篡改检测；
- 模拟 Client API 完成登录 → sync → 解密 → URI 匹配，覆盖 Vaultwarden 端点；
- 官方云 / Vaultwarden 端点配置切换与 HTTP 拒绝；
- 会话快照恢复为就绪适配器。

---

## 决策记录

### DEC-009 · 保留主密码登录，不把 API Key 当作解密凭据
- **问题**：是否用 API Key（`client_credentials`）作为默认登录方式？
- **选项**：A 仅 API Key / B 主密码登录 / C 两者都可以但适配器要求可解密
- **结论**：C（当前实现走 B 路径）。
- **理由**：API Key 只能拿到授权 token，无法派生解密对称密钥；只读填充必须解密字段，
  因此主密码不可省略。Client API 保留 API Key 方法供后续扩展，但不作为解锁凭据。
