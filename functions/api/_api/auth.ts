import type { Env } from "../[[route]]";
import { verifyPassword, hashPassword, generateRecoveryCode } from "./setup";
import { signJWT, verifyJWT, getJwtSecret, serializeCookie, parseCookies, getCookieOptions } from "../_utils/jwt";
import { sendMail, getSmtpSettings } from "../_utils/smtp";
import { logAudit } from "../_utils/audit";

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id",
  };

  try {
    const body: any = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return new Response(JSON.stringify({ error: "Email and password are required" }), {
        status: 400,
        headers,
      });
    }

    // 1. IPアドレスベースのレート制限 (第一関門)
    const ip = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: `login-ip-${ip}` });
      if (!success) {
        return new Response(JSON.stringify({ error: "ログイン試行回数が多すぎます。しばらく時間をおいてから再度お試しください。" }), {
          status: 429,
          headers,
        });
      }
    }

    // 2. アカウント単位のロック状態チェック (第二関門)
    const attempt = await env.DB.prepare(
      "SELECT attempts, lockout_until FROM login_attempts WHERE email = ?"
    ).bind(email).first<{ attempts: number; lockout_until: string | null }>();

    if (attempt && attempt.lockout_until) {
      const lockoutTime = new Date(attempt.lockout_until).getTime();
      if (lockoutTime > Date.now()) {
        const waitMinutes = Math.ceil((lockoutTime - Date.now()) / (1000 * 60));
        return new Response(JSON.stringify({ 
          error: `セキュリティのためアカウントが一時的にロックされています。解除まであと ${waitMinutes} 分お待ちください。` 
        }), {
          status: 423,
          headers,
        });
      }
    }

    // ログイン失敗時の回数カウント＆ロック処理ヘルパー
    const handleLoginFailure = async () => {
      let maxAttempts = 5;
      try {
        const maxAttemptsSetting = await env.DB.prepare(
          "SELECT value FROM system_settings WHERE key = ?"
        ).bind("user_login_max_attempts").first<{ value: string }>();
        if (maxAttemptsSetting?.value) {
          maxAttempts = parseInt(maxAttemptsSetting.value, 10);
        }
      } catch (err) {
        console.error("Failed to load user_login_max_attempts setting:", err);
      }
      
      const lockoutMinutes = 15;
      const now = new Date();

      if (!attempt) {
        await env.DB.prepare(
          "INSERT INTO login_attempts (email, attempts, updated_at) VALUES (?, 1, datetime('now'))"
        ).bind(email).run().catch(console.error);
      } else {
        const nextAttempts = attempt.attempts + 1;
        if (nextAttempts >= maxAttempts) {
          const lockoutUntil = new Date(now.getTime() + lockoutMinutes * 60 * 1000).toISOString();
          await env.DB.prepare(
            "UPDATE login_attempts SET attempts = ?, lockout_until = ?, updated_at = datetime('now') WHERE email = ?"
          ).bind(nextAttempts, lockoutUntil, email).run().catch(console.error);
        } else {
          await env.DB.prepare(
            "UPDATE login_attempts SET attempts = ?, updated_at = datetime('now') WHERE email = ?"
          ).bind(nextAttempts, email).run().catch(console.error);
        }
      }
    };

    const userResult = await env.DB.prepare(
      "SELECT * FROM users WHERE email = ?"
    ).bind(email).first<{
      id: string;
      email: string;
      password_hash: string;
      display_name: string;
      language?: string;
      status?: string;
    }>();

    if (!userResult) {
      await handleLoginFailure();
      return new Response(JSON.stringify({ error: "Invalid email or password" }), {
        status: 401,
        headers,
      });
    }

    if (userResult.status === 'suspended') {
      return new Response(JSON.stringify({ error: "このアカウントは一時停止（BAN）されています。システム管理者にお問い合わせください。" }), {
        status: 403,
        headers,
      });
    }

    const isPasswordValid = await verifyPassword(password, userResult.password_hash);
    if (!isPasswordValid) {
      await handleLoginFailure();
      return new Response(JSON.stringify({ error: "Invalid email or password" }), {
        status: 401,
        headers,
      });
    }

    // ログイン成功時は、ログイン試行のカウントをクリア
    await env.DB.prepare("DELETE FROM login_attempts WHERE email = ?").bind(email).run().catch(console.error);

    if (userResult.status === 'pending') {
      await env.DB.prepare(
        "UPDATE users SET status = 'active', updated_at = datetime('now') WHERE id = ?"
      ).bind(userResult.id).run();
      userResult.status = 'active';
    }

    const memberResult = await env.DB.prepare(
      `SELECT wm.workspace_id, w.name as workspace_name 
       FROM workspace_members wm 
       JOIN workspaces w ON wm.workspace_id = w.id 
       WHERE wm.user_id = ? 
       LIMIT 1`
    ).bind(userResult.id).first<{ workspace_id: string; workspace_name: string }>();

    let workspaceId = memberResult?.workspace_id || "";
    let workspaceName = memberResult?.workspace_name || "";
    let defaultChannelId = "";

    if (workspaceId) {
      const channelResult = await env.DB.prepare(
        "SELECT id FROM channels WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1"
      ).bind(workspaceId).first<{ id: string }>();
      defaultChannelId = channelResult?.id || "";
    }

    const smtpSettings = await getSmtpSettings(env);
    const mfaRequired = smtpSettings && smtpSettings.mfaEnabled;

    if (mfaRequired) {
      const otpArray = new Uint32Array(1);
      crypto.getRandomValues(otpArray);
      const otpCode = (100000 + (otpArray[0] % 900000)).toString();
      const mfaSessionId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      await env.DB.prepare(
        "INSERT INTO login_verification_codes (id, user_id, code, expires_at, attempts) VALUES (?, ?, ?, ?, 0)"
      ).bind(mfaSessionId, userResult.id, otpCode, expiresAt).run();

      try {
        await sendMail(smtpSettings, {
          to: userResult.email,
          subject: "【CoHive】2段階認証コード",
          text: `こんにちは、${userResult.display_name}さん。\n\nCoHiveへのログインリクエストがありました。\n以下の認証コードを入力してログインを完了してください。\n\n認証コード: ${otpCode}\n有効期限: 5分\n\nもしこのログインに心当たりがない場合は、速やかにパスワードの変更をお願いします。`,
          html: `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eaeaea; border-radius: 5px; max-width: 600px; margin: 0 auto; color: #333;">
              <h2 style="color: #4f46e5; margin-top: 0; font-size: 18px; border-bottom: 2px solid #4f46e5; padding-bottom: 8px;">CoHive 2段階認証</h2>
              <p>こんにちは、<strong>${userResult.display_name}</strong> さん。</p>
              <p>CoHiveへのログイン要求がありました。以下の認証コードを入力してログイン手続きを完了させてください。</p>
              <div style="background: #f9fafb; padding: 15px; margin: 20px 0; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 4px; color: #4f46e5; border: 1px dashed #4f46e5; border-radius: 4px;">
                ${otpCode}
              </div>
              <p style="color: #ef4444; font-size: 13px;">※有効期限は5分間です。</p>
            </div>
          `
        });
      } catch (mailErr) {
        console.error("Failed to send MFA verification email:", mailErr);
        return new Response(JSON.stringify({ error: "Failed to send MFA verification email. Please try again." }), {
          status: 500,
          headers,
        });
      }

      return new Response(JSON.stringify({
        success: true,
        data: {
          mfaRequired: true,
          tempSessionId: mfaSessionId,
        }
      }), {
        status: 200,
        headers,
      });
    }

    const secret = await getJwtSecret(env);
    const accessToken = await signJWT(
      { userId: userResult.id, type: "access", exp: Math.floor(Date.now() / 1000) + 900 },
      secret
    );
    const refreshToken = await signJWT(
      { userId: userResult.id, type: "refresh", exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 },
      secret
    );

    const cookieValue = serializeCookie(
      "refresh_token",
      refreshToken,
      getCookieOptions(request, env, 30 * 24 * 3600)
    );

    const responseHeaders = new Headers(headers);
    responseHeaders.append("Set-Cookie", cookieValue);

    logAudit(env, workspaceId || null, userResult.id, "user_login", { email: userResult.email, method: "password" }, request).catch(console.error);
    sendLoginAlertMail(request, env, userResult.email, userResult.display_name).catch(console.error);

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: userResult.id,
        displayName: userResult.display_name,
        email: userResult.email,
        avatarUrl: (userResult as any).avatar_url || null,
        workspaceId,
        workspaceName,
        defaultChannelId,
        token: accessToken,
        language: userResult.language || 'ja',
      }
    }), {
      status: 200,
      headers: responseHeaders,
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

export async function handleChangePassword(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const customHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-User-Id",
  };

  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers: customHeaders,
      });
    }

    const body: any = await request.json();
    const { currentPassword, newPassword } = body;

    if (!currentPassword || !newPassword) {
      return new Response(JSON.stringify({ error: "Current password and new password are required" }), {
        status: 400,
        headers: customHeaders,
      });
    }

    const hasUpperCase = /[A-Z]/.test(newPassword);
    const hasLowerCase = /[a-z]/.test(newPassword);
    const hasNumbers = /\d/.test(newPassword);
    const hasNonalphas = /[^A-Za-z0-9]/.test(newPassword);

    if (newPassword.length < 8 || !(hasUpperCase && hasLowerCase && hasNumbers && hasNonalphas)) {
      return new Response(JSON.stringify({ error: "New password must be at least 8 characters long and contain uppercase, lowercase, numbers, and symbols." }), {
        status: 400,
        headers: customHeaders,
      });
    }

    if (userId === "demo-user-id") {
      return new Response(JSON.stringify({ error: "Demo user password cannot be changed" }), {
        status: 400,
        headers: customHeaders,
      });
    }

    const user = await env.DB.prepare(
      "SELECT password_hash FROM users WHERE id = ?"
    ).bind(userId).first<{ password_hash: string }>();

    if (!user) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: customHeaders,
      });
    }

    const isPasswordValid = await verifyPassword(currentPassword, user.password_hash);
    if (!isPasswordValid) {
      return new Response(JSON.stringify({ error: "Incorrect current password" }), {
        status: 400,
        headers: customHeaders,
      });
    }

    const newHash = await hashPassword(newPassword);
    await env.DB.prepare(
      "UPDATE users SET password_hash = ?, tokens_valid_after = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).bind(newHash, userId).run();

    return new Response(JSON.stringify({ success: true, message: "Password updated successfully" }), {
      status: 200,
      headers: customHeaders,
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers: customHeaders,
    });
  }
}

export async function handleRefresh(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    const secret = await getJwtSecret(env);
    const cookies = parseCookies(request);
    const refreshToken = cookies.refresh_token;

    if (!refreshToken) {
      return new Response(JSON.stringify({ error: "Refresh token missing" }), {
        status: 401,
        headers,
      });
    }

    const payload = await verifyJWT(refreshToken, secret);
    if (!payload || payload.type !== "refresh" || !payload.userId) {
      return new Response(JSON.stringify({ error: "Invalid or expired refresh token" }), {
        status: 401,
        headers,
      });
    }

    const userId = payload.userId;

    const userRevoke = await env.DB.prepare(
      "SELECT tokens_valid_after FROM users WHERE id = ?"
    ).bind(userId).first<{ tokens_valid_after: string | null }>();

    if (userRevoke && userRevoke.tokens_valid_after) {
      const validAfterSec = Math.floor(new Date(userRevoke.tokens_valid_after).getTime() / 1000);
      if (payload.iat && payload.iat < validAfterSec) {
        return new Response(JSON.stringify({ error: "Session has been revoked" }), {
          status: 401,
          headers,
        });
      }
    }

    const userResult = await env.DB.prepare(
      "SELECT id, email, display_name, avatar_url as avatarUrl, language FROM users WHERE id = ?"
    ).bind(userId).first<any>();

    if (!userResult) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 401,
        headers,
      });
    }

    let workspaceId = "";
    let workspaceName = "";
    let defaultChannelId = "";

    const memberResult = await env.DB.prepare(
      `SELECT wm.workspace_id, w.name as workspace_name 
       FROM workspace_members wm 
       JOIN workspaces w ON wm.workspace_id = w.id 
       WHERE wm.user_id = ? 
       LIMIT 1`
    ).bind(userId).first<{ workspace_id: string; workspace_name: string }>();

    if (memberResult) {
      workspaceId = memberResult.workspace_id;
      workspaceName = memberResult.workspace_name;
      const channelResult = await env.DB.prepare(
        "SELECT id FROM channels WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1"
      ).bind(workspaceId).first<{ id: string }>();
      defaultChannelId = channelResult?.id || "";
    }

    const accessToken = await signJWT(
      { userId, type: "access", exp: Math.floor(Date.now() / 1000) + 900 },
      secret
    );

    const newRefreshToken = await signJWT(
      { userId, type: "refresh", exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 },
      secret
    );

    const cookieValue = serializeCookie(
      "refresh_token",
      newRefreshToken,
      getCookieOptions(request, env, 30 * 24 * 3600)
    );

    const responseHeaders = new Headers(headers);
    responseHeaders.append("Set-Cookie", cookieValue);

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: userResult.id,
        displayName: userResult.display_name,
        email: userResult.email,
        avatarUrl: userResult.avatarUrl || null,
        workspaceId,
        workspaceName,
        defaultChannelId,
        token: accessToken,
        language: userResult.language || 'ja',
      }
    }), {
      status: 200,
      headers: responseHeaders,
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const cookieValue = serializeCookie(
    "refresh_token",
    "",
    getCookieOptions(request, env, 0)
  );

  const responseHeaders = new Headers(headers);
  responseHeaders.append("Set-Cookie", cookieValue);

  return new Response(JSON.stringify({ success: true, message: "Logged out successfully" }), {
    status: 200,
    headers: responseHeaders,
  });
}

export async function handleVerifyMfa(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    const body: any = await request.json();
    const { tempSessionId, code } = body;

    if (!tempSessionId || !code) {
      return new Response(JSON.stringify({ error: "tempSessionId and code are required" }), {
        status: 400,
        headers,
      });
    }

    const record = await env.DB.prepare(
      "SELECT * FROM login_verification_codes WHERE id = ?"
    ).bind(tempSessionId).first<{ id: string; user_id: string; code: string; expires_at: string; attempts?: number }>();

    if (!record) {
      return new Response(JSON.stringify({ error: "Invalid temporary session ID" }), {
        status: 400,
        headers,
      });
    }

    const attempts = (record.attempts || 0) + 1;

    if (record.code !== code.trim()) {
      if (attempts >= 5) {
        await env.DB.prepare("DELETE FROM login_verification_codes WHERE id = ?").bind(tempSessionId).run();
        return new Response(JSON.stringify({ error: "Too many failed attempts. Verification code invalidated. Please login again." }), {
          status: 400,
          headers,
        });
      }

      await env.DB.prepare("UPDATE login_verification_codes SET attempts = ? WHERE id = ?").bind(attempts, tempSessionId).run();
      return new Response(JSON.stringify({ error: `Incorrect verification code. (${5 - attempts} attempts remaining)` }), {
        status: 400,
        headers,
      });
    }

    const now = new Date().toISOString();
    if (record.expires_at < now) {
      await env.DB.prepare("DELETE FROM login_verification_codes WHERE id = ?").bind(tempSessionId).run();
      return new Response(JSON.stringify({ error: "Verification code has expired" }), {
        status: 400,
        headers,
      });
    }

    await env.DB.prepare("DELETE FROM login_verification_codes WHERE id = ?").bind(tempSessionId).run();

    const userResult = await env.DB.prepare(
      "SELECT * FROM users WHERE id = ?"
    ).bind(record.user_id).first<{
      id: string;
      email: string;
      display_name: string;
      language?: string;
    }>();

    if (!userResult) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers,
      });
    }

    const memberResult = await env.DB.prepare(
      "SELECT workspace_id FROM workspace_members WHERE user_id = ? LIMIT 1"
    ).bind(userResult.id).first<{ workspace_id: string }>();

    let workspaceId = memberResult?.workspace_id || "";
    let defaultChannelId = "";

    if (workspaceId) {
      const channelResult = await env.DB.prepare(
        "SELECT id FROM channels WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1"
      ).bind(workspaceId).first<{ id: string }>();
      defaultChannelId = channelResult?.id || "";
    }

    const secret = await getJwtSecret(env);
    const accessToken = await signJWT(
      { userId: userResult.id, type: "access", exp: Math.floor(Date.now() / 1000) + 900 },
      secret
    );
    const refreshToken = await signJWT(
      { userId: userResult.id, type: "refresh", exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 },
      secret
    );

    const cookieValue = serializeCookie(
      "refresh_token",
      refreshToken,
      getCookieOptions(request, env, 30 * 24 * 3600)
    );

    const responseHeaders = new Headers(headers);
    responseHeaders.append("Set-Cookie", cookieValue);

    logAudit(env, workspaceId || null, userResult.id, "user_login", { email: userResult.email, method: "mfa" }, request).catch(console.error);
    sendLoginAlertMail(request, env, userResult.email, userResult.display_name).catch(console.error);

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: userResult.id,
        displayName: userResult.display_name,
        email: userResult.email,
        avatarUrl: (userResult as any).avatar_url || null,
        workspaceId,
        defaultChannelId,
        token: accessToken,
        language: userResult.language || 'ja',
      }
    }), {
      status: 200,
      headers: responseHeaders,
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

async function sendLoginAlertMail(
  request: Request,
  env: Env,
  email: string,
  displayName: string
): Promise<void> {
  try {
    const smtpSettings = await getSmtpSettings(env);
    if (!smtpSettings) return;

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const userAgent = request.headers.get("User-Agent") || "unknown";
    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

    await sendMail(smtpSettings, {
      to: email,
      subject: "【CoHive】ログイン通知",
      text: `こんにちは、${displayName}さん。\n\nCoHiveアカウントへのログインが検出されました。\n\n検出情報:\n・日時: ${now} (日本時間)\n・IPアドレス: ${ip}\n・ブラウザ/環境: ${userAgent}\n\nもしご自身のアクションである場合は、このメールを無視して結構です。`,
      html: `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eaeaea; border-radius: 5px; max-width: 600px; margin: 0 auto; color: #333;">
          <h2 style="color: #4f46e5; margin-top: 0; font-size: 18px; border-bottom: 2px solid #4f46e5; padding-bottom: 8px;">CoHive ログイン通知</h2>
          <p>こんにちは、<strong>${displayName}</strong> さん。</p>
          <p>あなたのアカウントへのログインが検出されました。</p>
        </div>
      `
    });
  } catch (err) {
    console.error("Failed to send login alert email:", err);
  }
}

export async function handleRegister(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    const body: any = await request.json();
    const { email, password, displayName, language } = body;

    if (!email || !password || !displayName) {
      return new Response(JSON.stringify({ error: "Missing required fields (email, password, displayName)" }), {
        status: 400,
        headers,
      });
    }

    if (password.length < 8) {
      return new Response(JSON.stringify({ error: "Password must be at least 8 characters long" }), {
        status: 400,
        headers,
      });
    }

    const existingUser = await env.DB.prepare(
      "SELECT id FROM users WHERE email = ?"
    ).bind(email).first<{ id: string }>();

    if (existingUser) {
      return new Response(JSON.stringify({ error: "Email is already registered" }), {
        status: 400,
        headers,
      });
    }

    const passwordHash = await hashPassword(password);
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = await hashPassword(recoveryCode);
    const userId = crypto.randomUUID();

    await env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, recovery_code_hash, display_name, language, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).bind(userId, email, passwordHash, recoveryCodeHash, displayName, language || 'ja').run();

    return new Response(JSON.stringify({
      success: true,
      message: "User registered successfully",
      data: {
        userId,
        recoveryCode,
      }
    }), {
      status: 201,
      headers,
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * リカバリーコードによるパスワード再設定と自動ログイン処理
 * POST /api/auth/recovery
 */
export async function handleRecovery(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers: any = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    const body: any = await request.json();
    const { email, recoveryCode, newPassword } = body;

    if (!email || !recoveryCode || !newPassword) {
      return new Response(JSON.stringify({ error: "Email, recovery code, and new password are required" }), {
        status: 400,
        headers,
      });
    }

    if (newPassword.length < 8) {
      return new Response(JSON.stringify({ error: "Password must be at least 8 characters long" }), {
        status: 400,
        headers,
      });
    }

    // ユーザー情報の取得
    const userResult = await env.DB.prepare(
      "SELECT * FROM users WHERE email = ?"
    ).bind(email).first<any>();

    if (!userResult) {
      return new Response(JSON.stringify({ error: "Invalid email or recovery code" }), {
        status: 400,
        headers,
      });
    }

    if (userResult.status === 'suspended') {
      return new Response(JSON.stringify({ error: "このアカウントは一時停止（BAN）されています。システム管理者にお問い合わせください。" }), {
        status: 403,
        headers,
      });
    }

    // リカバリーコードの検証
    const isRecoveryValid = await verifyPassword(recoveryCode, userResult.recovery_code_hash);
    if (!isRecoveryValid) {
      return new Response(JSON.stringify({ error: "Invalid email or recovery code" }), {
        status: 400,
        headers,
      });
    }

    // 新しいパスワードのハッシュ化、新しいリカバリーコードの生成
    const passwordHash = await hashPassword(newPassword);
    const newRecoveryCode = generateRecoveryCode();
    const newRecoveryCodeHash = await hashPassword(newRecoveryCode);

    // ユーザーレコードの更新
    await env.DB.prepare(
      "UPDATE users SET password_hash = ?, recovery_code_hash = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(passwordHash, newRecoveryCodeHash, userResult.id).run();

    // ログインセッションの作成
    let workspaceId = "";
    let workspaceName = "";
    let defaultChannelId = "";

    const memberResult = await env.DB.prepare(
      "SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1"
    ).bind(userResult.id).first<{ workspace_id: string }>();

    if (memberResult) {
      workspaceId = memberResult.workspace_id;
      const wsResult = await env.DB.prepare(
        "SELECT name FROM workspaces WHERE id = ?"
      ).bind(workspaceId).first<{ name: string }>();
      workspaceName = wsResult?.name || "マイワークスペース";

      const channelResult = await env.DB.prepare(
        "SELECT id FROM channels WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1"
      ).bind(workspaceId).first<{ id: string }>();
      defaultChannelId = channelResult?.id || "";
    }

    const secret = getJwtSecret(env);
    const accessToken = await signJWT(
      { userId: userResult.id, type: "access", exp: Math.floor(Date.now() / 1000) + 900 },
      secret
    );

    const newRefreshToken = await signJWT(
      { userId: userResult.id, type: "refresh", exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 },
      secret
    );

    const cookieValue = serializeCookie(
      "refresh_token",
      newRefreshToken,
      getCookieOptions(request, env, 30 * 24 * 3600)
    );

    const responseHeaders = new Headers(headers);
    responseHeaders.append("Set-Cookie", cookieValue);

    // 監査ログ出力
    logAudit(env, workspaceId || null, userResult.id, "password_recovery_success", { email }, request).catch(console.error);

    return new Response(JSON.stringify({
      success: true,
      message: "Password reset and logged in successfully",
      data: {
        id: userResult.id,
        displayName: userResult.display_name,
        email: userResult.email,
        avatarUrl: userResult.avatar_url || null,
        workspaceId,
        workspaceName,
        defaultChannelId,
        token: accessToken,
        language: userResult.language || 'ja',
        recoveryCode: newRecoveryCode
      }
    }), {
      status: 200,
      headers: responseHeaders,
    });

  } catch (error: any) {
    console.error("Recovery failed:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}
