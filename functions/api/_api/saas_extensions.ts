import type { Env } from "../[[route]]";
import { decryptText, encryptText, getEncryptionSecret } from "../_utils/smtp";
import { logAudit } from "../_utils/audit";
import { checkIsSponsored } from "../_utils/saas";
import { checkIpRestriction, verifyAdminAuth } from "./admin";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ----------------------------------------------------
// Stripe 設定ヘルパー
// ----------------------------------------------------
export interface StripeSettings {
  enabled: boolean;
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
}

export async function getStripeSettings(env: Env): Promise<StripeSettings | null> {
  try {
    const stripeEnabled = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = ?"
    ).bind("stripe_enabled").first<{ value: string }>();

    if (!stripeEnabled || stripeEnabled.value !== "1") {
      return { enabled: false, secretKey: "", publishableKey: "", webhookSecret: "" };
    }

    const result = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = ?"
    ).bind("stripe_settings").first<{ value: string }>();

    if (!result || !result.value) {
      return { enabled: true, secretKey: "", publishableKey: "", webhookSecret: "" };
    }

    const secret = await getEncryptionSecret(env);
    const decryptedJson = await decryptText(result.value, secret);
    const parsed = JSON.parse(decryptedJson);
    return {
      enabled: true,
      secretKey: parsed.secretKey || "",
      publishableKey: parsed.publishableKey || "",
      webhookSecret: parsed.webhookSecret || "",
    };
  } catch (e) {
    console.error("Failed to retrieve or decrypt Stripe settings:", e);
    return { enabled: false, secretKey: "", publishableKey: "", webhookSecret: "" };
  }
}

export async function saveStripeSettings(env: Env, settings: StripeSettings): Promise<void> {
  const secret = await getEncryptionSecret(env);
  const encryptedJson = await encryptText(JSON.stringify(settings), secret);

  await env.DB.prepare(
    "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  ).bind("stripe_settings", encryptedJson).run();
}

// Stripe API Call Helper (fetch)
async function callStripe(env: Env, path: string, options: any = {}): Promise<any> {
  const stripeSettings = await getStripeSettings(env);
  if (!stripeSettings || !stripeSettings.enabled || !stripeSettings.secretKey) {
    throw new Error("Stripe is disabled or not configured");
  }

  const method = options.method || "GET";
  const body = options.body ? new URLSearchParams(options.body).toString() : undefined;

  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${stripeSettings.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || "Stripe API Error");
  }
  return data;
}

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

    const isSponsored = await checkIsSponsored(env);
    return new Response(JSON.stringify({ 
      success: true, 
      data: results, 
      logs: results, 
      isSponsored 
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

    const isSponsored = await checkIsSponsored(env);
    let query = `
      SELECT a.*, u.display_name as userName 
      FROM audit_logs a 
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.workspace_id = ?
    `;

    if (!isSponsored) {
      // 7日制限
      query += ` AND a.created_at >= datetime('now', '-7 days')`;
    }

    query += ` ORDER BY a.created_at DESC LIMIT 1000`;

    const { results } = await env.DB.prepare(query).bind(workspaceId).all<any>();

    return new Response(JSON.stringify({ success: true, data: results }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

// ----------------------------------------------------
// 3. Stripe 課金 API
// ----------------------------------------------------
export async function handleCreateBillingCheckout(request: Request, env: Env, workspaceId: string): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  try {
    const stripeSettings = await getStripeSettings(env);
    if (!stripeSettings || !stripeSettings.enabled) {
      return new Response(JSON.stringify({ error: "Billing functionality is disabled" }), { status: 400, headers });
    }

    const userId = request.headers.get("X-User-Id");
    if (!userId) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });

    // ワークスペースの所有者か確認
    const member = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, userId).first<{ role: string }>();

    if (!member || member.role !== "owner") {
      return new Response(JSON.stringify({ error: "Forbidden: Only workspace owners can manage subscription" }), { status: 403, headers });
    }

    const body: any = await request.json();
    const { planId } = body;
    if (!planId) return new Response(JSON.stringify({ error: "Plan ID is required" }), { status: 400, headers });

    const plan = await env.DB.prepare("SELECT * FROM saas_plans WHERE id = ?").bind(planId).first<any>();
    if (!plan || !plan.price_id) {
      return new Response(JSON.stringify({ error: "Selected plan does not have a price associated" }), { status: 400, headers });
    }

    const url = new URL(request.url);
    const successUrl = `${url.protocol}//${url.host}/?workspaceId=${workspaceId}&billing_status=success`;
    const cancelUrl = `${url.protocol}//${url.host}/?workspaceId=${workspaceId}&billing_status=cancel`;

    // 既存サブスクの顧客IDを取得
    const subRecord = await env.DB.prepare(
      "SELECT stripe_subscription_id FROM workspace_subscriptions WHERE workspace_id = ?"
    ).bind(workspaceId).first<{ stripe_subscription_id: string }>();

    let customerId = "";
    if (subRecord?.stripe_subscription_id) {
      try {
        const stripeSub = await callStripe(env, `/subscriptions/${subRecord.stripe_subscription_id}`);
        customerId = stripeSub.customer;
      } catch {}
    }

    const checkoutParams: any = {
      "payment_method_types[0]": "card",
      "mode": "subscription",
      "line_items[0][price]": plan.price_id,
      "line_items[0][quantity]": "1",
      "success_url": successUrl,
      "cancel_url": cancelUrl,
      "metadata[workspaceId]": workspaceId,
      "metadata[planId]": planId,
    };

    if (customerId) {
      checkoutParams["customer"] = customerId;
    }

    const session = await callStripe(env, "/checkout/sessions", {
      method: "POST",
      body: checkoutParams,
    });

    return new Response(JSON.stringify({ success: true, url: session.url }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function handleCreateBillingPortal(request: Request, env: Env, workspaceId: string): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  try {
    const stripeSettings = await getStripeSettings(env);
    if (!stripeSettings || !stripeSettings.enabled) {
      return new Response(JSON.stringify({ error: "Billing functionality is disabled" }), { status: 400, headers });
    }

    const userId = request.headers.get("X-User-Id");
    if (!userId) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });

    const member = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, userId).first<{ role: string }>();

    if (!member || member.role !== "owner") {
      return new Response(JSON.stringify({ error: "Forbidden: Only workspace owners can access portal" }), { status: 403, headers });
    }

    const subRecord = await env.DB.prepare(
      "SELECT stripe_subscription_id FROM workspace_subscriptions WHERE workspace_id = ?"
    ).bind(workspaceId).first<{ stripe_subscription_id: string }>();

    if (!subRecord?.stripe_subscription_id) {
      return new Response(JSON.stringify({ error: "No active paid subscription found for this workspace" }), { status: 400, headers });
    }

    // Stripeから顧客IDを取得
    const stripeSub = await callStripe(env, `/subscriptions/${subRecord.stripe_subscription_id}`);
    const customerId = stripeSub.customer;

    const url = new URL(request.url);
    const returnUrl = `${url.protocol}//${url.host}/?workspaceId=${workspaceId}`;

    const portalSession = await callStripe(env, "/billing_portal/sessions", {
      method: "POST",
      body: {
        customer: customerId,
        return_url: returnUrl,
      },
    });

    return new Response(JSON.stringify({ success: true, url: portalSession.url }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

// Stripe Webhook 署名検証
async function verifyStripeSignature(body: string, signatureHeader: string, secret: string): Promise<boolean> {
  try {
    const parts = signatureHeader.split(",");
    const t = parts.find(p => p.startsWith("t="))?.substring(2);
    const v1 = parts.find(p => p.startsWith("v1="))?.substring(3);
    if (!t || !v1) return false;

    const signedPayload = `${t}.${body}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(signedPayload)
    );
    const signatureHex = Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, "0")).join("");
    return signatureHex === v1;
  } catch (err) {
    console.error("Signature verification helper failed:", err);
    return false;
  }
}

export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  try {
    const stripeSettings = await getStripeSettings(env);
    if (!stripeSettings || !stripeSettings.enabled) {
      return new Response("Webhook ignored (Stripe disabled)", { status: 200 });
    }

    const signature = request.headers.get("stripe-signature");
    if (!signature) {
      return new Response("Missing signature header", { status: 400 });
    }

    const bodyText = await request.text();

    // 署名シークレットが設定されている場合のみ検証
    if (stripeSettings.webhookSecret) {
      const isValid = await verifyStripeSignature(bodyText, signature, stripeSettings.webhookSecret);
      if (!isValid) {
        console.warn("[Stripe Webhook] Invalid signature");
        return new Response("Invalid signature", { status: 400 });
      }
    }

    const event = JSON.parse(bodyText);
    console.log(`[Stripe Webhook] Received event: ${event.type}`);

    const subObject = event.data.object;

    if (event.type === "checkout.session.completed") {
      const workspaceId = subObject.metadata?.workspaceId;
      const planId = subObject.metadata?.planId;
      const stripeSubId = subObject.subscription;

      if (workspaceId && planId && stripeSubId) {
        // プランの設定情報を読み込み
        const plan = await env.DB.prepare("SELECT * FROM saas_plans WHERE id = ?").bind(planId).first<any>();
        if (plan) {
          await env.DB.prepare(`
            INSERT INTO workspace_subscriptions (workspace_id, plan, storage_limit, member_limit, channel_limit, status, stripe_subscription_id, updated_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?, datetime('now'))
            ON CONFLICT(workspace_id) DO UPDATE SET
              plan = excluded.plan,
              storage_limit = excluded.storage_limit,
              member_limit = excluded.member_limit,
              channel_limit = excluded.channel_limit,
              status = 'active',
              stripe_subscription_id = excluded.stripe_subscription_id,
              updated_at = excluded.updated_at
          `).bind(workspaceId, planId, plan.storage_limit, plan.member_limit, plan.channel_limit, stripeSubId).run();

          // 監査ログ
          logAudit(env, workspaceId, null, "plan_change", { planId, method: "stripe_checkout", subId: stripeSubId }).catch(console.error);
          console.log(`[Stripe Webhook] Workspace ${workspaceId} upgraded to plan ${planId}`);
        }
      }
    }

    if (event.type === "customer.subscription.updated") {
      const stripeSubId = subObject.id;
      const status = subObject.status; // active, trialing, past_due, unpaid, canceled, incomplete

      // stripe_subscription_id を含むワークスペースを検索
      const subRecord = await env.DB.prepare(
        "SELECT workspace_id, plan FROM workspace_subscriptions WHERE stripe_subscription_id = ?"
      ).bind(stripeSubId).first<{ workspace_id: string; plan: string }>();

      if (subRecord) {
        let newStatus = "active";
        if (status === "past_due" || status === "unpaid") {
          newStatus = "suspended";
          console.log(`[Stripe Webhook] Subscription unpaid, suspending workspace ${subRecord.workspace_id}`);
        }

        await env.DB.prepare(
          "UPDATE workspace_subscriptions SET status = ?, updated_at = datetime('now') WHERE workspace_id = ?"
        ).bind(newStatus, subRecord.workspace_id).run();

        // 監査ログ
        logAudit(env, subRecord.workspace_id, null, "plan_status_update", { subId: stripeSubId, stripeStatus: status, localStatus: newStatus }).catch(console.error);
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const stripeSubId = subObject.id;

      const subRecord = await env.DB.prepare(
        "SELECT workspace_id FROM workspace_subscriptions WHERE stripe_subscription_id = ?"
      ).bind(stripeSubId).first<{ workspace_id: string }>();

      if (subRecord) {
        // 無料プランに戻す
        const defaultPlanSetting = await env.DB.prepare(
          "SELECT value FROM system_settings WHERE key = ?"
        ).bind("default_saas_plan").first<{ value: string }>();
        const defaultPlan = defaultPlanSetting?.value || "free";

        const plan = await env.DB.prepare("SELECT * FROM saas_plans WHERE id = ?").bind(defaultPlan).first<any>();
        const storageLimit = plan ? plan.storage_limit : 52428800;
        const memberLimit = plan ? plan.member_limit : 5;
        const channelLimit = plan ? plan.channel_limit : 3;

        await env.DB.prepare(`
          UPDATE workspace_subscriptions SET
            plan = ?,
            storage_limit = ?,
            member_limit = ?,
            channel_limit = ?,
            status = 'active',
            stripe_subscription_id = NULL,
            updated_at = datetime('now')
          WHERE workspace_id = ?
        `).bind(defaultPlan, storageLimit, memberLimit, channelLimit, subRecord.workspace_id).run();

        // 監査ログ
        logAudit(env, subRecord.workspace_id, null, "plan_change", { planId: defaultPlan, method: "stripe_delete", subId: stripeSubId }).catch(console.error);
        console.log(`[Stripe Webhook] Subscription deleted, reverting workspace ${subRecord.workspace_id} to default ${defaultPlan} plan`);
      }
    }

    return new Response("Webhook processed", { status: 200 });
  } catch (err: any) {
    console.error("Stripe Webhook processing failed:", err);
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


