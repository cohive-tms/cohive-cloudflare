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



    // ユーザーを検索
    const userResult = await env.DB.prepare(
      "SELECT * FROM users WHERE email = ?"
    ).bind(email).first<{
      id: string;
      email: string;
      password_hash: string;
      display_name: string;
      language?: string;
    }>();

    if (!userResult) {
      return new Response(JSON.stringify({ error: "Invalid email or password" }), {
        status: 401,
        headers,
      });
    }

    // パスワードの検証
    const isPasswordValid = await verifyPassword(password, userResult.password_hash);
    if (!isPasswordValid) {
      return new Response(JSON.stringify({ error: "Invalid email or password" }), {
        status: 401,
        headers,
      });
    }

    // ユーザーが所属するワークスペースを取得
    const memberResult = await env.DB.prepare(
      "SELECT workspace_id FROM workspace_members WHERE user_id = ? LIMIT 1"
    ).bind(userResult.id).first<{ workspace_id: string }>();

    let workspaceId = memberResult?.workspace_id || "";
    let defaultChannelId = "";

    if (workspaceId) {
      // ワークスペース内のデフォルト（最初の）チャンネルを取得
      const channelResult = await env.DB.prepare(
        "SELECT id FROM channels WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1"
      ).bind(workspaceId).first<{ id: string }>();
      defaultChannelId = channelResult?.id || "";
    }

    // SMTP設定およびMFA（2段階認証）有効フラグのチェック
    const smtpSettings = await getSmtpSettings(env);
    const mfaRequired = smtpSettings && smtpSettings.mfaEnabled;

    if (mfaRequired) {
      // MFAが有効な場合：確認コードを発行してメール送信、JWTトークンはまだ生成しない
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString(); // 6桁のOTP
      const mfaSessionId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5分間有効

      // login_verification_codes テーブルに保存
      await env.DB.prepare(
        "INSERT INTO login_verification_codes (id, user_id, code, expires_at) VALUES (?, ?, ?, ?)"
      ).bind(mfaSessionId, userResult.id, otpCode, expiresAt).run();

      // メール送信
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
              <p style="color: #9ca3af; font-size: 11px; margin-top: 25px; border-top: 1px solid #eee; padding-top: 10px;">
                ※本メールは自動送信されています。もしログイン要求に心当たりがない場合は、他人にパスワードが漏洩している可能性があります。至急管理者に報告するか、パスワードを変更してください。
              </p>
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

    // 監査ログの記録
    logAudit(env, workspaceId || null, userResult.id, "user_login", { email: userResult.email, method: "password" }, request).catch(console.error);

    // ログインアラートメールを送信（非同期）
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

// パスワード変更 API ハンドラー
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
      return new Response(JSON.stringify({ error: "New password must be at least 8 characters long and contain uppercase, lowercase, numbers, and symbols (!@#$%^&*)." }), {
        status: 400,
        headers: customHeaders,
      });
    }

    // デモユーザーの保護
    if (userId === "demo-user-id") {
      return new Response(JSON.stringify({ error: "Demo user password cannot be changed" }), {
        status: 400,
        headers: customHeaders,
      });
    }

    // ユーザー情報の取得
    const user = await env.DB.prepare(
      "SELECT password_hash FROM users WHERE id = ?"
    ).bind(userId).first<{ password_hash: string }>();

    if (!user) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: customHeaders,
      });
    }

    // 現在のパスワード検証
    const isPasswordValid = await verifyPassword(currentPassword, user.password_hash);
    if (!isPasswordValid) {
      return new Response(JSON.stringify({ error: "Incorrect current password" }), {
        status: 400,
        headers: customHeaders,
      });
    }

    // 新しいパスワードをハッシュ化して保存
    const newHash = await hashPassword(newPassword);
    await env.DB.prepare(
      "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?"
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

// セッションのサイレントリフレッシュ
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
    const cookies = parseCookies(request);
    const refreshToken = cookies["refresh_token"];

    if (!refreshToken) {
      return new Response(JSON.stringify({ error: "Refresh token is missing" }), {
        status: 401,
        headers,
      });
    }

    const secret = await getJwtSecret(env);
    const payload = await verifyJWT(refreshToken, secret);

    if (!payload || payload.type !== "refresh" || !payload.userId) {
      return new Response(JSON.stringify({ error: "Invalid or expired refresh token" }), {
        status: 401,
        headers,
      });
    }

    const userId = payload.userId;

    // ユーザー情報とデフォルトのワークスペース・チャンネルを再取得
    const userResult = await env.DB.prepare(
      "SELECT id, email, display_name, avatar_url as avatarUrl, language FROM users WHERE id = ?"
    ).bind(userId).first<{
      id: string;
      email: string;
      display_name: string;
      avatarUrl?: string | null;
      language?: string;
    }>();

    if (!userResult) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 401,
        headers,
      });
    }

    const memberResult = await env.DB.prepare(
      "SELECT workspace_id FROM workspace_members WHERE user_id = ? LIMIT 1"
    ).bind(userId).first<{ workspace_id: string }>();

    let workspaceId = memberResult?.workspace_id || "";
    let defaultChannelId = "";

    if (workspaceId) {
      const channelResult = await env.DB.prepare(
        "SELECT id FROM channels WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1"
      ).bind(workspaceId).first<{ id: string }>();
      defaultChannelId = channelResult?.id || "";
    }

    // 新しいアクセストークンを生成 (15分有効)
    const accessToken = await signJWT(
      { userId, type: "access", exp: Math.floor(Date.now() / 1000) + 900 },
      secret
    );

    // リフレッシュトークンもローテーション (有効期限の更新)
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

// ログアウト (リフレッシュトークンCookieの削除)
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

// 2段階認証 (MFA) の検証とログイン完了処理
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

    // コードの検証
    const record = await env.DB.prepare(
      "SELECT * FROM login_verification_codes WHERE id = ?"
    ).bind(tempSessionId).first<{ id: string; user_id: string; code: string; expires_at: string }>();

    if (!record) {
      return new Response(JSON.stringify({ error: "Invalid temporary session ID" }), {
        status: 400,
        headers,
      });
    }

    if (record.code !== code.trim()) {
      return new Response(JSON.stringify({ error: "Incorrect verification code" }), {
        status: 400,
        headers,
      });
    }

    const now = new Date().toISOString();
    if (record.expires_at < now) {
      return new Response(JSON.stringify({ error: "Verification code has expired" }), {
        status: 400,
        headers,
      });
    }

    // 検証成功したため、一時コードレコードを削除
    await env.DB.prepare("DELETE FROM login_verification_codes WHERE id = ?").bind(tempSessionId).run();

    // ユーザー情報取得
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

    // 所属ワークスペース情報取得
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

    // JWT発行
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

    // 監査ログの記録
    logAudit(env, workspaceId || null, userResult.id, "user_login", { email: userResult.email, method: "mfa" }, request).catch(console.error);

    // ログイン成功時にログインアラートメールを送信（非同期）
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

// ログインアラートメールの送信ヘルパー
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
    
    // Cloudflareのコンテキストから日本時間としてフォーマット
    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

    await sendMail(smtpSettings, {
      to: email,
      subject: "【CoHive】ログイン通知",
      text: `こんにちは、${displayName}さん。\n\nCoHiveアカウントへのログインが検出されました。\n\n検出情報:\n・日時: ${now} (日本時間)\n・IPアドレス: ${ip}\n・ブラウザ/環境: ${userAgent}\n\nもしご自身のアクションである場合は、このメールを無視して結構です。心当たりがない場合は、速やかにパスワードを変更してください。`,
      html: `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eaeaea; border-radius: 5px; max-width: 600px; margin: 0 auto; color: #333;">
          <h2 style="color: #4f46e5; margin-top: 0; font-size: 18px; border-bottom: 2px solid #4f46e5; padding-bottom: 8px;">CoHive ログイン通知</h2>
          <p>こんにちは、<strong>${displayName}</strong> さん。</p>
          <p>あなたのアカウントへのログインが検出されました。</p>
          <div style="background: #f9fafb; padding: 15px; margin: 15px 0; font-size: 13px; line-height: 1.6; color: #444; border-radius: 4px;">
            <strong>【検出されたログイン情報】</strong><br>
            ・<strong>日時:</strong> ${now}<br>
            ・<strong>IPアドレス:</strong> ${ip}<br>
            ・<strong>環境/ブラウザ:</strong> ${userAgent}
          </div>
          <p style="color: #9ca3af; font-size: 11px; margin-top: 25px; border-top: 1px solid #eee; padding-top: 10px;">
            ※本メールはご自身でのログインの際にも送信されます。心当たりがないログインである場合は、パスワードが不正使用されている恐れがあります。速やかにログインしてパスワードを変更するか、管理者にご連絡ください。
          </p>
        </div>
      `
    });
  } catch (err) {
    console.error("Failed to send login alert email:", err);
  }
}

// 新規ユーザー登録 (セルフサインアップ)
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

    // メールアドレス重複チェック
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

