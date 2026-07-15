import type { Env } from "../[[route]]";
import { generateVapidKeys } from "../_utils/webpush";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id",
};

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// 1. VAPID公開鍵の取得（存在しなければ動的自動生成）
export async function handleGetVapidPublicKey(request: Request, env: Env): Promise<Response> {
  try {
    let result = await env.DB.prepare(
      "SELECT public_key FROM push_vapid_key WHERE id = 1"
    ).first<{ public_key: string }>();

    let publicKeyJwkStr: string;

    if (!result) {
      console.log("Web Push: VAPID keys not found. Generating dynamically...");
      const keys = await generateVapidKeys();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO push_vapid_key (id, public_key, private_key) VALUES (1, ?, ?)"
      )
        .bind(keys.publicKey, keys.privateKey)
        .run();
      publicKeyJwkStr = keys.publicKey;
    } else {
      publicKeyJwkStr = result.public_key;
    }

    // JWKを Raw公開鍵にデコードし、クライアント向けにbase64url化する
    const publicKeyJwk = JSON.parse(publicKeyJwkStr);
    const cryptoPubKey = await crypto.subtle.importKey(
      "jwk",
      publicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      []
    );
    const rawPubKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", cryptoPubKey));
    const applicationServerKey = base64UrlEncode(rawPubKeyBytes);

    return new Response(JSON.stringify({ publicKey: applicationServerKey }), {
      status: 200,
      headers,
    });
  } catch (err: any) {
    console.error("Failed to retrieve or generate VAPID keys:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers,
    });
  }
}

// 2. ブラウザ通知サブスクリプションの購読登録
export async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    const body: any = await request.json();
    const { subscription } = body;

    if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
      return new Response(JSON.stringify({ error: "Invalid subscription structure" }), {
        status: 400,
        headers,
      });
    }

    const id = crypto.randomUUID();

    // サブスクリプションをD1に保存（すでに同一エンドポイントがある場合は上書き）
    await env.DB.prepare(
      "INSERT OR REPLACE INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(id, userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth)
      .run();

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (err: any) {
    console.error("Failed to subscribe user for push:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers,
    });
  }
}

// 3. テスト用のWeb Pushプッシュ通知送信
import { sendPushToUsers } from "./chat/message";

export async function handleSendTestPush(request: Request, env: Env): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    const title = "Cohive テスト通知";
    const content = "プッシュ通知の設定が正しく完了しました！";
    const linkUrl = "/";

    await sendPushToUsers(env, [userId], title, content, linkUrl);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (err: any) {
    console.error("Failed to send test push:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers,
    });
  }
}
