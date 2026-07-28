import type { Env } from "../[[route]]";
import { verifyJWT, getJwtSecret } from "../_utils/jwt";

/**
 * ログインユーザーが所属するワークスペース一覧を取得します。
 * GET /api/workspaces
 */
export async function handleGetWorkspaces(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };

  try {
    let userId = request.headers.get("X-User-Id");

    if (!userId) {
      const authHeader = request.headers.get("Authorization");
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7);
        const secret = getJwtSecret(env);
        const payload = await verifyJWT(token, secret);
        if (payload && payload.userId) {
          userId = payload.userId as string;
        }
      }
    }

    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized: User ID missing" }), {
        status: 401,
        headers,
      });
    }

    const { results } = await env.DB.prepare(`
      SELECT 
        w.id, 
        w.name, 
        w.created_at as createdAt, 
        w.updated_at as updatedAt,
        wm.role,
        COALESCE(ws.status, 'active') as status
      FROM workspaces w
      JOIN workspace_members wm ON w.id = wm.workspace_id
      LEFT JOIN workspace_subscriptions ws ON w.id = ws.workspace_id
      WHERE wm.user_id = ?
      ORDER BY w.created_at ASC
    `).bind(userId).all<any>();

    return new Response(JSON.stringify({
      success: true,
      data: results || []
    }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to fetch user workspaces:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * 新規ワークスペースを作成します。
 * POST /api/workspaces
 */
export async function handleCreateWorkspace(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };

  try {
    let userId = request.headers.get("X-User-Id");
    if (!userId) {
      const authHeader = request.headers.get("Authorization");
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7);
        const secret = getJwtSecret(env);
        const payload = await verifyJWT(token, secret);
        if (payload && payload.userId) {
          userId = payload.userId as string;
        }
      }
    }

    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers,
      });
    }

    const body: any = await request.json();
    const { name } = body;

    if (!name) {
      return new Response(JSON.stringify({ error: "Workspace name is required" }), {
        status: 400,
        headers,
      });
    }

    const workspaceId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
    `).bind(workspaceId, name, now, now).run();

    await env.DB.prepare(`
      INSERT INTO workspace_members (workspace_id, user_id, role, created_at, updated_at)
      VALUES (?, ?, 'owner', ?, ?)
    `).bind(workspaceId, userId, now, now).run();

    await env.DB.prepare(`
      INSERT INTO channels (id, workspace_id, group_id, name, description, is_private, type, created_at, updated_at)
      VALUES (?, ?, NULL, 'general', 'General Channel', 0, 'channel', ?, ?)
    `).bind(channelId, workspaceId, now, now).run();

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: workspaceId,
        name,
        role: 'owner',
        status: 'active',
        createdAt: now,
      }
    }), {
      status: 201,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to create workspace:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * ワークスペース情報を更新します。
 * PUT /api/workspaces/:workspaceId
 */
export async function handleUpdateWorkspace(request: Request, env: Env, workspaceId: string): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };

  try {
    const body: any = await request.json();
    const { name, customStatuses } = body;

    const updates: string[] = [];
    const params: any[] = [];

    if (name !== undefined) { updates.push("name = ?"); params.push(name); }
    if (customStatuses !== undefined) {
      updates.push("custom_statuses = ?");
      params.push(Array.isArray(customStatuses) ? customStatuses.join(',') : customStatuses);
    }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      params.push(workspaceId);
      await env.DB.prepare(`UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
    }

    return new Response(JSON.stringify({ success: true, data: { id: workspaceId, name } }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to update workspace:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * ワークスペースを削除します。
 * DELETE /api/workspaces/:workspaceId
 */
export async function handleDeleteWorkspace(request: Request, env: Env, workspaceId: string): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };

  try {
    await env.DB.prepare("DELETE FROM workspaces WHERE id = ?").bind(workspaceId).run();
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to delete workspace:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}
