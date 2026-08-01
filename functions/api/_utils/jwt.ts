import type { Env } from "../[[route]]";

// base64url エンコード・デコード用のヘルパー
function base64urlEncode(str: string): string {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64urlDecode(str: string): string {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  return decodeURIComponent(escape(atob(base64)));
}

// 署名生成用のバイト列ベースエンコード
function arrayBufferToBase64url(buffer: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(buffer));
  return btoa(binary)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// 署名検証用のバイト列デコード
function base64urlToArrayBuffer(str: string): ArrayBuffer {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  const binary = atob(base64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer.buffer;
}

// JWTの作成 (Sign)
export async function signJWT(payload: any, secret: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const fullPayload = {
    iat: Math.floor(Date.now() / 1000),
    ...payload,
  };
  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(fullPayload));
  
  const tokenToSign = `${encodedHeader}.${encodedPayload}`;
  
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(tokenToSign)
  );
  
  const encodedSignature = arrayBufferToBase64url(signature);
  return `${tokenToSign}.${encodedSignature}`;
}

// JWTの検証 (Verify)
export async function verifyJWT(token: string, secret: string): Promise<any | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    
    const [headerSegment, payloadSegment, signatureSegment] = parts;
    const tokenToVerify = `${headerSegment}.${payloadSegment}`;
    
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    
    const signatureBuffer = base64urlToArrayBuffer(signatureSegment);
    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBuffer,
      enc.encode(tokenToVerify)
    );
    
    if (!isValid) return null;
    
    const payload = JSON.parse(base64urlDecode(payloadSegment));
    
    // 有効期限のチェック
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      return null; // 期限切れ
    }
    
    return payload;
  } catch {
    return null;
  }
}

// メモリ上のJWT_SECRETキャッシュ
let cachedJwtSecret: string | null = null;

// 暗号論的に安全なランダム文字列を生成（JWT_SECRET用）
export function generateRandomSecret(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

// データベースからJWT_SECRETを取得する関数
export async function getJwtSecret(env: Env): Promise<string> {
  // 1. メモリ上にキャッシュがある場合はそれを返す
  if (cachedJwtSecret) {
    return cachedJwtSecret;
  }

  // 2. D1データベースのsystem_settingsから取得を試みる
  try {
    const result = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = ?"
    ).bind("jwt_secret").first<{ value: string }>();

    if (result && result.value) {
      cachedJwtSecret = result.value;
      return result.value;
    }
  } catch (e) {
    console.error("Failed to read jwt_secret from D1 Database. Settings table might not be initialized yet.", e);
  }

  // 3. 初期セットアップ前などで値が存在しない場合は、一回限りのランダムシークレットを動的生成（固定キーによる署名偽造を防止）
  console.warn("jwt_secret not found in DB. Generating transient random secret for session.");
  cachedJwtSecret = generateRandomSecret();
  return cachedJwtSecret;
}

// Cookieのパースヘルパー
export function parseCookies(request: Request): Record<string, string> {
  const cookieHeader = request.headers.get("Cookie");
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  cookieHeader.split(";").forEach(cookie => {
    const eqIdx = cookie.indexOf("=");
    if (eqIdx !== -1) {
      const key = cookie.substring(0, eqIdx).trim();
      const val = cookie.substring(eqIdx + 1).trim();
      if (key) {
        cookies[key] = decodeURIComponent(val);
      }
    }
  });
  return cookies;
}

// Cookieのシリアライズヘルパー
export function serializeCookie(
  name: string,
  value: string,
  options: {
    maxAge?: number;
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Lax" | "Strict" | "None";
  } = {}
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);

  return parts.join("; ");
}

// リクエスト環境に応じてSameSite/Secureを動的に最適化するオプションビルダー
export function getCookieOptions(
  request: Request,
  env: Env,
  maxAgeSeconds: number,
  path: string = "/api/auth"
) {
  const url = new URL(request.url);
  const isHttps = url.protocol === "https:" || request.headers.get("X-Forwarded-Proto") === "https";
  
  const origin = request.headers.get("Origin");
  let isCrossDomain = false;
  if (origin && env.ALLOWED_ORIGINS) {
    const allowed = env.ALLOWED_ORIGINS.split(",").map((o: string) => o.trim());
    if (allowed.includes(origin)) {
      isCrossDomain = true;
    }
  }

  // HTTPS環境かつCORSクロスドメイン通信の場合のみ SameSite=None を設定（Secureも必須）
  const sameSite = (isHttps && isCrossDomain) ? "None" : "Lax";
  const secure = isHttps;

  return {
    maxAge: maxAgeSeconds,
    path,
    httpOnly: true,
    secure,
    sameSite: sameSite as "Lax" | "None" | "Strict",
  };
}

/**
 * リクエストに含まれる認証情報を検証し、ユーザーIDを返します。
 * ヘッダー（X-User-Id, Authorization）またはクエリパラメータ（user_id, token）に対応します。
 */
export async function verifyUserAuth(request: Request, env: Env): Promise<string | null> {
  const url = new URL(request.url);

  // 1. ヘッダーまたはクエリパラメータから userId を直接取得
  let userId = request.headers.get("X-User-Id") || 
               url.searchParams.get("user_id") || 
               url.searchParams.get("userId");

  if (userId) {
    return userId;
  }

  // 2. Authorizationヘッダーまたはクエリパラメータからトークンを取得してJWT検証
  let token = url.searchParams.get("token");
  if (!token) {
    const authHeader = request.headers.get("Authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    }
  }

  if (token) {
    try {
      const secret = await getJwtSecret(env);
      const payload = await verifyJWT(token, secret);
      if (payload && payload.userId) {
        return payload.userId as string;
      }
    } catch (e) {
      console.error("JWT verification failed in verifyUserAuth:", e);
    }
  }

  return null;
}

