import type { Env } from "../[[route]]";
import { verifyUserAuth } from "../_utils/jwt";
import { getCorsHeaders } from "../_utils/cors";



/**
 * プッシュ通知購読の登録処理
 * POST /api/push/subscribe
 */
export async function handlePushSubscribe(request: Request, env: Env): Promise<Response> {
  const headers = getCorsHeaders(request, "POST, OPTIONS");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const body: any = await request.json();
    const { subscription } = body;

    if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
      return new Response(JSON.stringify({ error: "Invalid subscription data" }), { status: 400, headers });
    }

    const subscriptionId = crypto.randomUUID();
    const endpoint = subscription.endpoint;
    const p256dh = subscription.keys.p256dh;
    const auth = subscription.keys.auth;

    // 重複登録は置換・更新する
    await env.DB.prepare(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(endpoint) DO UPDATE SET 
        user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        created_at = datetime('now')
    `).bind(subscriptionId, userId, endpoint, p256dh, auth).run();

    return new Response(
      JSON.stringify({
        success: true,
        message: "Successfully registered push subscription with backend."
      }),
      { status: 200, headers }
    );

  } catch (error: any) {
    console.error("Failed to register push subscription:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers
    });
  }
}

/**
 * VAPID公開鍵の取得
 * GET /api/push/vapid-public-key
 */
export async function handleGetVapidPublicKey(request: Request, env: Env): Promise<Response> {
  const headers = getCorsHeaders(request, "GET, OPTIONS");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    let publicKey = (env as any).VAPID_PUBLIC_KEY || "";
    if (!publicKey) {
      const setting = await env.DB.prepare(
        "SELECT value FROM system_settings WHERE key = ?"
      ).bind("vapid_public_key").first<{ value: string }>().catch(() => null);
      if (setting && setting.value) {
        publicKey = setting.value;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        publicKey: publicKey || ""
      }),
      { status: 200, headers }
    );
  } catch (error: any) {
    console.error("Failed to get VAPID public key:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers
    });
  }
}

