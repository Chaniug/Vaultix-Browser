/**
 * 核心契约 — 统一条目模型与后端适配器接口
 *
 * 契约定义见 docs/03-统一契约.md。任何字段增删改必须先改文档并经评审（规约 C-1）。
 * 本文件不依赖任何具体后端，也不依赖浏览器 API —— 保持纯类型，便于单测与复用。
 */

/** 后端来源。字面量联合 + readonly 保证 UI 与内容脚本无法伪造（S-6） */
export type BackendSource = 'bitwarden' | 'keepassxc';

export const BACKEND_SOURCES = ['bitwarden', 'keepassxc'] as const;

/** URI 匹配策略，对齐 Bitwarden 的 UriMatchType 语义 */
export type UriMatchType = 'domain' | 'host' | 'exact' | 'startsWith' | 'regex' | 'never';

/** Bitwarden 自定义字段类型 */
export type CustomFieldType = 'text' | 'hidden' | 'boolean' | 'linked';

export interface CredentialUri {
  readonly uri: string;
  readonly match?: UriMatchType;
}

export interface CustomField {
  readonly name: string;
  readonly value: string;
  readonly type: CustomFieldType;
}

/**
 * 统一条目模型。
 *
 * 分层原则（D-01 联合类型 + source 标记，不丢字段）：
 *  - 核心必填：name / username / password —— 两个后端都能提供。
 *  - 可选增强：totp / uris / customFields / notes / expired —— 按来源能力填充，缺失时 UI 必须优雅降级（C-2）。
 *  - meta：来源特有原始数据，UI 不得依赖其结构。
 *
 * 安全约束：password 为明文，仅存在于内存会话态，绝不落盘（S-1）、绝不打印（S-2）。
 */
export interface CredentialItem {
  /** 后端内唯一标识（Bitwarden cipher id / KeePassXC entry uuid） */
  readonly id: string;

  /** 来源标记，仅适配器层可写 */
  readonly source: BackendSource;

  /** 条目显示名 */
  readonly name: string;

  /** 登录名 */
  readonly username: string;

  /** 明文密码 —— 内存态敏感字段 */
  readonly password: string;

  /** TOTP 种子或一次性码，能力见 BackendCapabilities.totp */
  readonly totp?: string;

  /** 关联 URI 列表，能力见 BackendCapabilities.uriMatching */
  readonly uris?: readonly CredentialUri[];

  /** 自定义字段，能力见 BackendCapabilities.customFields */
  readonly customFields?: readonly CustomField[];

  /** 备注 */
  readonly notes?: string;

  /** 条目是否过期（KeePassXC 返回 expired 标志） */
  readonly expired?: boolean;

  /** 来源特有元数据；UI 不得依赖其结构（C-2） */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * 后端能力声明。C-3：新增后端必须实现完整接口，能力用本结构声明，
 * UI 据此决定显示哪些操作，不允许"半个适配器"。
 */
export interface BackendCapabilities {
  /** 按 URL 搜索匹配凭证 */
  readonly search: boolean;
  /** 列出全部条目 */
  readonly listAll: boolean;
  /** 提供 TOTP */
  readonly totp: boolean;
  /** 提供自定义字段 */
  readonly customFields: boolean;
  /** 提供 URI 匹配策略 */
  readonly uriMatching: boolean;
  /** 支持写操作（保存新凭证 / 更新）—— 首版均为 false，见章程 out of scope */
  readonly write: boolean;
}

/** 搜索请求。由内容脚本采集，经 background 传给适配器 */
export interface SearchQuery {
  /** 当前页面完整 URL（用于匹配） */
  readonly url: string;
  /** 表单 action URL，可选 */
  readonly submitUrl?: string;
  /** 是否 HTTP Basic Auth 场景 */
  readonly httpAuth?: boolean;
}

/**
 * 写回草稿（DEC-011）。只含用户可编辑字段；
 * source / meta 等由后端分配的字段不在此处，防止来源伪造（S-6）。
 */
export interface CredentialDraft {
  /** 凭证关联的站点 URL */
  readonly url: string;
  readonly username: string;
  readonly password: string;
  /** 条目显示名；缺省时由适配器按域名生成 */
  readonly name?: string;
  /** 已有条目标识；有值时为更新，否则新建 */
  readonly uuid?: string;
  /** KeePassXC 分组路径；Bitwarden 忽略 */
  readonly folder?: string;
}

/** 写回结果。来源由适配器写入，UI 只读（S-6） */
export interface SaveResult {
  readonly ok: boolean;
  readonly source: BackendSource;
  /** 后端分配的条目 ID；失败时缺省 */
  readonly id?: string;
  /** true = 新建，false = 更新 */
  readonly created?: boolean;
}

/**
 * 后端适配器接口 —— 双源一抽象的物理边界。
 *
 * 实现方：adapters/bitwarden 与 adapters/keepassrpc。
 * 使用方：仅 background 组装并注入；ui / content 禁止 import 具体实现（E-2）。
 */
export interface BackendAdapter {
  /** 来源标识，必须是字面量常量 */
  readonly source: BackendSource;

  /** 能力声明 */
  readonly capabilities: BackendCapabilities;

  /**
   * 后端是否可用（已解锁 / 已配对 / 已连接）。
   * 未就绪时合并器会跳过该来源，不阻塞其他来源。
   */
  isReady(): boolean;

  /** 按 URL 搜索。不得抛异常到调用方 —— 内部消化并返回空数组 + 日志 */
  search(query: SearchQuery): Promise<readonly CredentialItem[]>;

  /** 列出全部条目。能力不支持时返回空数组 */
  listAll(): Promise<readonly CredentialItem[]>;

  /**
   * 写回凭证（P4 / DEC-010）。能力不支持时必须返回 ok:false，不得抛异常到调用方。
   * 调用方必须已获得用户确认；明文只在内存流转，禁止写盘（S-1）。
   */
  save(draft: CredentialDraft): Promise<SaveResult>;
}
