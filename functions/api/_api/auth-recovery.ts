import type { Env } from "../[[route]]";
import { hashPassword, verifyPassword, validatePasswordStrength } from "./setup";
import { signJWT, generateRandomSecret, getJwtSecret, serializeCookie, getCookieOptions } from "../_utils/jwt";
import { sendMail, getSmtpSettings, saveSmtpSettings, deleteSmtpSettings, type SmtpSettings } from "../_utils/smtp";

function getHeaders(request: Request) {
  return {
    "Content-Type": "application/json",
  };
}

// ランダムな一時パスワードの生成（高エントロピー 16文字）
export function generateSecureTempPassword(): string {
  const lowercase = "abcdefghijklmnopqrstuvwxyz";
  const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const numbers = "0123456789";
  const symbols = "!@#$%^&*()_+-=[]{}|;:,.<>?";
  const allChars = lowercase + uppercase + numbers + symbols;

  const getRandomChar = (chars: string): string => {
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);
    return chars[array[0] % chars.length];
  };

  // 各カテゴリから最低1文字を確保
  const password = [
    getRandomChar(lowercase),
    getRandomChar(uppercase),
    getRandomChar(numbers),
    getRandomChar(symbols),
  ];

  // 残りの12文字をランダムに充填（計16文字）
  for (let i = 0; i < 12; i++) {
    password.push(getRandomChar(allChars));
  }

  // フィッシャー–イェーツ シャッフル
  for (let i = password.length - 1; i > 0; i--) {
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);
    const j = array[0] % (i + 1);
    [password[i], password[j]] = [password[j], password[i]];
  }

  return password.join("");
}

// ユーザーがオーナー権限を持っているかチェックするヘルパー
async function checkIsOwner(env: Env, userId: string, workspaceId?: string): Promise<boolean> {
  try {
    if (workspaceId) {
      const member = await env.DB.prepare(
        "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
      )
        .bind(workspaceId, userId)
        .first<{ role: string }>();
      return member?.role === "owner";
    } else {
      // ワークスペースIDが指定されない場合は、どこかのワークスペースのオーナーであれば認可
      const member = await env.DB.prepare(
        "SELECT role FROM workspace_members WHERE user_id = ? AND role = 'owner' LIMIT 1"
      )
        .bind(userId)
        .first<{ role: string }>();
      return !!member;
    }
  } catch {
    return false;
  }
}

// 1. 管理者用リカバリーコードによるパスワード再設定
export async function handleRecovery(request: Request, env: Env): Promise<Response> {
  const headers = getHeaders(request);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    const body: any = await request.json();
    const { email, recoveryCode, newPassword } = body;

    if (!email || !recoveryCode || !newPassword) {
      return new Response(JSON.stringify({ error: "Missing required fields (email, recoveryCode, newPassword)" }), {
        status: 400,
        headers,
      });
    }

    const pwCheck = validatePasswordStrength(newPassword);
    if (!pwCheck.valid) {
      return new Response(JSON.stringify({ error: pwCheck.error }), {
        status: 400,
        headers,
      });
    }

    // ユーザー検索
    const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?")
      .bind(email)
      .first<{ id: string; email: string; display_name: string; recovery_code_hash: string | null }>();

    if (!user || !user.recovery_code_hash) {
      return new Response(JSON.stringify({ error: "Invalid email or recovery code setup" }), {
        status: 400,
        headers,
      });
    }

    // リカバリーコードの検証
    const isRecoveryValid = await verifyPassword(recoveryCode, user.recovery_code_hash);
    if (!isRecoveryValid) {
      return new Response(JSON.stringify({ error: "Invalid recovery code" }), {
        status: 400,
        headers,
      });
    }

    // 新パスワードをハッシュ化して保存し、リカバリーコードをクリア＆既存トークンを即時失効
    const newPasswordHash = await hashPassword(newPassword);
    await env.DB.prepare("UPDATE users SET password_hash = ?, recovery_code_hash = NULL, tokens_valid_after = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .bind(newPasswordHash, user.id)
      .run();

    // ユーザーが所属するワークスペースを取得
    const memberResult = await env.DB.prepare(
      "SELECT workspace_id FROM workspace_members WHERE user_id = ? LIMIT 1"
    ).bind(user.id).first<{ workspace_id: string }>();

    let workspaceId = memberResult?.workspace_id || "";
    let defaultChannelId = "";

    if (workspaceId) {
      const channelResult = await env.DB.prepare(
        "SELECT id FROM channels WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1"
      ).bind(workspaceId).first<{ id: string }>();
      defaultChannelId = channelResult?.id || "";
    }

    // ログイン用JWTトークンの新規発行
    let secret = "";
    try {
      const existingSecret = await env.DB.prepare(
        "SELECT value FROM system_settings WHERE key = ?"
      )
        .bind("jwt_secret")
        .first<{ value: string }>();

      if (existingSecret && existingSecret.value) {
        secret = existingSecret.value;
      } else {
        secret = generateRandomSecret();
        await env.DB.prepare(
          "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
        )
          .bind("jwt_secret", secret)
          .run();
      }
    } catch {
      secret = generateRandomSecret();
    }

    const accessToken = await signJWT(
      { userId: user.id, type: "access", exp: Math.floor(Date.now() / 1000) + 900 },
      secret
    );
    const refreshToken = await signJWT(
      { userId: user.id, type: "refresh", exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 },
      secret
    );

    const cookieValue = serializeCookie(
      "refresh_token",
      refreshToken,
      getCookieOptions(request, env, 30 * 24 * 3600)
    );

    const responseHeaders = new Headers(headers);
    responseHeaders.append("Set-Cookie", cookieValue);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Password reset successfully using recovery code.",
        data: {
          id: user.id,
          displayName: user.display_name,
          email: user.email,
          workspaceId,
          defaultChannelId,
          token: accessToken,
        },
      }),
      { status: 200, headers: responseHeaders }
    );
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

// 2. 管理者による他メンバー一時パスワードリセット
export async function handleResetMemberPassword(
  request: Request,
  env: Env,
  params: { workspaceId: string; userId: string }
): Promise<Response> {
  const headers = getHeaders(request);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    const operatorId = request.headers.get("X-User-Id");
    if (!operatorId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const { workspaceId, userId } = params;

    // SaaS環境でのワークスペースオーナーによる他メンバーパスワードリセット制限
    const isSaas = (env as any).SAAS_MODE === "true" || (env as any).IS_SAAS_MODE === "true" || request.headers.get("X-Saas-Mode") === "true";
    if (isSaas) {
      return new Response(JSON.stringify({ error: "SaaS環境ではワークスペース管理からの他メンバーのパスワードリセットは無効化されています。" }), {
        status: 403,
        headers,
      });
    }

    // 操作者がワークスペースのオーナーかどうかチェック
    const isOwner = await checkIsOwner(env, operatorId, workspaceId);
    if (!isOwner) {
      return new Response(JSON.stringify({ error: "Only workspace owners can reset member passwords" }), {
        status: 403,
        headers,
      });
    }

    // 対象のユーザーがワークスペースに存在するか確認
    const member = await env.DB.prepare(
      "SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    )
      .bind(workspaceId, userId)
      .first();

    if (!member) {
      return new Response(JSON.stringify({ error: "User is not a member of this workspace" }), {
        status: 404,
        headers,
      });
    }

    // 一時パスワードを生成
    const tempPassword = generateSecureTempPassword();
    const tempPasswordHash = await hashPassword(tempPassword);

    // パスワードを一時パスワードに更新し、既存の全セッション・トークンを即時失効
    await env.DB.prepare("UPDATE users SET password_hash = ?, tokens_valid_after = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .bind(tempPasswordHash, userId)
      .run();

    return new Response(
      JSON.stringify({
        success: true,
        message: "Temporary password generated successfully.",
        tempPassword,
      }),
      { status: 200, headers }
    );
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

// 3. SMTP設定の保存
export async function handleSaveSmtpSettings(request: Request, env: Env): Promise<Response> {
  const headers = getHeaders(request);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    const operatorId = request.headers.get("X-User-Id");
    if (!operatorId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    // 管理者（オーナー）権限チェック
    const isOwner = await checkIsOwner(env, operatorId);
    if (!isOwner) {
      return new Response(JSON.stringify({ error: "Only administrators/owners can configure SMTP settings" }), {
        status: 403,
        headers,
      });
    }

    const body: any = await request.json();
    const { host, port, user, pass, fromName, mfaEnabled } = body;

    if (!host || !port || !user || !pass) {
      return new Response(JSON.stringify({ error: "Missing required SMTP parameters" }), {
        status: 400,
        headers,
      });
    }

    const settings: SmtpSettings = {
      host,
      port: parseInt(port, 10),
      user,
      pass,
      fromName,
      mfaEnabled: !!mfaEnabled,
    };

    await saveSmtpSettings(env, settings);

    return new Response(JSON.stringify({ success: true, message: "SMTP settings saved successfully." }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

// 4. SMTP設定の取得
export async function handleGetSmtpSettings(request: Request, env: Env): Promise<Response> {
  const headers = getHeaders(request);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    const operatorId = request.headers.get("X-User-Id");
    if (!operatorId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const isOwner = await checkIsOwner(env, operatorId);
    if (!isOwner) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }

    const settings = await getSmtpSettings(env);
    if (!settings) {
      return new Response(JSON.stringify({ settings: null }), { status: 200, headers });
    }

    // パスワードはセキュリティのため伏せて返す
    const maskedSettings = {
      ...settings,
      pass: "********",
    };

    return new Response(JSON.stringify({ settings: maskedSettings }), { status: 200, headers });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

// 5. SMTP設定の削除（メール機能無効化）
export async function handleDeleteSmtpSettings(request: Request, env: Env): Promise<Response> {
  const headers = getHeaders(request);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    const operatorId = request.headers.get("X-User-Id");
    if (!operatorId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const isOwner = await checkIsOwner(env, operatorId);
    if (!isOwner) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }

    await deleteSmtpSettings(env);

    return new Response(JSON.stringify({ success: true, message: "SMTP settings deleted successfully." }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

// 6. SMTP接続テスト送信
export async function handleTestSmtpSettings(request: Request, env: Env): Promise<Response> {
  const headers = getHeaders(request);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    const operatorId = request.headers.get("X-User-Id");
    if (!operatorId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const isOwner = await checkIsOwner(env, operatorId);
    if (!isOwner) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }

    const body: any = await request.json();
    const { host, port, user, pass, fromName, to, mfaEnabled } = body;

    if (!to) {
      return new Response(JSON.stringify({ error: "Recipient email (to) is required for testing" }), {
        status: 400,
        headers,
      });
    }

    let settings: SmtpSettings | null = null;

    // リクエストにSMTP情報が含まれていればそれを使い、なければ保存済みの設定を使う
    if (host && port && user && pass) {
      settings = {
        host,
        port: parseInt(port, 10),
        user,
        pass: pass === "********" ? (await getSmtpSettings(env))?.pass || "" : pass,
        fromName,
        mfaEnabled: !!mfaEnabled,
      };
    } else {
      settings = await getSmtpSettings(env);
    }

    if (!settings || !settings.host || !settings.user || !settings.pass) {
      return new Response(JSON.stringify({ error: "SMTP settings not found or incomplete" }), {
        status: 400,
        headers,
      });
    }

    // テストメールの送信実行
    await sendMail(settings, {
      to,
      subject: "Cohive SMTP設定テスト",
      text: "このメールは、Cohiveから送信されたSMTP設定のテストメールです。このメールが届いている場合、メールサーバーの設定は正常に機能しています。",
      html: `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eaeaea; border-radius: 5px;">
          <h2 style="color: #4f46e5;">Cohive SMTP設定テスト</h2>
          <p>このメールは、Cohiveアプリから送信されたSMTP設定のテストメールです。</p>
          <p style="background: #f9fafb; padding: 10px; border-left: 4px solid #4f46e5;">
            <strong>ステータス:</strong> 正常に接続・送信されました。
          </p>
          <p style="color: #6b7280; font-size: 12px; margin-top: 20px;">
            ※本メールに返信する必要はありません。
          </p>
        </div>
      `,
    });

    return new Response(JSON.stringify({ success: true, message: "Test email sent successfully." }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Failed to send email. Check connection settings." }), {
      status: 500,
      headers,
    });
  }
}
