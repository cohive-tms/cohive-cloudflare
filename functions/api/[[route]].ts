import { onRequest as coreOnRequest } from "./_api/core_handler";
import {
  handleVerifyAdminPath,
  handleSetupAdmin,
  handleLoginAdmin,
  handleVerifyAdminMfa,
  handleGetAdminStats,
  handleUpdateWorkspaceStatus,
  handleUpdateAdminSettings,
  handleGetCurrentAdmin,
  handleGetAdminAccounts,
  handleCreateAdminAccount,
  handleDeleteAdminAccount,
  handleUpdateMeAdmin,
  handleTransferOwnership,
  verifyAdminAuth,
  handleUpdateAdminAccount,
  handleUpdateUserStatus,
  handleGetActiveAnnouncements,
  handleGetAdminAnnouncements,
  handleCreateAdminAnnouncement,
  handleDeleteAdminAnnouncement,
  handleToggleAdminAnnouncement,
  handleUpdateAdminAnnouncement,
  handlePurgeWorkspaceData,
  handleGetWorkspaceBranding,
  handleUpdateWorkspaceBranding,
  handleUpdateAdminLanguage
} from "./_api/admin";
import { getSmtpSettings, saveSmtpSettings, deleteSmtpSettings, sendMail } from "./_utils/smtp";
import {
  handleGetSaaSPlans,
  handleCreateSaaSPlan,
  handleUpdateSaaSPlan,
  handleDeleteSaaSPlan,
  handleGetAdminAuditLogs,
  handleGetWorkspaceAuditLogs,
  handleGetPublicSaaSPlans,
  handleGetSystemLimits
} from "./_api/saas_extensions";

let migrationsRun = false;

async function runSaasMigrations(env: any) {
  if (migrationsRun) return;

  try {
    // SaaS用テーブル定義の自動構築
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS saas_plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        member_limit INTEGER NOT NULL,
        channel_limit INTEGER NOT NULL,
        storage_limit INTEGER NOT NULL,
        dm_enabled INTEGER DEFAULT 1,
        media_enabled INTEGER DEFAULT 1,
        allowed_extensions TEXT DEFAULT '',
        msg_retention_days INTEGER DEFAULT 0,
        msg_retention_count INTEGER DEFAULT 0,
        price_id TEXT DEFAULT '',
        price_amount INTEGER DEFAULT 0,
        price_currency TEXT DEFAULT 'jpy',
        max_file_size_mb INTEGER DEFAULT 100,
        updated_at TEXT
      )
    `).run();

    try {
      await env.DB.prepare("ALTER TABLE saas_plans ADD COLUMN updated_at TEXT").run();
    } catch (e) {}

    try {
      await env.DB.prepare("ALTER TABLE saas_plans ADD COLUMN max_file_size_mb INTEGER DEFAULT 100").run();
    } catch (e) {}

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS workspace_subscriptions (
        workspace_id TEXT PRIMARY KEY,
        plan TEXT NOT NULL,
        storage_limit INTEGER NOT NULL,
        member_limit INTEGER NOT NULL,
        channel_limit INTEGER NOT NULL,
        status TEXT NOT NULL,
        stripe_subscription_id TEXT DEFAULT '',
        stripe_customer_id TEXT DEFAULT '',
        current_period_end TEXT DEFAULT '',
        updated_at TEXT
      )
    `).run();

    try {
      await env.DB.prepare("ALTER TABLE workspace_subscriptions ADD COLUMN updated_at TEXT").run();
    } catch (e) {
      // すでに updated_at カラムが存在する場合は無視
    }

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS saas_admins (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        mfa_secret TEXT DEFAULT '',
        mfa_enabled INTEGER DEFAULT 0,
        language TEXT DEFAULT 'ja',
        created_at TEXT NOT NULL,
        updated_at TEXT
      )
    `).run();

    try {
      await env.DB.prepare("ALTER TABLE saas_admins ADD COLUMN updated_at TEXT").run();
    } catch (e) {
      // すでに updated_at カラムが存在する場合は無視
    }

    try {
      await env.DB.prepare("ALTER TABLE saas_admins ADD COLUMN language TEXT DEFAULT 'ja'").run();
    } catch (e) {
      // すでに language カラムが存在する場合は無視
    }

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS saas_admin_mfa_codes (
        id TEXT PRIMARY KEY,
        admin_id TEXT NOT NULL,
        code TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    try {
      await env.DB.prepare("ALTER TABLE saas_admin_mfa_codes ADD COLUMN attempts INTEGER DEFAULT 0").run();
    } catch (e) {
      // すでに attempts カラムが存在する場合は無視
    }

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        user_id TEXT,
        action TEXT NOT NULL,
        details TEXT NOT NULL,
        ip_address TEXT,
        local_ip TEXT,
        computer_name TEXT,
        created_at TEXT NOT NULL
      )
    `).run();
    try { await env.DB.prepare("ALTER TABLE audit_logs ADD COLUMN local_ip TEXT").run(); } catch (_) {}
    try { await env.DB.prepare("ALTER TABLE audit_logs ADD COLUMN computer_name TEXT").run(); } catch (_) {}

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS global_announcements (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT DEFAULT 'info',
        is_active INTEGER DEFAULT 1,
        start_at TEXT,
        end_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT
      )
    `).run();

    try {
      await env.DB.prepare("ALTER TABLE global_announcements ADD COLUMN start_at TEXT").run();
    } catch (e) {}
    try {
      await env.DB.prepare("ALTER TABLE global_announcements ADD COLUMN end_at TEXT").run();
    } catch (e) {}

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS workspace_brandings (
        workspace_id TEXT PRIMARY KEY,
        custom_logo_url TEXT DEFAULT '',
        primary_color TEXT DEFAULT '',
        brand_name TEXT DEFAULT '',
        updated_at TEXT
      )
    `).run();

    // デフォルトプランの挿入
    await env.DB.prepare(`
      INSERT OR IGNORE INTO saas_plans (id, name, member_limit, channel_limit, storage_limit, dm_enabled, media_enabled, allowed_extensions, msg_retention_days, msg_retention_count, price_amount, price_currency)
      VALUES 
      ('free', 'Free Plan', 5, 3, 52428800, 1, 1, 'jpg,jpeg,png,gif,webp,svg,bmp,ico,mp4,mov,avi,mkv,webm,m4v,mp3,m4a,wav,ogg,aac,flac,pdf,doc,docx,xls,xlsx,ppt,pptx,txt,csv,md,json,zip,7z,rar,tar,gz', 30, 1000, 0, 'jpy'),
      ('pro', 'Pro Plan', 20, 15, 536870912, 1, 1, 'jpg,jpeg,png,gif,webp,svg,bmp,ico,mp4,mov,avi,mkv,webm,m4v,mp3,m4a,wav,ogg,aac,flac,pdf,doc,docx,xls,xlsx,ppt,pptx,txt,csv,md,json,zip,7z,rar,tar,gz', 180, 10000, 980, 'jpy'),
      ('unlimited', 'Unlimited Plan', 9999, 9999, 9999999999, 1, 1, '', 0, 0, 2980, 'jpy')
    `).run();

    migrationsRun = true;
    console.log("SaaS Migrations executed successfully.");
  } catch (err) {
    console.error("Failed to run SaaS Migrations:", err);
  }
}

/**
 * Cloudflare Pages Functions の SaaS 用統合エントリーポイント。
 */
export const onRequest: PagesFunction<any> = async (context) => {
  const { env, request } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method;

  // 1. SaaS 固有のマイグレーション実行
  await runSaasMigrations(env);

  // 2. SaaS 固有のエンドポイントルーティング (インターセプト)
  try {
    const corsHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
    };

    // ワークスペース一時停止（suspended）アクセス制限インターセプター
    const targetWorkspaceId = request.headers.get("X-Workspace-Id") || 
      url.searchParams.get("workspaceId") || 
      pathname.match(/^\/api\/workspaces\/([^\/]+)/)?.[1];

    const isExemptRoute = 
      pathname.startsWith("/api/admin/") ||
      pathname.startsWith("/api/auth/") ||
      pathname.startsWith("/api/setup/") ||
      pathname === "/api/workspaces" ||
      pathname.endsWith("/subscription");

    if (targetWorkspaceId && !isExemptRoute) {
      try {
        const subRecord = await env.DB.prepare(
          "SELECT status FROM workspace_subscriptions WHERE workspace_id = ?"
        ).bind(targetWorkspaceId).first<{ status: string }>();

        if (subRecord && subRecord.status === 'suspended') {
          return new Response(JSON.stringify({ error: "Workspace is suspended by administrator." }), {
            status: 403,
            headers: corsHeaders
          });
        }
      } catch (e) {
        console.error("Failed to check workspace suspended status in SaaS interceptor:", e);
      }
    }

    // 一般ワークスペース用の SMTP 設定 API をブロック
    if (pathname === "/api/settings/smtp" || pathname === "/api/settings/smtp/test") {
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      return new Response(JSON.stringify({ error: "SaaS版では各ワークスペースで個別メール設定をすることはできません。" }), { status: 403, headers: corsHeaders });
    }

    // ----------------------------------------------------
    // SaaS 管理者用 API のハンドリング
    // ----------------------------------------------------
    if (pathname === "/api/admin/verify-path" && method === "POST") {
      return await handleVerifyAdminPath(request, env);
    }
    if (pathname === "/api/admin/setup" && method === "POST") {
      return await handleSetupAdmin(request, env);
    }
    if (pathname === "/api/admin/login" && method === "POST") {
      return await handleLoginAdmin(request, env);
    }
    if (pathname === "/api/admin/login/verify" && method === "POST") {
      return await handleVerifyAdminMfa(request, env);
    }
    if (pathname === "/api/admin/stats" && method === "GET") {
      return await handleGetAdminStats(request, env);
    }
    if (pathname === "/api/admin/settings" && method === "PUT") {
      return await handleUpdateAdminSettings(request, env);
    }
    if (pathname === "/api/admin/me" && method === "GET") {
      return await handleGetCurrentAdmin(request, env);
    }
    if (pathname === "/api/admin/workspaces" && method === "PUT") {
      return await handleUpdateWorkspaceStatus(request, env);
    }
    if (pathname === "/api/admin/users/status" && (method === "POST" || method === "PUT")) {
      return await handleUpdateUserStatus(request, env);
    }

    // SaaS 管理者用 SMTP 設定 API のハンドリング
    if (pathname === "/api/admin/settings/smtp") {
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      const auth = await verifyAdminAuth(request, env);
      if (!auth) {
        return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers: corsHeaders });
      }

      if (method === "GET") {
        const settings = await getSmtpSettings(env);
        if (!settings) {
          return new Response(JSON.stringify({ settings: null }), { status: 200, headers: corsHeaders });
        }
        return new Response(JSON.stringify({ settings: { ...settings, pass: "********" } }), { status: 200, headers: corsHeaders });
      }

      if (method === "PUT") {
        const body: any = await request.json();
        const { host, port, user, pass, fromName, mfaEnabled } = body;
        if (!host || !port || !user || !pass) {
          return new Response(JSON.stringify({ error: "Missing required SMTP parameters" }), { status: 400, headers: corsHeaders });
        }

        let targetPass = pass;
        if (pass === "********") {
          const current = await getSmtpSettings(env);
          targetPass = current?.pass || "";
        }

        const settings = {
          host,
          port: parseInt(port, 10),
          user,
          pass: targetPass,
          fromName,
          mfaEnabled: !!mfaEnabled,
        };

        await saveSmtpSettings(env, settings);
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
      }

      if (method === "DELETE") {
        await deleteSmtpSettings(env);
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
      }
    }

    if (pathname === "/api/admin/settings/smtp/test" && method === "POST") {
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      const auth = await verifyAdminAuth(request, env);
      if (!auth) {
        return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers: corsHeaders });
      }

      const body: any = await request.json();
      const { host, port, user, pass, fromName, testRecipient } = body;
      if (!host || !port || !user || !pass || !testRecipient) {
        return new Response(JSON.stringify({ error: "Missing required parameters for SMTP test" }), { status: 400, headers: corsHeaders });
      }

      let targetPass = pass;
      if (pass === "********") {
        const current = await getSmtpSettings(env);
        targetPass = current?.pass || "";
      }

      const settings = {
        host,
        port: parseInt(port, 10),
        user,
        pass: targetPass,
        fromName,
        mfaEnabled: false,
      };

      try {
        await sendMail(settings, {
          to: testRecipient,
          subject: "CoHive SMTP Test Mail",
          text: "This is a test email from CoHive SaaS Admin console.",
          html: "<p>This is a test email from CoHive SaaS Admin console.</p>"
        });
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message || "Failed to send test mail" }), { status: 500, headers: corsHeaders });
      }
    }

    // SaaS 管理者アカウント管理 API
    if (pathname === "/api/admin/accounts") {
      if (method === "GET") return await handleGetAdminAccounts(request, env);
      if (method === "POST") return await handleCreateAdminAccount(request, env);
      if (method === "PUT") return await handleUpdateAdminAccount(request, env);
      if (method === "DELETE") return await handleDeleteAdminAccount(request, env);
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } });
    }
    if (pathname === "/api/admin/accounts/me" && method === "PUT") {
      return await handleUpdateMeAdmin(request, env);
    }
    if (pathname === "/api/admin/profile") {
      if (method === "PUT") return await handleUpdateAdminLanguage(request, env);
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (pathname === "/api/admin/accounts/transfer-ownership" && method === "POST") {
      return await handleTransferOwnership(request, env);
    }

    // SaaS 管理者用 プラン管理 API
    if (pathname === "/api/admin/plans") {
      if (method === "GET") return await handleGetSaaSPlans(request, env);
      if (method === "POST") return await handleCreateSaaSPlan(request, env);
      if (method === "PUT") return await handleUpdateSaaSPlan(request, env);
      if (method === "DELETE") return await handleDeleteSaaSPlan(request, env);
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } });
    }

    // SaaS 管理者用 監査ログ API
    if (pathname === "/api/admin/audit-logs") {
      if (method === "GET") return await handleGetAdminAuditLogs(request, env);
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } });
    }

    // 📢 一括アナウンス API
    if (pathname === "/api/announcements/active" && method === "GET") {
      return await handleGetActiveAnnouncements(request, env);
    }

    if (pathname === "/api/admin/announcements") {
      if (method === "GET") return await handleGetAdminAnnouncements(request, env);
      if (method === "POST") return await handleCreateAdminAnnouncement(request, env);
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } });
    }

    if (pathname.startsWith("/api/admin/announcements/")) {
      const parts = pathname.split("/");
      const announcementId = parts[4];
      if (announcementId) {
        if (parts[5] === "toggle" && (method === "PATCH" || method === "POST")) {
          return await handleToggleAdminAnnouncement(request, env, announcementId);
        }
        if (method === "PUT" || method === "PATCH") {
          return await handleUpdateAdminAnnouncement(request, env, announcementId);
        }
        if (method === "DELETE") {
          return await handleDeleteAdminAnnouncement(request, env, announcementId);
        }
      }
    }

    // 🗑️ ワークスペース D1/R2 全データ完全パージ (完全削除) API
    if (pathname.startsWith("/api/admin/workspaces/") && pathname.endsWith("/purge")) {
      const match = pathname.match(/\/api\/admin\/workspaces\/([^\/]+)\/purge/);
      if (match && method === "DELETE") {
        return await handlePurgeWorkspaceData(request, env, match[1]);
      }
    }

    // 🎨 ワークスペース ブランディング API
    if (pathname.startsWith("/api/workspaces/") && pathname.endsWith("/branding")) {
      const match = pathname.match(/\/api\/workspaces\/([^\/]+)\/branding/);
      if (match) {
        const workspaceId = match[1];
        if (method === "GET") return await handleGetWorkspaceBranding(request, env, workspaceId);
        if (method === "PUT") return await handleUpdateWorkspaceBranding(request, env, workspaceId);
        if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
      }
    }



    // ----------------------------------------------------
    // 一般ユーザー用プラン / 決済 API (SaaS拡張分)
    // ----------------------------------------------------
    if (pathname === "/api/plans" && method === "GET") {
      return await handleGetPublicSaaSPlans(request, env);
    }

    if (pathname === "/api/system/limits" && (method === "GET" || method === "OPTIONS")) {
      return await handleGetSystemLimits(request, env);
    }



    if (pathname.startsWith("/api/workspaces/") && pathname.endsWith("/audit-logs")) {
      const match = pathname.match(/\/api\/workspaces\/([^\/]+)\/audit-logs/);
      if (match) {
        const workspaceId = match[1];
        if (method === "GET") {
          return await handleGetWorkspaceAuditLogs(request, env, workspaceId);
        }
      }
    }
  } catch (err: any) {
    console.error("SaaS Interceptor error:", err);
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  // SaaS 特特の制限ロジックをフックとして注入
  env.SAAS_LIMITS = {
    /**
     * SaaS用のプラン設定情報をデータベースから取得します。
     * レコードが存在しない場合はデフォルトの無料プラン（free）で初期登録します。
     */
    getWorkspaceSubscriptionPlan: async (coreEnv: any, workspaceId: string) => {
      try {
        const sub = await coreEnv.DB.prepare(`
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
          return {
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
          // 既存のワークスペースなどでレコードが存在しない場合は、DBにデフォルト（default_saas_plan、なければ 'free'）レコードを挿入して初期化
          const defaultPlanSetting = await coreEnv.DB.prepare(
            "SELECT value FROM system_settings WHERE key = ?"
          ).bind("default_saas_plan").first<{ value: string }>();
          const defaultPlan = defaultPlanSetting?.value || "free";

          // saas_plans からデフォルトプランの設定値を取得
          const planDetail = await coreEnv.DB.prepare(
            "SELECT name, storage_limit, member_limit, channel_limit, dm_enabled, media_enabled, allowed_extensions, msg_retention_days, msg_retention_count, max_file_size_mb FROM saas_plans WHERE id = ?"
          ).bind(defaultPlan).first<any>();

          const storageLimit = planDetail ? planDetail.storage_limit : 52428800; // 50MB
          const memberLimit = planDetail ? planDetail.member_limit : 5;
          const channelLimit = planDetail ? planDetail.channel_limit : 3;
          const dmEnabled = planDetail ? planDetail.dm_enabled === 1 : true;
          const mediaEnabled = planDetail ? planDetail.media_enabled === 1 : true;
          const allowedExtensions = planDetail ? planDetail.allowed_extensions : 'jpg,jpeg,png,gif,webp,svg,bmp,ico,mp4,mov,avi,mkv,webm,m4v,mp3,m4a,wav,ogg,aac,flac,pdf,doc,docx,xls,xlsx,ppt,pptx,txt,csv,md,json,zip,7z,rar,tar,gz';
          const maxFileSizeMb = planDetail ? (planDetail.max_file_size_mb || 100) : 100;
          const msgRetentionDays = planDetail ? planDetail.msg_retention_days : 30;
          const msgRetentionCount = planDetail ? planDetail.msg_retention_count : 1000;
          const planName = planDetail ? planDetail.name : "無料プラン";

          try {
            await coreEnv.DB.prepare(
              "INSERT INTO workspace_subscriptions (workspace_id, plan, storage_limit, member_limit, channel_limit, status) VALUES (?, ?, ?, ?, ?, 'active')"
            ).bind(workspaceId, defaultPlan, storageLimit, memberLimit, channelLimit).run();
          } catch (insertErr) {
            console.warn("SaaS Hook: Failed to auto-insert default workspace subscription:", insertErr);
          }
          return {
            plan: defaultPlan,
            planName,
            storageLimit,
            memberLimit,
            channelLimit,
            dmEnabled,
            mediaEnabled,
            allowedExtensions,
            maxFileSizeMb,
            msgRetentionDays,
            msgRetentionCount,
            status: "active",
          };
        }
      } catch (err) {
        console.warn("SaaS Hook: workspace_subscriptions/saas_plans check failed, using default free plan:", err);
      }
      return { 
        plan: "free", 
        planName: "無料プラン",
        storageLimit: 52428800, 
        memberLimit: 5, 
        channelLimit: 3, 
        dmEnabled: true, 
        mediaEnabled: true, 
        allowedExtensions: "jpg,jpeg,png,gif,webp,txt,csv,md,json,pdf,doc,docx,xls,xlsx,ppt,pptx", 
        msgRetentionDays: 30,
        msgRetentionCount: 1000,
        status: "active" 
      };
    },

    /**
     * ワークスペース作成時のサブスクリプション初期化
     */
    onWorkspaceCreated: async (coreEnv: any, workspaceId: string) => {
      try {
        const defaultPlanSetting = await coreEnv.DB.prepare(
          "SELECT value FROM system_settings WHERE key = ?"
        ).bind("default_saas_plan").first<{ value: string }>();
        const defaultPlan = defaultPlanSetting?.value || "free";

        const planDetail = await coreEnv.DB.prepare(
          "SELECT storage_limit, member_limit, channel_limit FROM saas_plans WHERE id = ?"
        ).bind(defaultPlan).first<{ storage_limit: number; member_limit: number; channel_limit: number }>();

        const storageLimit = planDetail ? planDetail.storage_limit : 52428800; // 50MB
        const memberLimit = planDetail ? planDetail.member_limit : 5;
        const channelLimit = planDetail ? planDetail.channel_limit : 3;

        await coreEnv.DB.prepare(
          "INSERT INTO workspace_subscriptions (workspace_id, plan, storage_limit, member_limit, channel_limit, status) VALUES (?, ?, ?, ?, ?, 'active')"
        ).bind(workspaceId, defaultPlan, storageLimit, memberLimit, channelLimit).run();
      } catch (err) {
        console.error("SaaS Hook: Failed to initialize default workspace subscription during creation:", err);
      }
    },

    /**
     * メッセージ送信時に、プラン別の保持期間・件数を過ぎた古いメッセージを自動物理クリーンアップします。
     */
    checkAndCleanupMessagesLimit: async (coreEnv: any, channelId: string) => {
      try {
        const channel = await coreEnv.DB.prepare(
          "SELECT workspace_id FROM channels WHERE id = ?"
        ).bind(channelId).first<{ workspace_id: string }>();

        if (!channel?.workspace_id) return;

        const sub = await coreEnv.SAAS_LIMITS.getWorkspaceSubscriptionPlan(coreEnv, channel.workspace_id);
        const days = sub?.msgRetentionDays || 0;
        const count = sub?.msgRetentionCount || 0;

        // 1. 日数制限のパージ (days > 0 の場合)
        if (days > 0) {
          const limitDate = new Date();
          limitDate.setDate(limitDate.getDate() - days);
          const limitIso = limitDate.toISOString();

          await coreEnv.DB.prepare(
            "DELETE FROM messages WHERE channel_id = ? AND created_at < ?"
          ).bind(channelId, limitIso).run();

          console.log(`SaaS Hook: Auto-cleaned messages in channel ${channelId} older than ${limitIso} (${days} days).`);
        }

        // 2. 件数制限のパージ (count > 0 の場合)
        if (count > 0) {
          const totalCountResult = await coreEnv.DB.prepare(
            "SELECT COUNT(*) as count FROM messages WHERE channel_id = ?"
          ).bind(channelId).first<{ count: number }>();

          if (totalCountResult && totalCountResult.count > count) {
            await coreEnv.DB.prepare(`
              DELETE FROM messages 
              WHERE channel_id = ? 
              AND id NOT IN (
                SELECT id FROM messages 
                WHERE channel_id = ? 
                ORDER BY created_at DESC, id DESC 
                LIMIT ?
              )
            `).bind(channelId, channelId, count).run();
            console.log(`SaaS Hook: Auto-cleaned messages in channel ${channelId} keeping only latest ${count} messages.`);
          }
        }
      } catch (err) {
        console.error("SaaS Hook: Failed to execute message auto-cleanup:", err);
      }
    },

    /**
     * メッセージ取得APIで過去何日分の履歴を返すかを判定します。
     */
    getMessageFilterDays: async (coreEnv: any, channelId: string): Promise<number> => {
      try {
        const channel = await coreEnv.DB.prepare(
          "SELECT workspace_id FROM channels WHERE id = ?"
        ).bind(channelId).first<{ workspace_id: string }>();

        if (!channel?.workspace_id) return 0;

        const sub = await coreEnv.SAAS_LIMITS.getWorkspaceSubscriptionPlan(coreEnv, channel.workspace_id);
        return sub?.msgRetentionDays || 0;
      } catch (err) {
        console.error("SaaS Hook: Failed to get message filter days:", err);
      }
      return 0;
    }
  };

  // コアのAPIハンドラーを実行
  return coreOnRequest(context);
};

export default {
  async fetch(request: Request, env: any, ctx: any) {
    const url = new URL(request.url);

    // 1. APIエンドポイント (/api/...) のハンドリング
    if (url.pathname.startsWith('/api/')) {
      return onRequest({
        request,
        env,
        params: {},
        waitUntil: ctx?.waitUntil ? ctx.waitUntil.bind(ctx) : () => {},
        passThroughOnException: () => {},
        next: () => Promise.resolve(new Response('Not Found', { status: 404 }))
      } as any);
    }

    // 2. SPA/静的ファイルのリクエスト処理 (SPAルーティングフォールバック)
    if (env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request);
      // 正常アセット(2xx, 304)のみ直接返し、307/302リダイレクトや404はSPA fallback(index.html)へ流す
      if ((assetRes.status >= 200 && assetRes.status < 300) || assetRes.status === 304) {
        return assetRes;
      }
      // SPA Fallback: /admin など直接アクセス時に index.html を返して React SPA で処理させる
      return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
    }

    return new Response('Not Found', { status: 404 });
  }
};
