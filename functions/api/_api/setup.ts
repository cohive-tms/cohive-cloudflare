import type { Env } from "../[[route]]";
import { signJWT, generateRandomSecret, getJwtSecret, serializeCookie } from "../_utils/jwt";

export function generateRecoveryCode(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) code += "-";
    const randomIndex = crypto.getRandomValues(new Uint8Array(1))[0] % chars.length;
    code += chars[randomIndex];
  }
  return code;
}

export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);
  
  const salt = crypto.getRandomValues(new Uint8Array(16));
  
  const baseKey = await crypto.subtle.importKey(
    "raw",
    passwordBytes,
    { name: "PBKDF2" },
    false,
    ["deriveBits", "deriveKey"]
  );
  
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256"
    },
    baseKey,
    256
  );
  
  const hashArray = Array.from(new Uint8Array(derivedBits));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  
  return `pbkdf2$100000$${saltHex}$${hashHex}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    const parts = storedHash.split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") {
      return false;
    }
    
    const iterations = parseInt(parts[1], 10);
    const saltHex = parts[2];
    const originalHashHex = parts[3];
    
    // Hex文字列をUint8Arrayに復元
    const salt = new Uint8Array(
      saltHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
    );
    
    const encoder = new TextEncoder();
    const passwordBytes = encoder.encode(password);
    
    const baseKey = await crypto.subtle.importKey(
      "raw",
      passwordBytes,
      { name: "PBKDF2" },
      false,
      ["deriveBits", "deriveKey"]
    );
    
    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: iterations,
        hash: "SHA-256"
      },
      baseKey,
      256
    );
    
    const hashArray = Array.from(new Uint8Array(derivedBits));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    return hashHex === originalHashHex;
  } catch (error) {
    console.error("Password verification error:", error);
    return false;
  }
}

export async function handleSetupStatus(request: Request, env: Env): Promise<Response> {
  const headers = { 
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };

  try {
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM users"
    ).all<{ count: number }>();
    
    const count = results?.[0]?.count ?? 0;
    const setupRequired = count === 0;
    
    return new Response(JSON.stringify({ setupRequired }), {
      status: 200,
      headers
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers
    });
  }
}

export async function handleSetupRegister(request: Request, env: Env): Promise<Response> {
  const headers = { 
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };

  try {
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM users"
    ).all<{ count: number }>();
    
    const count = results?.[0]?.count ?? 0;
    if (count > 0) {
      return new Response(JSON.stringify({ 
        error: "Setup has already been completed. Administrator registration is locked." 
      }), {
        status: 403,
        headers
      });
    }

    const body: any = await request.json();
    const { email, password, displayName, workspaceName, language } = body;

    if (!email || !password || !displayName || !workspaceName) {
      return new Response(JSON.stringify({ error: "Missing required fields (email, password, displayName, workspaceName)" }), {
        status: 400,
        headers
      });
    }

    if (password.length < 8) {
      return new Response(JSON.stringify({ error: "Password must be at least 8 characters long" }), {
        status: 400,
        headers
      });
    }

    const passwordHash = await hashPassword(password);
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = await hashPassword(recoveryCode);

    const userId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const defaultChannelId = crypto.randomUUID();

    const insertWorkspace = env.DB.prepare(
      "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))"
    ).bind(workspaceId, workspaceName);

    const insertUser = env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, recovery_code_hash, display_name, language, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).bind(userId, email, passwordHash, recoveryCodeHash, displayName, language || 'ja');

    const insertMember = env.DB.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'owner', datetime('now'), datetime('now'))"
    ).bind(workspaceId, userId);

    const insertChannel = env.DB.prepare(
      "INSERT INTO channels (id, workspace_id, name, description, is_private, created_at, updated_at) VALUES (?, ?, 'general', '全メンバーが参加するデフォルトのチャンネルです', 0, datetime('now'), datetime('now'))"
    ).bind(defaultChannelId, workspaceId);

    await env.DB.batch([
      insertWorkspace,
      insertUser,
      insertMember,
      insertChannel
    ]);

    // JWT_SECRETを自動生成または取得してD1に保存する
    let secret = "";
    try {
      const existingSecret = await env.DB.prepare(
        "SELECT value FROM system_settings WHERE key = ?"
      ).bind("jwt_secret").first<{ value: string }>();

      if (existingSecret && existingSecret.value) {
        secret = existingSecret.value;
      } else {
        secret = generateRandomSecret();
        await env.DB.prepare(
          "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
        ).bind("jwt_secret", secret).run();
      }
    } catch (e) {
      console.error("Failed to setup jwt_secret in D1 database:", e);
      // 万が一マイグレーションが適用されていないなどの場合は、その場しのぎで動的生成したキーを使う
      secret = generateRandomSecret();
    }

    const accessToken = await signJWT(
      { userId, type: "access", exp: Math.floor(Date.now() / 1000) + 900 },
      secret
    );
    const refreshToken = await signJWT(
      { userId, type: "refresh", exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 },
      secret
    );

    const cookieValue = serializeCookie("refresh_token", refreshToken, {
      maxAge: 30 * 24 * 3600,
      path: "/api/auth",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    });

    const responseHeaders = new Headers(headers);
    responseHeaders.append("Set-Cookie", cookieValue);

    return new Response(JSON.stringify({
      success: true,
      message: "Administrator and workspace initialized successfully.",
      data: {
        userId,
        workspaceId,
        defaultChannelId,
        token: accessToken,
        recoveryCode
      }
    }), {
      status: 201,
      headers: responseHeaders
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers
    });
  }
}
