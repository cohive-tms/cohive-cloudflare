import { Env } from "../[[route]]";

export interface WorkspaceLimit {
  plan: string;
  planName?: string;
  storageLimit: number;
  storageUsed: number;
  memberLimit: number;
  memberUsed: number;
  channelLimit: number;
  channelUsed: number;
  dmEnabled?: boolean;
  mediaEnabled?: boolean;
  forbiddenExtensions?: string;
  stripeSubscriptionId?: string;
}

/**
 * ワークスペースの現在のサブスクリプション情報と各種リソースの使用状況を取得します。
 */
export async function getWorkspaceSubscription(env: Env, workspaceId: string): Promise<WorkspaceLimit> {
  const defaultLimit: WorkspaceLimit = {
    plan: "unlimited",
    storageLimit: Infinity,
    storageUsed: 0,
    memberLimit: Infinity,
    channelLimit: Infinity,
    memberUsed: 0,
    channelUsed: 0,
    dmEnabled: true,
    mediaEnabled: true,
    forbiddenExtensions: "",
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
          storageLimit: saasPlan.storageLimit,
          memberLimit: saasPlan.memberLimit,
          channelLimit: saasPlan.channelLimit,
          dmEnabled: saasPlan.dmEnabled,
          mediaEnabled: saasPlan.mediaEnabled,
          forbiddenExtensions: saasPlan.forbiddenExtensions,
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
  extra?: { fileExtension?: string }
): Promise<{ allowed: boolean; message?: string }> {
  // ワークスペースIDが無い場合は制限チェックをスキップ
  if (!workspaceId || workspaceId === "null" || workspaceId === "undefined") {
    return { allowed: true };
  }

  const limits = await getWorkspaceSubscription(env, workspaceId);

  // unlimitedプランは制限を実質無効にする
  if (limits.plan === "unlimited") {
    return { allowed: true };
  }

  const planName = limits.plan === "free" ? "無料" : limits.plan === "pro" ? "プロ" : limits.plan;

  if (type === "channel") {
    if (limits.channelUsed + incomingValue > limits.channelLimit) {
      return {
        allowed: false,
        message: `${planName}プランの制限に達しました。作成可能なチャンネル数は最大 ${limits.channelLimit} 個までです。`,
      };
    }
  } else if (type === "member") {
    if (limits.memberUsed + incomingValue > limits.memberLimit) {
      return {
        allowed: false,
        message: `${planName}プランの制限に達しました。追加可能なメンバー数は最大 ${limits.memberLimit} 人までです。`,
      };
    }
  } else if (type === "storage") {
    if (limits.storageUsed + incomingValue > limits.storageLimit) {
      const limitMb = limits.storageLimit / (1024 * 1024);
      const limitStr = limitMb >= 1024 ? `${Math.round(limitMb / 1024)}GB` : `${Math.round(limitMb)}MB`;
      return {
        allowed: false,
        message: `${planName}プランの制限に達しました。ストレージ容量の上限は ${limitStr} です。`,
      };
    }
  } else if (type === "dm") {
    if (limits.dmEnabled === false) {
      return {
        allowed: false,
        message: `${planName}プランではDM機能が無効化されています。`,
      };
    }
  } else if (type === "media") {
    if (limits.mediaEnabled === false) {
      return {
        allowed: false,
        message: `${planName}プランではファイルのアップロード（メディア機能）が禁止されています。`,
      };
    }
    if (extra?.fileExtension && limits.forbiddenExtensions) {
      const forbiddenList = limits.forbiddenExtensions.split(",")
        .map(ext => ext.trim().toLowerCase())
        .filter(ext => ext.length > 0);
      
      const fileExt = extra.fileExtension.toLowerCase().replace(/^\./, "");
      if (forbiddenList.includes(fileExt)) {
        return {
          allowed: false,
          message: `${planName}プランでは、拡張子「.${fileExt}」のファイルアップロードが禁止されています。`,
        };
      }
    }
  }

  return { allowed: true };
}
