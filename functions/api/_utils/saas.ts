import { Env } from "../[[route]]";

export interface WorkspaceLimit {
  plan: string;
  planName?: string;
  status?: string;
  isSponsored?: boolean;
  storageLimit: number;
  storageUsed: number;
  memberLimit: number;
  memberUsed: number;
  channelLimit: number;
  channelUsed: number;
  adminLimit?: number;
  adminUsed?: number;
  announcementLimit?: number;
  announcementUsed?: number;
  auditRetentionDays?: number;
  dmEnabled?: boolean;
  mediaEnabled?: boolean;
  allowedExtensions?: string;
  maxFileSizeMb?: number;
  forbiddenExtensions?: string;
  msgRetentionDays?: number;
  msgRetentionCount?: number;
}

const DANGEROUS_EXTENSIONS = ["exe", "bat", "cmd", "sh", "php", "cgi", "pl", "asp", "aspx", "jsp", "html", "htm", "phtml", "vbs", "ps1", "dll", "scr"];

/**
 * ワークスペースの現在のサブスクリプション情報と各種リソースの使用状況を取得します。
 */
export async function getWorkspaceSubscription(env: Env, workspaceId: string): Promise<WorkspaceLimit> {
  const defaultLimit: WorkspaceLimit = {
    plan: "community",
    planName: "Community Edition",
    status: "active",
    isSponsored: false,
    storageLimit: Infinity,
    storageUsed: 0,
    memberLimit: Infinity,
    channelLimit: Infinity,
    memberUsed: 0,
    channelUsed: 0,
    adminLimit: Infinity,
    adminUsed: 0,
    announcementLimit: Infinity,
    announcementUsed: 0,
    auditRetentionDays: Infinity,
    dmEnabled: true,
    mediaEnabled: true,
    allowedExtensions: "",
    maxFileSizeMb: 100,
    forbiddenExtensions: DANGEROUS_EXTENSIONS.join(", "),
  };

  if (!workspaceId || workspaceId === "null" || workspaceId === "undefined") {
    return defaultLimit;
  }

  try {
    // ストレージ使用量
    const storageResult = await env.DB.prepare(
      "SELECT SUM(file_size) as total FROM files WHERE workspace_id = ?"
    ).bind(workspaceId).first<{ total: number | null }>();
    defaultLimit.storageUsed = storageResult?.total || 0;

    // メンバー数
    const memberResult = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM workspace_members WHERE workspace_id = ?"
    ).bind(workspaceId).first<{ count: number }>();
    defaultLimit.memberUsed = memberResult?.count || 0;

    // 管理者数 (owner または admin)
    const adminResult = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM workspace_members WHERE workspace_id = ? AND (role = 'owner' || role = 'admin' || role = 'group_admin')"
    ).bind(workspaceId).first<{ count: number }>();
    defaultLimit.adminUsed = adminResult?.count || 0;

    // チャンネル数
    const channelResult = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM channels WHERE workspace_id = ? AND (type = 'channel' OR type IS NULL)"
    ).bind(workspaceId).first<{ count: number }>();
    defaultLimit.channelUsed = channelResult?.count || 0;

    // 現在のお知らせ数
    const annResult = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM global_announcements WHERE is_active = 1"
    ).first<{ count: number }>();
    defaultLimit.announcementUsed = annResult?.count || 0;
  } catch (err) {
    console.error("Failed to calculate subscription limits:", err);
  }

  return defaultLimit;
}
