import type { Env } from "../[[route]]";
import { signJWT, verifyJWT, getJwtSecret } from "../_utils/jwt";
import { hashPassword, verifyPassword, generateRecoveryCode } from "./setup";
import { sendMail, getSmtpSettings } from "../_utils/smtp";
import { getStripeSettings, saveStripeSettings, StripeSettings } from "./saas_extensions";
import { logAudit } from "../_utils/audit";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
};

// IP制限チェックヘルパー
export async function checkIpRestriction(request: Request, env: Env): Promise<boolean> {
  try {
    const allowedIpsSetting = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = ?"
    ).bind("saas_admin_allowed_ips").first<{ value: string }>();

    if (!allowedIpsSetting || !allowedIpsSetting.value.trim()) {
      return true; // 設定されていなければ無制限
    }

    const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
    const allowedList = allowedIpsSetting.value.split(",")
      .map(ip => ip.trim())
      .filter(ip => ip.length > 0);

    return allowedList.includes(clientIp);
  } catch (err) {
    console.error("IP restriction check failed:", err);
    return true; 
  }
}

// 管理者JWT認証ヘルパー
export async function verifyAdminAuth(request: Request, env: Env): Promise<any | null> {
  try {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return null;
    }
    const token = authHeader.substring(7);
    const secret = await getJwtSecret(env);
    const payload = await verifyJWT(token, secret);
    
    if (payload && payload.type === "saas_admin") {
      return payload;
    }
    return null;
  } catch {
    return null;
  }
}

// 1. 管理画面URLパス検証
export async function handleVerifyAdminPath(request: Request, env: Env): Promise<Response> {
  try {
    const body: any = await request.json();
    const { path } = body;
    
    if (!path) {
      return new Response(JSON.stringify({ error: "Path is required" }), { status: 400, headers });
    }

    const currentPathSetting = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = ?"
    ).bind("saas_admin_path").first<{ value: string }>();

    const currentPath = currentPathSetting?.value || "admin";
    const isValid = path === currentPath;

    return new Response(JSON.stringify({ success: true, valid: isValid }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 2. SaaS管理者初期セットアップ
export async function handleSetupAdmin(request: Request, env: Env): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM saas_admins"
    ).all<{ count: number }>();

    const count = results?.[0]?.count ?? 0;
    if (count > 0) {
      return new Response(JSON.stringify({ error: "SaaS Admin has already been initialized." }), { status: 403, headers });
    }

    const body: any = await request.json();
    const { email, password, displayName } = body;

    if (!email || !password || !displayName) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400, headers });
    }

    const passwordHash = await hashPassword(password);
    const adminId = crypto.randomUUID();

    try {
      await env.DB.prepare(
        "INSERT INTO saas_admins (id, email, password_hash, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, 'owner', datetime('now'), datetime('now'))"
      ).bind(adminId, email, passwordHash, displayName).run();
    } catch (dbErr: any) {
      if (dbErr?.message?.includes("updated_at")) {
        await env.DB.prepare("ALTER TABLE saas_admins ADD COLUMN updated_at TEXT").run().catch(() => {});
        await env.DB.prepare(
          "INSERT INTO saas_admins (id, email, password_hash, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, 'owner', datetime('now'), datetime('now'))"
        ).bind(adminId, email, passwordHash, displayName).run();
      } else {
        throw dbErr;
      }
    }

    return new Response(JSON.stringify({ success: true, message: "SaaS Admin initialized successfully." }), { status: 201, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 3. SaaS管理者ログイン（一時MFAコード発行）
export async function handleLoginAdmin(request: Request, env: Env): Promise<Response> {
  try {
    // IP制限チェック
    const isAllowedIp = await checkIpRestriction(request, env);
    if (!isAllowedIp) {
      return new Response(JSON.stringify({ error: "Access denied from this IP address" }), { status: 403, headers });
    }

    const body: any = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return new Response(JSON.stringify({ error: "Email and password are required" }), { status: 400, headers });
    }

    const admin = await env.DB.prepare(
      "SELECT * FROM saas_admins WHERE email = ?"
    ).bind(email).first<any>();

    if (!admin || !(await verifyPassword(password, admin.password_hash))) {
      return new Response(JSON.stringify({ error: "Invalid email or password" }), { status: 401, headers });
    }

    // SMTP設定を取得
    const smtpSettings = await getSmtpSettings(env);

    // SMTP設定が未設定の場合、MFAをスキップしてその場で正式な管理者トークンを発行する
    if (!smtpSettings) {
      console.log(`[SaaS Admin Login] SMTP settings not configured. Skipping MFA for ${email}`);
      const secret = await getJwtSecret(env);
      const token = await signJWT(
        { adminId: admin.id, role: admin.role, type: "saas_admin", exp: Math.floor(Date.now() / 1000) + 12 * 3600 },
        secret
      );

      logAudit(env, null, admin.id, "admin_login", { email: admin.email, mfa: false }, request).catch(console.error);

      return new Response(JSON.stringify({
        success: true,
        mfaRequired: false,
        token,
        admin: {
          id: admin.id,
          email: admin.email,
          displayName: admin.display_name,
          role: admin.role
        }
      }), { status: 200, headers });
    }

    // 6桁のランダムな数字のMFAコード生成
    const code = Math.floor(100000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5分間有効
    const tempSessionId = crypto.randomUUID();

    await env.DB.prepare(
      "INSERT INTO saas_admin_mfa_codes (id, admin_id, code, expires_at, attempts) VALUES (?, ?, ?, ?, 0)"
    ).bind(tempSessionId, admin.id, code, expiresAt).run();

    // 開発用にコンソールに出力
    console.log(`[SaaS Admin MFA] Code generated for ${email}: ${code} (tempSessionId: ${tempSessionId})`);

    // メール送信
    try {
      if (smtpSettings) {
        await sendMail(smtpSettings, {
          to: email,
          subject: "[CoHive Admin] 管理画面 2段階認証コード",
          text: `CoHive管理画面へのログインが要求されました。\n\n一時認証コード: ${code}\n\nこのコードは5分間有効です。心当たりがない場合は無視してください。`,
          html: `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eaeaea; border-radius: 5px; max-width: 600px; margin: 0 auto; color: #333;">
              <h2 style="color: #0ea5e9; border-bottom: 2px solid #0ea5e9; padding-bottom: 8px; margin-top: 0;">CoHive 管理者ログイン認証</h2>
              <p>管理画面へのログイン用の認証コードを発行しました。</p>
              <div style="background: #f1f5f9; padding: 20px; text-align: center; border-radius: 8px; font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #0f172a; margin: 20px 0;">
                ${code}
              </div>
              <p style="color: #94a3b8; font-size: 12px;">※この認証コードの有効期限は5分間です。</p>
            </div>
          `
        });
      }
    } catch (mailErr) {
      console.error("Failed to send admin MFA email:", mailErr);
    }

    return new Response(JSON.stringify({ success: true, tempSessionId, mfaRequired: true }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 4. 管理者MFA検証 & 本格JWT発行
export async function handleVerifyAdminMfa(request: Request, env: Env): Promise<Response> {
  try {
    const isAllowedIp = await checkIpRestriction(request, env);
    if (!isAllowedIp) {
      return new Response(JSON.stringify({ error: "Access denied from this IP address" }), { status: 403, headers });
    }

    const body: any = await request.json();
    const { tempSessionId, code } = body;

    if (!tempSessionId || !code) {
      return new Response(JSON.stringify({ error: "tempSessionId and code are required" }), { status: 400, headers });
    }

    const mfa = await env.DB.prepare(
      "SELECT * FROM saas_admin_mfa_codes WHERE id = ?"
    ).bind(tempSessionId).first<any>();

    if (!mfa) {
      return new Response(JSON.stringify({ error: "Invalid or expired session" }), { status: 400, headers });
    }

    if (new Date().toISOString() > mfa.expires_at) {
      await env.DB.prepare("DELETE FROM saas_admin_mfa_codes WHERE id = ?").bind(tempSessionId).run();
      return new Response(JSON.stringify({ error: "Verification code has expired" }), { status: 400, headers });
    }

    const attempts = (mfa.attempts || 0) + 1;

    if (mfa.code !== code.trim()) {
      if (attempts >= 3) {
        await env.DB.prepare("DELETE FROM saas_admin_mfa_codes WHERE id = ?").bind(tempSessionId).run();
        return new Response(JSON.stringify({ error: "Too many failed attempts. Verification code invalidated. Please login again." }), { status: 400, headers });
      }

      await env.DB.prepare("UPDATE saas_admin_mfa_codes SET attempts = ? WHERE id = ?").bind(attempts, tempSessionId).run();
      return new Response(JSON.stringify({ error: `Invalid verification code. (${3 - attempts} attempts remaining)` }), { status: 400, headers });
    }

    // 検証成功: 一時コードを削除
    await env.DB.prepare("DELETE FROM saas_admin_mfa_codes WHERE id = ?").bind(tempSessionId).run();

    const admin = await env.DB.prepare(
      "SELECT id, email, display_name, role FROM saas_admins WHERE id = ?"
    ).bind(mfa.admin_id).first<any>();

    if (!admin) {
      return new Response(JSON.stringify({ error: "Admin account not found" }), { status: 404, headers });
    }

    // 12時間有効な管理者専用のJWTを発行
    const secret = await getJwtSecret(env);
    const token = await signJWT(
      { adminId: admin.id, role: admin.role, type: "saas_admin", exp: Math.floor(Date.now() / 1000) + 12 * 3600 },
      secret
    );

    logAudit(env, null, admin.id, "admin_login", { email: admin.email, mfa: true }, request).catch(console.error);

    return new Response(JSON.stringify({
      success: true,
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        displayName: admin.display_name,
        role: admin.role
      }
    }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 5. 統計情報の取得
export async function handleGetAdminStats(request: Request, env: Env): Promise<Response> {
  try {
    const isAllowedIp = await checkIpRestriction(request, env);
    if (!isAllowedIp) {
      return new Response(JSON.stringify({ error: "Access denied from this IP address" }), { status: 403, headers });
    }

    const auth = await verifyAdminAuth(request, env);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });
    }

    // 1. 総ユーザー数
    const { results: usersCount } = await env.DB.prepare("SELECT COUNT(*) as count FROM users").all<{ count: number }>();
    const totalUsers = usersCount?.[0]?.count ?? 0;

    // 2. 総ワークスペース数
    const { results: workspacesCount } = await env.DB.prepare("SELECT COUNT(*) as count FROM workspaces").all<{ count: number }>();
    const totalWorkspaces = workspacesCount?.[0]?.count ?? 0;

    // 3. プラン分布
    const { results: planDistribution } = await env.DB.prepare(
      "SELECT plan, COUNT(*) as count FROM workspace_subscriptions GROUP BY plan"
    ).all<{ plan: string; count: number }>();

    // 4. 総ストレージ使用量
    const { results: storageCount } = await env.DB.prepare("SELECT SUM(file_size) as total FROM files").all<{ total: number }>();
    const totalStorage = storageCount?.[0]?.total ?? 0;

    // 5. ワークスペース別の詳細情報
    const { results: workspacesDetails } = await env.DB.prepare(`
      SELECT 
        w.id, 
        w.name, 
        COALESCE(sub.plan, 'free') as plan,
        COALESCE(sub.status, 'active') as status,
        (SELECT COUNT(*) FROM workspace_members wm WHERE wm.workspace_id = w.id) as memberCount,
        (SELECT COUNT(*) FROM channels c WHERE c.workspace_id = w.id AND c.type = 'channel') as channelCount,
        (SELECT COALESCE(SUM(file_size), 0) FROM files f WHERE f.workspace_id = w.id) as storageUsed
      FROM workspaces w
      LEFT JOIN workspace_subscriptions sub ON w.id = sub.workspace_id
      ORDER BY w.created_at DESC
    `).all<any>();

    // 6. ユーザー別の詳細情報および参加ワークスペース情報
    const { results: rawUsers } = await env.DB.prepare(`
      SELECT 
        u.id, 
        u.email, 
        u.display_name as displayName,
        u.avatar_url as avatarUrl,
        COALESCE(u.status, 'active') as status,
        u.created_at as createdAt,
        u.last_active_at as lastActiveAt
      FROM users u
      ORDER BY u.created_at DESC
    `).all<any>();

    const { results: userMemberships } = await env.DB.prepare(`
      SELECT 
        wm.user_id as userId,
        w.id as workspaceId,
        w.name as workspaceName,
        wm.role
      FROM workspace_members wm
      JOIN workspaces w ON wm.workspace_id = w.id
    `).all<any>();

    const membershipMap: Record<string, { id: string; name: string; role: string }[]> = {};
    if (userMemberships) {
      for (const m of userMemberships) {
        if (!membershipMap[m.userId]) {
          membershipMap[m.userId] = [];
        }
        membershipMap[m.userId].push({
          id: m.workspaceId,
          name: m.workspaceName,
          role: m.role
        });
      }
    }

    const usersDetails = (rawUsers || []).map((u: any) => ({
      ...u,
      workspaces: membershipMap[u.id] || []
    }));

    return new Response(JSON.stringify({
      success: true,
      stats: {
        totalUsers,
        totalWorkspaces,
        planDistribution,
        totalStorage,
        workspaces: workspacesDetails,
        users: usersDetails
      }
    }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 6. SaaS管理者設定変更
export async function handleUpdateAdminSettings(request: Request, env: Env): Promise<Response> {
  try {
    const isAllowedIp = await checkIpRestriction(request, env);
    if (!isAllowedIp) {
      return new Response(JSON.stringify({ error: "Access denied from this IP address" }), { status: 403, headers });
    }

    const auth = await verifyAdminAuth(request, env);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });
    }

    const body: any = await request.json();
    const { customPath, allowedIps, displayName, stripeEnabled, stripeSettings, defaultSaasPlan, auditLogRetentionDays } = body;

    const batch = [];

    if (customPath !== undefined) {
      const cleanPath = customPath.trim().replace(/^\/+|\/+$/g, ""); // 先頭末尾のスラッシュを除去
      if (cleanPath.length === 0) {
        return new Response(JSON.stringify({ error: "Custom URL path cannot be empty" }), { status: 400, headers });
      }
      batch.push(env.DB.prepare(
        "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('saas_admin_path', ?, datetime('now'))"
      ).bind(cleanPath));
    }

    if (allowedIps !== undefined) {
      batch.push(env.DB.prepare(
        "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('saas_admin_allowed_ips', ?, datetime('now'))"
      ).bind(allowedIps.trim()));
    }

    if (displayName !== undefined && displayName.trim()) {
      batch.push(env.DB.prepare(
        "UPDATE saas_admins SET display_name = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(displayName.trim(), auth.adminId));
    }

    if (stripeEnabled !== undefined) {
      batch.push(env.DB.prepare(
        "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('stripe_enabled', ?, datetime('now'))"
      ).bind(stripeEnabled ? "1" : "0"));
    }

    if (stripeSettings !== undefined) {
      const currentStripe = await getStripeSettings(env);
      const secretKey = (stripeSettings.secretKey && !stripeSettings.secretKey.includes("••••")) ? stripeSettings.secretKey : (currentStripe?.secretKey || "");
      const publishableKey = stripeSettings.publishableKey || "";
      const webhookSecret = (stripeSettings.webhookSecret && !stripeSettings.webhookSecret.includes("••••")) ? stripeSettings.webhookSecret : (currentStripe?.webhookSecret || "");

      const nextSettings: StripeSettings = {
        enabled: stripeEnabled !== undefined ? stripeEnabled : (currentStripe?.enabled ?? false),
        secretKey,
        publishableKey,
        webhookSecret,
      };

      await saveStripeSettings(env, nextSettings);
    }

    if (defaultSaasPlan !== undefined) {
      batch.push(env.DB.prepare(
        "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('default_saas_plan', ?, datetime('now'))"
      ).bind(defaultSaasPlan));
    }

    if (auditLogRetentionDays !== undefined) {
      batch.push(env.DB.prepare(
        "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES ('saas_audit_log_retention_days', ?, datetime('now'))"
      ).bind(String(auditLogRetentionDays)));
    }

    if (batch.length > 0) {
      await env.DB.batch(batch);
    }

    logAudit(env, null, auth.adminId, "admin_update_settings", { customPath, allowedIps, stripeEnabled, defaultSaasPlan, auditLogRetentionDays }, request).catch(console.error);

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 7. 現在の管理者情報 ＆ 設定値取得
export async function handleGetCurrentAdmin(request: Request, env: Env): Promise<Response> {
  try {
    const isAllowedIp = await checkIpRestriction(request, env);
    
    const auth = await verifyAdminAuth(request, env);
    if (!auth) {
      return new Response(JSON.stringify({ 
        error: "Admin unauthorized",
        clientIp: request.headers.get("CF-Connecting-IP") || "127.0.0.1",
        isAllowedIp 
      }), { status: 401, headers });
    }

    const admin = await env.DB.prepare(
      "SELECT id, email, display_name, role FROM saas_admins WHERE id = ?"
    ).bind(auth.adminId).first<any>();

    if (!admin) {
      return new Response(JSON.stringify({ error: "Admin account not found" }), { status: 404, headers });
    }

    const customPathSetting = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = ?"
    ).bind("saas_admin_path").first<{ value: string }>();

    const allowedIpsSetting = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = ?"
    ).bind("saas_admin_allowed_ips").first<{ value: string }>();

    const defaultSaasPlanSetting = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = ?"
    ).bind("default_saas_plan").first<{ value: string }>();

    const stripeEnabledSetting = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = ?"
    ).bind("stripe_enabled").first<{ value: string }>();

    const auditLogRetentionDaysSetting = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = ?"
    ).bind("saas_audit_log_retention_days").first<{ value: string }>();

    const stripe = await getStripeSettings(env);
    
    const maskKey = (key: string) => {
      if (!key) return "";
      if (key.length <= 8) return "••••••••";
      return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
    };

    const maskedStripeSettings = stripe ? {
      secretKey: maskKey(stripe.secretKey),
      publishableKey: stripe.publishableKey,
      webhookSecret: maskKey(stripe.webhookSecret)
    } : { secretKey: "", publishableKey: "", webhookSecret: "" };

    const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";

    return new Response(JSON.stringify({
      success: true,
      admin: {
        id: admin.id,
        email: admin.email,
        displayName: admin.display_name,
        role: admin.role
      },
      settings: {
        customPath: customPathSetting?.value || "admin",
        allowedIps: allowedIpsSetting?.value || "",
        defaultSaasPlan: defaultSaasPlanSetting?.value || "free",
        stripeEnabled: stripeEnabledSetting?.value === "1",
        stripeSettings: maskedStripeSettings,
        auditLogRetentionDays: auditLogRetentionDaysSetting ? parseInt(auditLogRetentionDaysSetting.value, 10) : 90
      },
      clientIp,
      isAllowedIp
    }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 8. ワークスペースのプランおよびステータスの変更
export async function handleUpdateWorkspaceStatus(request: Request, env: Env): Promise<Response> {
  try {
    const isAllowedIp = await checkIpRestriction(request, env);
    if (!isAllowedIp) {
      return new Response(JSON.stringify({ error: "Access denied from this IP address" }), { status: 403, headers });
    }

    const auth = await verifyAdminAuth(request, env);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });
    }

    const body: any = await request.json();
    const { workspaceId, plan, status, action, planId } = body;

    if (!workspaceId) {
      return new Response(JSON.stringify({ error: "workspaceId is required" }), { status: 400, headers });
    }

    // 現在の設定値を取得
    const currentSub = await env.DB.prepare(
      "SELECT * FROM workspace_subscriptions WHERE workspace_id = ?"
    ).bind(workspaceId).first<any>();

    let derivedStatus = status;
    if (action === 'suspend') {
      derivedStatus = 'suspended';
    } else if (action === 'activate') {
      derivedStatus = 'active';
    }

    const derivedPlan = plan !== undefined ? plan : planId;

    const targetPlan = derivedPlan !== undefined ? derivedPlan : (currentSub?.plan || 'free');
    const targetStatus = derivedStatus !== undefined ? derivedStatus : (currentSub?.status || 'active');

    // saas_plans から対象プランの設定値を取得（定義されている場合）
    const planInfo = await env.DB.prepare(
      "SELECT member_limit, channel_limit, storage_limit FROM saas_plans WHERE id = ?"
    ).bind(targetPlan).first<any>();

    // プランに対応した制限値の自動計算
    const memberLimit = planInfo?.member_limit ?? (targetPlan === 'unlimited' ? 9999 : 5);
    const channelLimit = planInfo?.channel_limit ?? (targetPlan === 'unlimited' ? 9999 : 3);
    const storageLimit = planInfo?.storage_limit ?? (targetPlan === 'unlimited' ? 5368709120 : 52428800); // 5GB or 50MB

    // データベースの更新
    await env.DB.prepare(`
      INSERT INTO workspace_subscriptions (workspace_id, plan, member_limit, channel_limit, storage_limit, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(workspace_id) DO UPDATE SET
        plan = excluded.plan,
        member_limit = excluded.member_limit,
        channel_limit = excluded.channel_limit,
        storage_limit = excluded.storage_limit,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).bind(workspaceId, targetPlan, memberLimit, channelLimit, storageLimit, targetStatus).run();

    console.log(`SaaS Admin: Updated workspace ${workspaceId} to plan: ${targetPlan}, status: ${targetStatus}`);

    logAudit(env, workspaceId, auth.adminId, "admin_workspace_update", { plan: targetPlan, status: targetStatus }, request).catch(console.error);

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 9. 管理者一覧取得
export async function handleGetAdminAccounts(request: Request, env: Env): Promise<Response> {
  try {
    const isAllowedIp = await checkIpRestriction(request, env);
    if (!isAllowedIp) {
      return new Response(JSON.stringify({ error: "Access denied from this IP address" }), { status: 403, headers });
    }

    const auth = await verifyAdminAuth(request, env);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });
    }

    const { results: admins } = await env.DB.prepare(
      "SELECT id, email, display_name as displayName, role, created_at as createdAt, updated_at as updatedAt FROM saas_admins ORDER BY created_at ASC"
    ).all<any>();

    return new Response(JSON.stringify({ success: true, accounts: admins || [] }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 10. 副管理者追加
export async function handleCreateAdminAccount(request: Request, env: Env): Promise<Response> {
  try {
    const isAllowedIp = await checkIpRestriction(request, env);
    if (!isAllowedIp) {
      return new Response(JSON.stringify({ error: "Access denied from this IP address" }), { status: 403, headers });
    }

    const auth = await verifyAdminAuth(request, env);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });
    }

    const body: any = await request.json();
    const { email, password, displayName } = body;

    if (!email || !password || !displayName) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400, headers });
    }

    // 重複チェック
    const existing = await env.DB.prepare(
      "SELECT id FROM saas_admins WHERE email = ?"
    ).bind(email.trim()).first<any>();

    if (existing) {
      return new Response(JSON.stringify({ error: "Email already registered as admin" }), { status: 400, headers });
    }

    const passwordHash = await hashPassword(password);
    const adminId = crypto.randomUUID();

    try {
      await env.DB.prepare(
        "INSERT INTO saas_admins (id, email, password_hash, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, 'admin', datetime('now'), datetime('now'))"
      ).bind(adminId, email.trim(), passwordHash, displayName.trim()).run();
    } catch (dbErr: any) {
      if (dbErr?.message?.includes("updated_at")) {
        await env.DB.prepare("ALTER TABLE saas_admins ADD COLUMN updated_at TEXT").run().catch(() => {});
        await env.DB.prepare(
          "INSERT INTO saas_admins (id, email, password_hash, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, 'admin', datetime('now'), datetime('now'))"
        ).bind(adminId, email.trim(), passwordHash, displayName.trim()).run();
      } else {
        throw dbErr;
      }
    }

    logAudit(env, null, auth.adminId, "admin_create", { targetAdminId: adminId, email: email.trim(), displayName: displayName.trim() }, request).catch(console.error);

    return new Response(JSON.stringify({
      success: true,
      account: {
        id: adminId,
        email: email.trim(),
        displayName: displayName.trim(),
        role: "admin"
      }
    }), { status: 201, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 11. 管理者削除
export async function handleDeleteAdminAccount(request: Request, env: Env): Promise<Response> {
  try {
    const isAllowedIp = await checkIpRestriction(request, env);
    if (!isAllowedIp) {
      return new Response(JSON.stringify({ error: "Access denied from this IP address" }), { status: 403, headers });
    }

    const auth = await verifyAdminAuth(request, env);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });
    }

    const body: any = await request.json();
    const { id } = body;

    if (!id) {
      return new Response(JSON.stringify({ error: "Admin ID is required" }), { status: 400, headers });
    }

    // 自分自身は削除できない
    if (id === auth.adminId) {
      return new Response(JSON.stringify({ error: "You cannot delete your own account" }), { status: 400, headers });
    }

    // 削除対象のロールを確認
    const target = await env.DB.prepare(
      "SELECT role FROM saas_admins WHERE id = ?"
    ).bind(id).first<any>();

    if (!target) {
      return new Response(JSON.stringify({ error: "Admin account not found" }), { status: 404, headers });
    }

    if (target.role === "owner") {
      return new Response(JSON.stringify({ error: "You cannot delete the owner account" }), { status: 400, headers });
    }

    await env.DB.prepare(
      "DELETE FROM saas_admins WHERE id = ?"
    ).bind(id).run();

    logAudit(env, null, auth.adminId, "admin_delete", { targetAdminId: id }, request).catch(console.error);

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 12. プロフィール更新 (自分自身)
export async function handleUpdateMeAdmin(request: Request, env: Env): Promise<Response> {
  try {
    const isAllowedIp = await checkIpRestriction(request, env);
    if (!isAllowedIp) {
      return new Response(JSON.stringify({ error: "Access denied from this IP address" }), { status: 403, headers });
    }

    const auth = await verifyAdminAuth(request, env);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });
    }

    const body: any = await request.json();
    const { email, displayName, password } = body;

    const updates: string[] = [];
    const params: any[] = [];

    if (email !== undefined && email.trim()) {
      const cleanEmail = email.trim();
      // 他のユーザーがそのアドレスを使っていないか
      const existing = await env.DB.prepare(
        "SELECT id FROM saas_admins WHERE email = ? AND id != ?"
      ).bind(cleanEmail, auth.adminId).first<any>();

      if (existing) {
        return new Response(JSON.stringify({ error: "Email already registered by another admin" }), { status: 400, headers });
      }

      updates.push("email = ?");
      params.push(cleanEmail);
    }

    if (displayName !== undefined && displayName.trim()) {
      updates.push("display_name = ?");
      params.push(displayName.trim());
    }

    if (password !== undefined && password) {
      const passwordHash = await hashPassword(password);
      updates.push("password_hash = ?");
      params.push(passwordHash);
    }

    if (updates.length === 0) {
      return new Response(JSON.stringify({ error: "No fields to update" }), { status: 400, headers });
    }

    updates.push("updated_at = datetime('now')");
    params.push(auth.adminId); // WHERE句バインド用

    const sql = `UPDATE saas_admins SET ${updates.join(", ")} WHERE id = ?`;
    await env.DB.prepare(sql).bind(...params).run();

    // 更新後のプロフィールを再取得して返す
    const updated = await env.DB.prepare(
      "SELECT id, email, display_name as displayName, role FROM saas_admins WHERE id = ?"
    ).bind(auth.adminId).first<any>();

    logAudit(env, null, auth.adminId, "admin_update_profile", { email: email?.trim(), displayName: displayName?.trim() }, request).catch(console.error);

    return new Response(JSON.stringify({ success: true, admin: updated }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 13. オーナー権限移譲
export async function handleTransferOwnership(request: Request, env: Env): Promise<Response> {
  try {
    const isAllowedIp = await checkIpRestriction(request, env);
    if (!isAllowedIp) {
      return new Response(JSON.stringify({ error: "Access denied from this IP address" }), { status: 403, headers });
    }

    const auth = await verifyAdminAuth(request, env);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });
    }

    // ログイン中のユーザーがownerであることを確認
    const currentAdmin = await env.DB.prepare(
      "SELECT role FROM saas_admins WHERE id = ?"
    ).bind(auth.adminId).first<any>();

    if (!currentAdmin || currentAdmin.role !== "owner") {
      return new Response(JSON.stringify({ error: "Only the owner can transfer ownership" }), { status: 403, headers });
    }

    const body: any = await request.json();
    const { targetAdminId } = body;

    if (!targetAdminId) {
      return new Response(JSON.stringify({ error: "Target admin ID is required" }), { status: 400, headers });
    }

    if (targetAdminId === auth.adminId) {
      return new Response(JSON.stringify({ error: "Cannot transfer ownership to yourself" }), { status: 400, headers });
    }

    // 移譲対象のユーザーが存在し、かつadminロールであることを確認
    const targetAdmin = await env.DB.prepare(
      "SELECT role FROM saas_admins WHERE id = ?"
    ).bind(targetAdminId).first<any>();

    if (!targetAdmin) {
      return new Response(JSON.stringify({ error: "Target admin account not found" }), { status: 404, headers });
    }

    if (targetAdmin.role !== "admin") {
      return new Response(JSON.stringify({ error: "Target admin must have 'admin' role to become owner" }), { status: 400, headers });
    }

    // トランザクション処理（バッチ処理）で互いのロールを変更
    await env.DB.batch([
      env.DB.prepare("UPDATE saas_admins SET role = 'admin', updated_at = datetime('now') WHERE id = ?").bind(auth.adminId),
      env.DB.prepare("UPDATE saas_admins SET role = 'owner', updated_at = datetime('now') WHERE id = ?").bind(targetAdminId)
    ]);

    logAudit(env, null, auth.adminId, "admin_transfer_ownership", { targetAdminId }, request).catch(console.error);

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 14. 管理者アカウントの更新 (他人の変更 [ownerのみ] または自分自身)
export async function handleUpdateAdminAccount(request: Request, env: Env): Promise<Response> {
  try {
    const isAllowedIp = await checkIpRestriction(request, env);
    if (!isAllowedIp) {
      return new Response(JSON.stringify({ error: "Access denied from this IP address" }), { status: 403, headers });
    }

    const auth = await verifyAdminAuth(request, env);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });
    }

    const body: any = await request.json();
    const { id, email, displayName, password } = body;

    if (!id) {
      return new Response(JSON.stringify({ error: "Admin ID is required" }), { status: 400, headers });
    }

    // 権限チェック: 操作者がオーナーであるか、更新対象が自分自身であること
    if (auth.role !== "owner" && auth.adminId !== id) {
      return new Response(JSON.stringify({ error: "Permission denied. Only owners can modify other admins." }), { status: 403, headers });
    }

    // 更新対象の現在のロールを確認
    const targetAdmin = await env.DB.prepare(
      "SELECT role FROM saas_admins WHERE id = ?"
    ).bind(id).first<any>();

    if (!targetAdmin) {
      return new Response(JSON.stringify({ error: "Admin account not found" }), { status: 404, headers });
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (email !== undefined && email.trim()) {
      const cleanEmail = email.trim();
      // 他のユーザーがそのアドレスを使っていないか
      const existing = await env.DB.prepare(
        "SELECT id FROM saas_admins WHERE email = ? AND id != ?"
      ).bind(cleanEmail, id).first<any>();

      if (existing) {
        return new Response(JSON.stringify({ error: "Email already registered by another admin" }), { status: 400, headers });
      }

      updates.push("email = ?");
      params.push(cleanEmail);
    }

    if (displayName !== undefined && displayName.trim()) {
      updates.push("display_name = ?");
      params.push(displayName.trim());
    }

    if (password !== undefined && password) {
      const passwordHash = await hashPassword(password);
      updates.push("password_hash = ?");
      params.push(passwordHash);
    }

    if (updates.length === 0) {
      return new Response(JSON.stringify({ error: "No fields to update" }), { status: 400, headers });
    }

    updates.push("updated_at = datetime('now')");
    params.push(id); // WHERE句バインド用

    const sql = `UPDATE saas_admins SET ${updates.join(", ")} WHERE id = ?`;
    await env.DB.prepare(sql).bind(...params).run();

    logAudit(env, null, auth.adminId, "admin_update_account", { targetAdminId: id, email: email?.trim(), displayName: displayName?.trim() }, request).catch(console.error);

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 20. ユーザーステータス（BAN・一時停止 / 利用再開）変更
export async function handleUpdateUserStatus(request: Request, env: Env): Promise<Response> {
  try {
    const isAllowedIp = await checkIpRestriction(request, env);
    if (!isAllowedIp) {
      return new Response(JSON.stringify({ error: "Access denied from this IP address" }), { status: 403, headers });
    }

    const auth = await verifyAdminAuth(request, env);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });
    }

    const body: any = await request.json();
    const { userId, action } = body;

    if (!userId || !action) {
      return new Response(JSON.stringify({ error: "Missing required parameters: userId, action" }), { status: 400, headers });
    }

    const targetUser = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
    if (!targetUser) {
      return new Response(JSON.stringify({ error: "Target user not found" }), { status: 404, headers });
    }

    if (action === "suspend") {
      await env.DB.prepare(
        "UPDATE users SET status = 'suspended', tokens_valid_after = datetime('now'), updated_at = datetime('now') WHERE id = ?"
      ).bind(userId).run();

      await logAudit(env, null, auth.adminId, "user_suspend", `User ID ${userId} suspended (BAN)`, request).catch(console.error);

      return new Response(JSON.stringify({ success: true, message: "User account suspended successfully." }), { status: 200, headers });
    } else if (action === "activate") {
      await env.DB.prepare(
        "UPDATE users SET status = 'active', updated_at = datetime('now') WHERE id = ?"
      ).bind(userId).run();

      await logAudit(env, null, auth.adminId, "user_activate", `User ID ${userId} activated`, request).catch(console.error);

      return new Response(JSON.stringify({ success: true, message: "User account activated successfully." }), { status: 200, headers });
    } else {
      return new Response(JSON.stringify({ error: "Invalid action type. Expected 'suspend' or 'activate'" }), { status: 400, headers });
    }
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 21. 公開用アクティブアナウンス取得（掲載期間内のもののみ）
export async function handleGetActiveAnnouncements(request: Request, env: Env): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(`
      SELECT 
        id, 
        title, 
        content, 
        type, 
        start_at as startAt, 
        end_at as endAt, 
        created_at as createdAt 
      FROM global_announcements 
      WHERE is_active = 1 
        AND (start_at IS NULL OR start_at <= datetime('now')) 
        AND (end_at IS NULL OR end_at >= datetime('now')) 
      ORDER BY created_at DESC
    `).all();

    return new Response(JSON.stringify({ success: true, announcements: results || [] }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 22. 管理者用アナウンス一覧取得
export async function handleGetAdminAnnouncements(request: Request, env: Env): Promise<Response> {
  try {
    const auth = await verifyAdminAuth(request, env);
    if (!auth) return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });

    const { results } = await env.DB.prepare(`
      SELECT 
        id, 
        title, 
        content, 
        type, 
        is_active as isActive, 
        start_at as startAt, 
        end_at as endAt, 
        created_at as createdAt, 
        updated_at as updatedAt 
      FROM global_announcements 
      ORDER BY created_at DESC
    `).all();

    return new Response(JSON.stringify({ success: true, announcements: results || [] }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 23. 管理者用アナウンス作成（掲載期間設定 & スポンサー制限対応）
export async function handleCreateAdminAnnouncement(request: Request, env: Env): Promise<Response> {
  try {
    const auth = await verifyAdminAuth(request, env);
    if (!auth) return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });

    const body: any = await request.json();
    const { title, content, type, startAt, endAt, start_at, end_at, isActive, is_active } = body;
    const activeState = (isActive !== undefined ? isActive : is_active !== undefined ? is_active : true) ? 1 : 0;

    if (!title) {
      return new Response(JSON.stringify({ error: "Title is required" }), { status: 400, headers });
    }

    const id = crypto.randomUUID();
    const announcementType = type || "info";
    const announcementContent = content || "";
    
    const parseDateTime = (val: any) => {
      if (!val) return null;
      try {
        const d = new Date(val);
        return isNaN(d.getTime()) ? null : d.toISOString();
      } catch {
        return null;
      }
    };

    const startTime = parseDateTime(startAt || start_at);
    const endTime = parseDateTime(endAt || end_at);
    const now = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO global_announcements (id, title, content, type, is_active, start_at, end_at, created_at, updated_at) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, title, announcementContent, announcementType, activeState, startTime, endTime, now, now).run();

    logAudit(env, null, auth.adminId, "announcement_create", { id, title, type: announcementType, isActive: activeState, startAt: startTime, endAt: endTime }, request).catch(console.error);

    return new Response(JSON.stringify({ success: true, id, startAt: startTime, endAt: endTime }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 24. 管理者用アナウンス削除
export async function handleDeleteAdminAnnouncement(request: Request, env: Env, announcementId: string): Promise<Response> {
  try {
    const auth = await verifyAdminAuth(request, env);
    if (!auth) return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });

    await env.DB.prepare("DELETE FROM global_announcements WHERE id = ?").bind(announcementId).run();

    logAudit(env, null, auth.adminId, "announcement_delete", { id: announcementId }, request).catch(console.error);

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 25. 管理者用アナウンス有効/無効切替
export async function handleToggleAdminAnnouncement(request: Request, env: Env, announcementId: string): Promise<Response> {
  try {
    const auth = await verifyAdminAuth(request, env);
    if (!auth) return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });

    const current = await env.DB.prepare("SELECT is_active FROM global_announcements WHERE id = ?").bind(announcementId).first<{ is_active: number }>();
    if (!current) return new Response(JSON.stringify({ error: "Announcement not found" }), { status: 404, headers });

    const newStatus = current.is_active === 1 ? 0 : 1;
    await env.DB.prepare("UPDATE global_announcements SET is_active = ?, updated_at = datetime('now') WHERE id = ?").bind(newStatus, announcementId).run();

    logAudit(env, null, auth.adminId, "announcement_toggle", { id: announcementId, is_active: newStatus }, request).catch(console.error);

    return new Response(JSON.stringify({ success: true, is_active: newStatus }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 26. 管理者用アナウンス編集・更新
export async function handleUpdateAdminAnnouncement(request: Request, env: Env, announcementId: string): Promise<Response> {
  try {
    const auth = await verifyAdminAuth(request, env);
    if (!auth) return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });

    const current = await env.DB.prepare("SELECT id, is_active FROM global_announcements WHERE id = ?").bind(announcementId).first<{ id: string; is_active: number }>();
    if (!current) return new Response(JSON.stringify({ error: "Announcement not found" }), { status: 404, headers });

    const body: any = await request.json();
    const { title, content, type, startAt, endAt, start_at, end_at, isActive, is_active } = body;

    if (!title) {
      return new Response(JSON.stringify({ error: "Title is required" }), { status: 400, headers });
    }

    const activeState = (isActive !== undefined ? isActive : is_active !== undefined ? is_active : current.is_active === 1) ? 1 : 0;

    const parseDateTime = (val: any) => {
      if (!val) return null;
      try {
        const d = new Date(val);
        return isNaN(d.getTime()) ? null : d.toISOString();
      } catch {
        return null;
      }
    };

    const announcementType = type || "info";
    const announcementContent = content || "";
    const startTime = parseDateTime(startAt || start_at);
    const endTime = parseDateTime(endAt || end_at);
    const now = new Date().toISOString();

    await env.DB.prepare(`
      UPDATE global_announcements 
      SET title = ?, content = ?, type = ?, is_active = ?, start_at = ?, end_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(title, announcementContent, announcementType, activeState, startTime, endTime, now, announcementId).run();

    logAudit(env, null, auth.adminId, "announcement_update", { id: announcementId, title, type: announcementType, isActive: activeState, startAt: startTime, endAt: endTime }, request).catch(console.error);

    return new Response(JSON.stringify({ success: true, id: announcementId, isActive: activeState, startAt: startTime, endAt: endTime }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 26. ワークスペースのD1 / R2 関連データ一括パージ（完全削除）
export async function handlePurgeWorkspaceData(request: Request, env: Env, workspaceId: string): Promise<Response> {
  try {
    const auth = await verifyAdminAuth(request, env);
    if (!auth) return new Response(JSON.stringify({ error: "Admin unauthorized" }), { status: 401, headers });

    const workspace = await env.DB.prepare("SELECT id, name FROM workspaces WHERE id = ?").bind(workspaceId).first();
    if (!workspace) return new Response(JSON.stringify({ error: "Workspace not found" }), { status: 404, headers });

    // 1. R2 ストレージ内の全関連ファイルを削除 (Prefix一括削除 & DBキー個別削除の両対応)
    try {
      const storage = (env as any).STORAGE || (env as any).R2 || (env as any).BUCKET;
      if (storage) {
        // A. プレフィックス workspaces/{workspaceId}/ 以下の全オブジェクトを一括削除
        const prefix = `workspaces/${workspaceId}/`;
        const listed = await storage.list({ prefix }).catch(() => null);
        if (listed && listed.objects) {
          for (const obj of listed.objects) {
            await storage.delete(obj.key).catch(() => {});
          }
        }

        // B. 旧形式で保存されていた DBの object_key レコードも念のため個別削除
        const { results: fileRecords } = await env.DB.prepare(
          "SELECT object_key FROM files WHERE workspace_id = ?"
        ).bind(workspaceId).all<{ object_key: string }>();

        if (fileRecords && fileRecords.length > 0) {
          for (const fileRec of fileRecords) {
            if (fileRec.object_key) {
              await storage.delete(fileRec.object_key).catch(() => {});
            }
          }
        }
      }
    } catch (r2Err) {
      console.warn("Failed to delete R2 files during workspace purge:", r2Err);
    }

    // 2. D1 関連レコードの完全削除
    await env.DB.batch([
      env.DB.prepare("DELETE FROM files WHERE workspace_id = ?").bind(workspaceId),
      env.DB.prepare("DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE workspace_id = ?)").bind(workspaceId),
      env.DB.prepare("DELETE FROM channel_members WHERE channel_id IN (SELECT id FROM channels WHERE workspace_id = ?)").bind(workspaceId),
      env.DB.prepare("DELETE FROM channels WHERE workspace_id = ?").bind(workspaceId),
      env.DB.prepare("DELETE FROM items WHERE workspace_id = ?").bind(workspaceId),
      env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ?").bind(workspaceId),
      env.DB.prepare("DELETE FROM workspace_subscriptions WHERE workspace_id = ?").bind(workspaceId),
      env.DB.prepare("DELETE FROM workspace_brandings WHERE workspace_id = ?").bind(workspaceId),
      env.DB.prepare("DELETE FROM audit_logs WHERE workspace_id = ?").bind(workspaceId),
      env.DB.prepare("DELETE FROM workspaces WHERE id = ?").bind(workspaceId)
    ]);

    logAudit(env, workspaceId, auth.adminId, "workspace_purge_all", { workspaceId, name: (workspace as any).name }, request).catch(console.error);

    return new Response(JSON.stringify({ success: true, message: `Workspace '${(workspace as any).name}' and all associated D1/R2 data have been permanently deleted.` }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 27. ワークスペースブランディングの取得
export async function handleGetWorkspaceBranding(request: Request, env: Env, workspaceId: string): Promise<Response> {
  try {
    const branding = await env.DB.prepare(
      "SELECT * FROM workspace_brandings WHERE workspace_id = ?"
    ).bind(workspaceId).first();

    return new Response(JSON.stringify({ success: true, branding: branding || null }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// 28. ワークスペースブランディングの更新
export async function handleUpdateWorkspaceBranding(request: Request, env: Env, workspaceId: string): Promise<Response> {
  try {
    const body: any = await request.json();
    const { custom_logo_url, primary_color, brand_name } = body;

    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO workspace_brandings (workspace_id, custom_logo_url, primary_color, brand_name, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        custom_logo_url = excluded.custom_logo_url,
        primary_color = excluded.primary_color,
        brand_name = excluded.brand_name,
        updated_at = excluded.updated_at
    `).bind(workspaceId, custom_logo_url || "", primary_color || "", brand_name || "", now).run();

    return new Response(JSON.stringify({ success: true }), { status: 200, headers });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { status: 500, headers });
  }
}

