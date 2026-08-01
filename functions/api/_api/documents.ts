import type { Env } from "../[[route]]";
import { verifyUserAuth, verifyWorkspaceMember } from "../_utils/jwt";
import { getCorsHeaders } from "../_utils/cors";

/**
 * ワークスペースのドキュメント（Wiki）を取得します。
 * GET /api/workspaces/:workspaceId/document
 */
export async function handleGetWorkspaceDocument(
  request: Request,
  env: Env,
  workspaceId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "GET, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    if (!(await verifyWorkspaceMember(env, workspaceId, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }
    const record = await env.DB.prepare(
      "SELECT document FROM workspaces WHERE id = ?"
    ).bind(workspaceId).first<{ document: string }>();

    return new Response(JSON.stringify({
      success: true,
      document: record?.document || ""
    }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to fetch workspace document:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * ワークスペースのドキュメント（Wiki）を更新します。
 * PUT /api/workspaces/:workspaceId/document
 */
export async function handleUpdateWorkspaceDocument(
  request: Request,
  env: Env,
  workspaceId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "PUT, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    if (!(await verifyWorkspaceMember(env, workspaceId, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }
    const body: any = await request.json();
    const { document = "" } = body;

    await env.DB.prepare(
      "UPDATE workspaces SET document = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(document, workspaceId).run();

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to update workspace document:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

// インメモリの排他ロック簡易キャッシュ構造
const documentLocks: Record<string, { userId: string; userName: string; expiresAt: number }> = {};

/**
 * ドキュメント編集権の排他ロックを取得します。
 * POST /api/document-locks/:key/acquire
 */
export async function handleAcquireDocumentLock(
  request: Request,
  env: Env,
  lockKey: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "POST, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const decodedKey = decodeURIComponent(lockKey);
    if (!(await verifyWorkspaceMember(env, decodedKey, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }

    const now = Date.now();
    const existingLock = documentLocks[decodedKey];

    if (existingLock && existingLock.expiresAt > now && existingLock.userId !== userId) {
      return new Response(JSON.stringify({
        success: false,
        error: `現在 ${existingLock.userName} が編集中のためロックされています`,
        lockedByUserName: existingLock.userName
      }), {
        status: 200,
        headers,
      });
    }

    // 送信者の表示名を取得
    let userName = '他ユーザー';
    if (userId) {
      const u = await env.DB.prepare("SELECT display_name FROM users WHERE id = ?").bind(userId).first<{ display_name: string }>();
      if (u?.display_name) userName = u.display_name;
    }

    documentLocks[decodedKey] = {
      userId: userId || 'anonymous',
      userName,
      expiresAt: now + 45000, // 45秒間有効
    };

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to acquire document lock:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * ドキュメント編集権のロックハートビート（維持）を処理します。
 * POST /api/document-locks/:key/heartbeat
 */
export async function handleHeartbeatDocumentLock(
  request: Request,
  env: Env,
  lockKey: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "POST, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    const decodedKey = decodeURIComponent(lockKey);
    if (!(await verifyWorkspaceMember(env, decodedKey, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }
    if (documentLocks[decodedKey]) {
      documentLocks[decodedKey].expiresAt = Date.now() + 45000;
    }

    return new Response(JSON.stringify({ success: true }), {
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

/**
 * ドキュメント編集権のロックを解放します。
 * POST /api/document-locks/:key/release
 */
export async function handleReleaseDocumentLock(
  request: Request,
  env: Env,
  lockKey: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "POST, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    const decodedKey = decodeURIComponent(lockKey);
    if (!(await verifyWorkspaceMember(env, decodedKey, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }
    delete documentLocks[decodedKey];

    return new Response(JSON.stringify({ success: true }), {
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
