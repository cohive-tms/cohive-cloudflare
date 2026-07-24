import { Env } from "../[[route]]";

export interface WorkspaceLimit {
  plan: string;
  planName?: string;
  status?: string;
  storageLimit: number;
  storageUsed: number;
  memberLimit: number;
  memberUsed: number;
  channelLimit: number;
  channelUsed: number;
  dmEnabled?: boolean;
  mediaEnabled?: boolean;
  allowedExtensions?: string;
  maxFileSizeMb?: number;
  forbiddenExtensions?: string;
  msgRetentionDays?: number;
  msgRetentionCount?: number;
  stripeSubscriptionId?: string;
}

const DANGEROUS_EXTENSIONS = ["exe", "bat", "cmd", "sh", "php", "cgi", "pl", "asp", "aspx", "jsp", "html", "htm", "phtml", "vbs", "ps1", "dll", "scr"];

/**
 * ワークスペースの現在のサブスクリプション情報と各種リソースの使用状況を取得します。
 */
export async function getWorkspaceSubscription(env: Env, workspaceId: string): Promise<WorkspaceLimit> {
  const defaultLimit: WorkspaceLimit = {
    plan: "unlimited",
    status: "active",
    storageLimit: Infinity,
    storageUsed: 0,
    memberLimit: Infinity,
    channelLimit: Infinity,
    memberUsed: 0,
    channelUsed: 0,
    dmEnabled: true,
    mediaEnabled: true,
    allowedExtensions: "",
    maxFileSizeMb: 100,
    forbiddenExtensions: DANGEROUS_EXTENSIONS.join(", "),
  };

  // 無効なワークスペースIDの場合は初期値を返す
  if (!workspaceId || workspaceId === "null" || workspaceId === "undefined") {
    return defaultLimit;
  }

  // SaaS制限フックが存在すれば、プラン情報を取得して上書き
  if (env.SAAS_LIMITS?.getWorkspaceSubscriptionPlan) {
    try {
      // 1. 使用状況をカウント
      
      // ストレージ使用量 (files テーブルの合計サイズ)
      const storageResult = await env.DB.prepare(
        "SELECT SUM(file_size) as total FROM files WHERE workspace_id = ?"
      ).bind(workspaceId).first<{ total: number | null }>();
      defaultLimit.storageUsed = storageResult?.total || 0;

      // メンバー数
      const memberResult = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM workspace_members WHERE workspace_id = ?"
      ).bind(workspaceId).first<{ count: number }>();
      defaultLimit.memberUsed = memberResult?.count || 0;

      // チャンネル数 (DMは除く)
      const channelResult = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM channels WHERE workspace_id = ? AND (type = 'channel' OR type IS NULL)"
      ).bind(workspaceId).first<{ count: number }>();
      defaultLimit.channelUsed = channelResult?.count || 0;

      // 2. プラン情報を取得
      const saasPlan = await env.SAAS_LIMITS.getWorkspaceSubscriptionPlan(env, workspaceId);
      if (saasPlan) {
        return {
          ...defaultLimit,
          plan: saasPlan.plan,
          planName: saasPlan.planName,
          status: saasPlan.status || 'active',
          storageLimit: saasPlan.storageLimit,
          memberLimit: saasPlan.memberLimit,
          channelLimit: saasPlan.channelLimit,
          dmEnabled: saasPlan.dmEnabled,
          mediaEnabled: saasPlan.mediaEnabled,
          allowedExtensions: saasPlan.allowedExtensions,
          maxFileSizeMb: saasPlan.maxFileSizeMb || 100,
          msgRetentionDays: saasPlan.msgRetentionDays,
          msgRetentionCount: saasPlan.msgRetentionCount,
          forbiddenExtensions: DANGEROUS_EXTENSIONS.join(", "),
          stripeSubscriptionId: saasPlan.stripeSubscriptionId,
        };
      }
    } catch (err) {
      console.error("Failed to get workspace subscription plan from hook:", err);
    }
  }

  return defaultLimit;
}

/**
 * ワークスペースで特定のアクションを実行する際に、プラン制限に達していないかを検証します。
 */
export async function checkWorkspaceLimit(
  env: Env,
  workspaceId: string | null | undefined,
  type: "channel" | "member" | "storage" | "dm" | "media",
  incomingValue: number = 1,
  extra?: { fileExtension?: string; fileSize?: number }
): Promise<{ allowed: boolean; message?: string }> {
  // 1. セキュリティ最優先: 危険拡張子ブラックリストチェック（ワークスペース有無に関わらず常時実行）
  if (extra?.fileExtension) {
    const fileExt = extra.fileExtension.toLowerCase().replace(/^\./, "");
    if (DANGEROUS_EXTENSIONS.includes(fileExt)) {
      return {
        allowed: false,
        message: `セキュリティ保護のため、拡張子「.${fileExt}」の実行ファイル・スクリプトのアップロードは全環境で禁止されています。`,
      };
    }
  }

  // ワークスペースIDが無い場合でもセキュリティチェック完了後に通過
  if (!workspaceId || workspaceId === "null" || workspaceId === "undefined") {
    return { allowed: true };
  }

  const limits = await getWorkspaceSubscription(env, workspaceId);
  const planName = limits.plan === "free" ? "無料" : limits.plan === "pro" ? "プロ" : limits.plan;

  if (type === "channel") {
    if (limits.plan !== "unlimited" && limits.channelUsed + incomingValue > limits.channelLimit) {
      return {
        allowed: false,
        message: `${planName}プランの制限に達しました。作成可能なチャンネル数は最大 ${limits.channelLimit} 個までです。`,
      };
    }
  } else if (type === "member") {
    if (limits.plan !== "unlimited" && limits.memberUsed + incomingValue > limits.memberLimit) {
      return {
        allowed: false,
        message: `${planName}プランの制限に達しました。追加可能なメンバー数は最大 ${limits.memberLimit} 人までです。`,
      };
    }
  } else if (type === "storage") {
    // 1ファイルあたりの単体サイズ制限のチェック（100MB または プラン設定値）
    const fileSizeToCheck = extra?.fileSize || incomingValue;
    const maxSingleFileBytes = (limits.maxFileSizeMb || 100) * 1024 * 1024;
    if (fileSizeToCheck > maxSingleFileBytes) {
      return {
        allowed: false,
        message: `ファイルサイズが上限（${limits.maxFileSizeMb || 100}MB）を超えています。`,
      };
    }

    if (limits.plan !== "unlimited" && limits.storageUsed + incomingValue > limits.storageLimit) {
      const limitMb = limits.storageLimit / (1024 * 1024);
      const limitStr = limitMb >= 1024 ? `${Math.round(limitMb / 1024)}GB` : `${Math.round(limitMb)}MB`;
      return {
        allowed: false,
        message: `${planName}プランの制限に達しました。ストレージ容量の上限は ${limitStr} です。`,
      };
    }
  } else if (type === "dm") {
    if (limits.plan !== "unlimited" && limits.dmEnabled === false) {
      return {
        allowed: false,
        message: `${planName}プランではDM機能が無効化されています。`,
      };
    }
  } else if (type === "media") {
    if (limits.plan !== "unlimited" && limits.mediaEnabled === false) {
      return {
        allowed: false,
        message: `${planName}プランではファイルのアップロード（メディア機能）が禁止されています。`,
      };
    }

    // 2. SaaSプランごとのホワイトリスト（allowedExtensions）のチェック
    if (extra?.fileExtension && limits.allowedExtensions) {
      const allowedList = limits.allowedExtensions.split(",")
        .map(ext => ext.trim().toLowerCase())
        .filter(ext => ext.length > 0);
      
      const fileExt = extra.fileExtension.toLowerCase().replace(/^\./, "");
      if (allowedList.length > 0 && !allowedList.includes(fileExt)) {
        return {
          allowed: false,
          message: `${planName}プランでは、拡張子「.${fileExt}」のファイルアップロードは許可されていません。`,
        };
      }
    }
  }

  return { allowed: true };
}
