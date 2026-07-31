import type { Env } from "../[[route]]";
import { decryptText, encryptText, getEncryptionSecret } from "../_utils/smtp";
import { logAudit } from "../_utils/audit";
import { checkIpRestriction, verifyAdminAuth } from "./admin";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ----------------------------------------------------

// ----------------------------------------------------
// 1. プラン管理 API
// ----------------------------------------------------
export async function handleGetSaaSPlans(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  try {
    const isAllowedIp = await checkIpRestriction(request, env);
    if (!isAllowedIp) return new Response(JSON.stringify({ error: "Access denied" }), { status: 403, headers });

    const auth = await verifyAdminAuth(request, env);
    if (!auth) return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });

    const { results } = await env.DB.prepare("SELECT * FROM saas_plans ORDER BY price_amount ASC").all();

    return new Response(JSON.stringify({ success: true, plans: results }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function handleCreateSaaSPlan(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  try {
    const isAllowedIp = await checkIpRestriction(request, env);
    if (!isAllowedIp) return new Response(JSON.stringify({ error: "Access denied" }), { status: 403, headers });

    const auth = await verifyAdminAuth(request, env);
    if (!auth) return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });

    const body: any = await request.json();
    const id = body.id;
    const name = body.name;
    const memberLimit = body.memberLimit !== undefined ? body.memberLimit : (body.member_limit !== undefined ? body.member_limit : 5);
    const channelLimit = body.channelLimit !== undefined ? body.channelLimit : (body.channel_limit !== undefined ? body.channel_limit : 3);
    const storageLimit = body.storageLimit !== undefined ? body.storageLimit : (body.storage_limit !== undefined ? body.storage_limit : 52428800);
    const dmEnabled = body.dmEnabled !== undefined ? body.dmEnabled : (body.dm_enabled !== undefined ? body.dm_enabled : 1);
    const mediaEnabled = body.mediaEnabled !== undefined ? body.mediaEnabled : (body.media_enabled !== undefined ? body.media_enabled : 1);
    const allowedExtensions = body.allowedExtensions !== undefined ? body.allowedExtensions : (body.allowed_extensions !== undefined ? body.allowed_extensions : "");
    const msgRetentionDays = body.msgRetentionDays !== undefined ? body.msgRetentionDays : (body.msg_retention_days !== undefined ? body.msg_retention_days : 0);
    const msgRetentionCount = body.msgRetentionCount !== undefined ? body.msgRetentionCount : (body.msg_retention_count !== undefined ? body.msg_retention_count : 0);
    const priceId = body.priceId !== undefined ? body.priceId : (body.price_id !== undefined ? body.price_id : "");
    const priceAmount = body.priceAmount !== undefined ? body.priceAmount : (body.price_amount !== undefined ? body.price_amount : 0);
    const priceCurrency = body.priceCurrency !== undefined ? body.priceCurrency : (body.price_currency !== undefined ? body.price_currency : "jpy");
    const maxFileSizeMb = body.maxFileSizeMb !== undefined ? body.maxFileSizeMb : (body.max_file_size_mb !== undefined ? body.max_file_size_mb : 100);

    if (!id || !name) {
      return new Response(JSON.stringify({ error: "Plan ID and Name are required" }), { status: 400, headers });
    }

    try {
      await env.DB.prepare(`
        INSERT INTO saas_plans (id, name, member_limit, channel_limit, storage_limit, dm_enabled, media_enabled, allowed_extensions, msg_retention_days, msg_retention_count, price_id, price_amount, price_currency, max_file_size_mb)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id.trim().toLowerCase(),
        name.trim(),
        memberLimit,
        channelLimit,
        storageLimit,
        dmEnabled ? 1 : 0,
        mediaEnabled ? 1 : 0,
        allowedExtensions,
        msgRetentionDays,
        msgRetentionCount,
        priceId,
        priceAmount,
        priceCurrency,
        maxFileSizeMb
      ).run();
    } catch (dbErr: any) {
      if (dbErr?.message?.includes("max_file_size_mb")) {
        await env.DB.prepare("ALTER TABLE saas_plans ADD COLUMN max_file_size_mb INTEGER DEFAULT 100").run().catch(() => {});
        await env.DB.prepare(`
          INSERT INTO saas_plans (id, name, member_limit, channel_limit, storage_limit, dm_enabled, media_enabled, allowed_extensions, msg_retention_days, msg_retention_count, price_id, price_amount, price_currency, max_file_size_mb)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          id.trim().toLowerCase(),
          name.trim(),
          memberLimit,
          channelLimit,
          storageLimit,
          dmEnabled ? 1 : 0,
          mediaEnabled ? 1 : 0,
          allowedExtensions,
          msgRetentionDays,
          msgRetentionCount,
          priceId,
          priceAmount,
          priceCurrency,
          maxFileSizeMb
        ).run();
      } else {
        throw dbErr;
      }
    }

    logAudit(env, null, auth.adminId, "admin_plan_create", { planId: id, planName: name }, request).catch(console.error);

    return new Response(JSON.stringify({ success: true }), { status: 201, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function handleUpdateSaaSPlan(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  try {
    const isAllowedIp = await checkIpRestriction(request, env);
    if (!isAllowedIp) return new Response(JSON.stringify({ error: "Access denied" }), { status: 403, headers });

    const auth = await verifyAdminAuth(request, env);
    if (!auth) return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });

    const body: any = await request.json();
    const id = body.id;
    const name = body.name;
    const memberLimit = body.memberLimit !== undefined ? body.memberLimit : (body.member_limit !== undefined ? body.member_limit : 5);
    const channelLimit = body.channelLimit !== undefined ? body.channelLimit : (body.channel_limit !== undefined ? body.channel_limit : 3);
    const storageLimit = body.storageLimit !== undefined ? body.storageLimit : (body.storage_limit !== undefined ? body.storage_limit : 52428800);
    const dmEnabled = body.dmEnabled !== undefined ? body.dmEnabled : (body.dm_enabled !== undefined ? body.dm_enabled : 1);
    const mediaEnabled = body.mediaEnabled !== undefined ? body.mediaEnabled : (body.media_enabled !== undefined ? body.media_enabled : 1);
    const allowedExtensions = body.allowedExtensions !== undefined ? body.allowedExtensions : (body.allowed_extensions !== undefined ? body.allowed_extensions : "");
    const msgRetentionDays = body.msgRetentionDays !== undefined ? body.msgRetentionDays : (body.msg_retention_days !== undefined ? body.msg_retention_days : 0);
    const msgRetentionCount = body.msgRetentionCount !== undefined ? body.msgRetentionCount : (body.msg_retention_count !== undefined ? body.msg_retention_count : 0);
    const priceId = body.priceId !== undefined ? body.priceId : (body.price_id !== undefined ? body.price_id : "");
    const priceAmount = body.priceAmount !== undefined ? body.priceAmount : (body.price_amount !== undefined ? body.price_amount : 0);
    const priceCurrency = body.priceCurrency !== undefined ? body.priceCurrency : (body.price_currency !== undefined ? body.price_currency : "jpy");
    const maxFileSizeMb = body.maxFileSizeMb !== undefined ? body.maxFileSizeMb : (body.max_file_size_mb !== undefined ? body.max_file_size_mb : 100);

    if (!id) return new Response(JSON.stringify({ error: "Plan ID is required" }), { status: 400, headers });

    try {
      await env.DB.prepare(`
        UPDATE saas_plans SET
          name = ?,
          member_limit = ?,
          channel_limit = ?,
          storage_limit = ?,
          dm_enabled = ?,
          media_enabled = ?,
          allowed_extensions = ?,
          msg_retention_days = ?,
          msg_retention_count = ?,
          price_id = ?,
          price_amount = ?,
          price_currency = ?,
          max_file_size_mb = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).bind(
        name,
        memberLimit,
        channelLimit,
        storageLimit,
        dmEnabled ? 1 : 0,
        mediaEnabled ? 1 : 0,
        allowedExtensions,
        msgRetentionDays,
        msgRetentionCount,
        priceId,
        priceAmount,
        priceCurrency,
        maxFileSizeMb,
        id
      ).run();
    } catch (dbErr: any) {
      if (dbErr?.message?.includes("max_file_size_mb") || dbErr?.message?.includes("updated_at")) {
        await env.DB.prepare("ALTER TABLE saas_plans ADD COLUMN max_file_size_mb INTEGER DEFAULT 100").run().catch(() => {});
        await env.DB.prepare("ALTER TABLE saas_plans ADD COLUMN updated_at TEXT").run().catch(() => {});
        await env.DB.prepare(`
          UPDATE saas_plans SET
            name = ?,
            member_limit = ?,
            channel_limit = ?,
            storage_limit = ?,
            dm_enabled = ?,
            media_enabled = ?,
            allowed_extensions = ?,
            msg_retention_days = ?,
            msg_retention_count = ?,
            price_id = ?,
            price_amount = ?,
            price_currency = ?,
            max_file_size_mb = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).bind(
          name,
          memberLimit,
          channelLimit,
          storageLimit,
          dmEnabled ? 1 : 0,
          mediaEnabled ? 1 : 0,
          allowedExtensions,
          msgRetentionDays,
          msgRetentionCount,
          priceId,
          priceAmount,
          priceCurrency,
          maxFileSizeMb,
          id
        ).run();
      } else {
        throw dbErr;
      }
    }

    logAudit(env, null, auth.adminId, "admin_plan_update", { planId: id, planName: name }, request).catch(console.error);

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function handleDeleteSaaSPlan(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  try {
    const isAllowedIp = await checkIpRestriction(request, env);
    if (!isAllowedIp) return new Response(JSON.stringify({ error: "Access denied" }), { status: 403, headers });

    const auth = await verifyAdminAuth(request, env);
    if (!auth) return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });

    const body: any = await request.json();
    const { id } = body;

    if (!id) return new Response(JSON.stringify({ error: "Plan ID is required" }), { status: 400, headers });

    if (id === "free" || id === "unlimited") {
      return new Response(JSON.stringify({ error: "Default plans (free/unlimited) cannot be deleted" }), { status: 400, headers });
    }

    await env.DB.prepare("DELETE FROM saas_plans WHERE id = ?").bind(id).run();

    logAudit(env, null, auth.adminId, "admin_plan_delete", { planId: id }, request).catch(console.error);

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

// ----------------------------------------------------
// 2. 監査ログ管理 API
// ----------------------------------------------------
export async function handleGetAdminAuditLogs(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  try {
    const isAllowedIp = await checkIpRestriction(request, env);
    if (!isAllowedIp) return new Response(JSON.stringify({ error: "Access denied" }), { status: 403, headers });

    const auth = await verifyAdminAuth(request, env);
    if (!auth) return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });

    const { results } = await env.DB.prepare(`
      SELECT a.*, 
        COALESCE(u.display_name, sa.display_name) as userName, 
        w.name as workspaceName,
        CASE WHEN sa.id IS NOT NULL THEN 1 ELSE 0 END as isSaaSAdmin
      FROM audit_logs a 
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN saas_admins sa ON a.user_id = sa.id
      LEFT JOIN workspaces w ON a.workspace_id = w.id
      ORDER BY a.created_at DESC
      LIMIT 1000
    `).all<any>();

    return new Response(JSON.stringify({ 
      success: true, 
      data: results, 
      logs: results, 
      isSponsored: false 
    }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function handleGetWorkspaceAuditLogs(request: Request, env: Env, workspaceId: string): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });

    const member = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, userId).first<{ role: string }>();

    if (!member || (member.role !== "owner" && member.role !== "group_admin")) {
      return new Response(JSON.stringify({ error: "Forbidden: Insufficient permissions" }), { status: 403, headers });
    }

    let query = `
      SELECT a.*, u.display_name as userName 
      FROM audit_logs a 
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.workspace_id = ?
      ORDER BY a.created_at DESC LIMIT 1000
    `;

    const { results } = await env.DB.prepare(query).bind(workspaceId).all<any>();

    return new Response(JSON.stringify({ success: true, data: results }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}


// パブリック向けプラン一覧取得 API
export async function handleGetPublicSaaSPlans(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  try {
    const { results } = await env.DB.prepare(`
      SELECT 
        id, 
        name, 
        member_limit, 
        channel_limit, 
        storage_limit, 
        dm_enabled, 
        media_enabled, 
        allowed_extensions, 
        msg_retention_days,
        msg_retention_count,
        price_amount, 
        price_currency 
      FROM saas_plans 
      ORDER BY price_amount ASC
    `).all();

    return new Response(JSON.stringify({ success: true, plans: results }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

/**
 * ワークスペースのサブスクリプション情報とリソース使用状況を取得します。
 * GET /api/workspaces/:workspaceId/subscription
 */
export async function handleGetWorkspaceSubscription(request: Request, env: Env, workspaceId: string): Promise<Response> {
  const reqHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Workspace-Id, X-User-Id",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: reqHeaders });
  }

  try {
    if (!workspaceId) {
      return new Response(JSON.stringify({ error: "Workspace ID is required" }), { status: 400, headers: reqHeaders });
    }

    let planData: any = null;
    if (env.SAAS_LIMITS?.getWorkspaceSubscriptionPlan) {
      planData = await env.SAAS_LIMITS.getWorkspaceSubscriptionPlan(env, workspaceId);
    } else {
      const sub = await env.DB.prepare(`
        SELECT 
          s.plan, 
          COALESCE(p.storage_limit, s.storage_limit) as storage_limit, 
          COALESCE(p.member_limit, s.member_limit) as member_limit, 
          COALESCE(p.channel_limit, s.channel_limit) as channel_limit,
          COALESCE(p.dm_enabled, 1) as dm_enabled,
          COALESCE(p.media_enabled, 1) as media_enabled,
          COALESCE(p.allowed_extensions, '') as allowed_extensions,
          COALESCE(p.msg_retention_days, 0) as msg_retention_days,
          COALESCE(p.msg_retention_count, 0) as msg_retention_count,
          COALESCE(p.max_file_size_mb, 100) as max_file_size_mb,
          s.status,
          s.stripe_subscription_id,
          p.name as plan_name
        FROM workspace_subscriptions s
        LEFT JOIN saas_plans p ON s.plan = p.id
        WHERE s.workspace_id = ?
      `).bind(workspaceId).first<any>();

      if (sub) {
        planData = {
          plan: sub.plan,
          planName: sub.plan_name || "",
          storageLimit: sub.storage_limit,
          memberLimit: sub.member_limit,
          channelLimit: sub.channel_limit,
          dmEnabled: sub.dm_enabled === 1,
          mediaEnabled: sub.media_enabled === 1,
          allowedExtensions: sub.allowed_extensions || '',
          maxFileSizeMb: sub.max_file_size_mb || 100,
          msgRetentionDays: sub.msg_retention_days || 0,
          msgRetentionCount: sub.msg_retention_count || 0,
          status: sub.status,
          stripeSubscriptionId: sub.stripe_subscription_id || '',
        };
      } else {
        planData = {
          plan: "free",
          planName: "無料プラン",
          storageLimit: 52428800,
          memberLimit: 5,
          channelLimit: 3,
          dmEnabled: true,
          mediaEnabled: true,
          allowedExtensions: "",
          maxFileSizeMb: 100,
          msgRetentionDays: 0,
          msgRetentionCount: 0,
          status: "active",
          stripeSubscriptionId: "",
        };
      }
    }

    const [storageRes, memberRes, channelRes] = await Promise.all([
      env.DB.prepare("SELECT SUM(file_size) as total FROM files WHERE workspace_id = ?").bind(workspaceId).first<{ total: number | null }>().catch(() => ({ total: 0 })),
      env.DB.prepare("SELECT COUNT(*) as count FROM workspace_members WHERE workspace_id = ?").bind(workspaceId).first<{ count: number }>().catch(() => ({ count: 0 })),
      env.DB.prepare("SELECT COUNT(*) as count FROM channels WHERE workspace_id = ? AND (type = 'channel' OR type IS NULL)").bind(workspaceId).first<{ count: number }>().catch(() => ({ count: 0 })),
    ]);

    const storageUsed = storageRes?.total || 0;
    const memberUsed = memberRes?.count || 0;
    const channelUsed = channelRes?.count || 0;

    const responseData = {
      ...planData,
      storageUsed,
      memberUsed,
      channelUsed,
    };

    return new Response(JSON.stringify({
      success: true,
      data: responseData,
    }), {
      status: 200,
      headers: reqHeaders,
    });
  } catch (error: any) {
    console.error("Failed to get workspace subscription:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers: reqHeaders,
    });
  }
}

// システム全体のデフォルト制限値を取得する API ハンドラー
export async function handleGetSystemLimits(request: Request, env: Env): Promise<Response> {
  const systemHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: systemHeaders });

  try {
    // デフォルトプランを取得
    const defaultPlanSetting = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = ?"
    ).bind("default_saas_plan").first<{ value: string }>();
    const defaultPlan = defaultPlanSetting?.value || "free";

    // プランの表示名を取得
    const planDetail = await env.DB.prepare(
      "SELECT name FROM saas_plans WHERE id = ?"
    ).bind(defaultPlan).first<{ name: string }>();
    const planName = planDetail?.name || "無料プラン";

    // デフォルトのワークスペース作成上限数を取得
    const limitSetting = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = ?"
    ).bind("default_workspace_limit").first<{ value: string }>();
    const workspaceLimit = limitSetting ? parseInt(limitSetting.value, 10) : 3;

    return new Response(JSON.stringify({ 
      success: true, 
      plan: defaultPlan,
      planName,
      workspaceLimit
    }), { status: 200, headers: systemHeaders });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: systemHeaders });
  }
}


