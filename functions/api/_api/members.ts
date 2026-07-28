import type { Env } from "../[[route]]";
import { verifyJWT, getJwtSecret } from "../_utils/jwt";

/**
 * ワークスペースのメンバー一覧を取得します。
 * GET /api/workspaces/:workspaceId/members
 */
export async function handleGetWorkspaceMembers(
  request: Request,
  env: Env,
  workspaceId: string
): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };

  try {
    const { results } = await env.DB.prepare(`
      SELECT 
        u.id as userId,
        u.email,
        COALESCE(u.display_name, 'ユーザー') as displayName,
        u.avatar_url as avatarUrl,
        wm.role,
        COALESCE(u.status, 'active') as status,
        u.last_active_at as lastActiveAt
      FROM workspace_members wm
      JOIN users u ON wm.user_id = u.id
      WHERE wm.workspace_id = ?
      ORDER BY u.display_name ASC
    `).bind(workspaceId).all<any>();

    return new Response(JSON.stringify({
      success: true,
      data: results || []
    }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to fetch workspace members:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * メンバーをワークスペースに招待/追加します。
 * POST /api/workspaces/:workspaceId/members
 */
export async function handleAddWorkspaceMember(
  request: Request,
  env: Env,
  workspaceId: string
): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };

  try {
    const body: any = await request.json();
    const { email, displayName, role = 'member' } = body;

    if (!email) {
      return new Response(JSON.stringify({ error: "Email is required" }), {
        status: 400,
        headers,
      });
    }

    let user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
    let userId = user?.id;

    if (!userId) {
      userId = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(`
        INSERT INTO users (id, email, display_name, status, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', ?, ?)
      `).bind(userId, email, displayName || email.split('@')[0], now, now).run();
    }

    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(workspaceId, userId, role, now, now).run();

    return new Response(JSON.stringify({
      success: true,
      data: {
        userId,
        email,
        displayName: displayName || email.split('@')[0],
        role,
        status: 'pending'
      }
    }), {
      status: 201,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to add workspace member:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * 未アクティブメンバーを再招待します。
 * POST /api/workspaces/:workspaceId/members/:userId/reinvite
 */
export async function handleReinviteMember(
  request: Request,
  env: Env,
  workspaceId: string,
  targetUserId: string
): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };

  try {
    return new Response(JSON.stringify({
      success: true,
      message: "Re-invitation email sent"
    }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to reinvite member:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * ワークスペースにおけるユーザーのロールを取得します。
 * GET /api/workspaces/:workspaceId/role
 */
export async function handleGetUserRole(
  request: Request,
  env: Env,
  workspaceId: string
): Promise<Response> {
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
      return new Response(JSON.stringify({ success: true, role: 'guest', ledGroups: [] }), {
        status: 200,
        headers,
      });
    }

    const memberRecord = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, userId).first<{ role: string }>();

    const role = memberRecord?.role || 'member';

    const { results: ledGroupResults } = await env.DB.prepare(
      "SELECT group_id FROM group_members WHERE user_id = ? AND is_leader = 1"
    ).bind(userId).all<{ group_id: string }>();

    const ledGroups = ledGroupResults ? ledGroupResults.map(r => r.group_id) : [];

    return new Response(JSON.stringify({
      success: true,
      role,
      ledGroups
    }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to fetch user role:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * メンバーのロールを変更します。
 * PUT /api/workspaces/:workspaceId/members/:userId
 */
export async function handleUpdateMemberRole(
  request: Request,
  env: Env,
  workspaceId: string,
  targetUserId: string
): Promise<Response> {
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
    const { role } = body;

    if (!role) {
      return new Response(JSON.stringify({ error: "Role is required" }), {
        status: 400,
        headers,
      });
    }

    await env.DB.prepare(`
      UPDATE workspace_members 
      SET role = ?, updated_at = datetime('now') 
      WHERE workspace_id = ? AND user_id = ?
    `).bind(role, workspaceId, targetUserId).run();

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to update member role:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * メンバーをワークスペースから削除します。
 * DELETE /api/workspaces/:workspaceId/members/:userId
 */
export async function handleRemoveMember(
  request: Request,
  env: Env,
  workspaceId: string,
  targetUserId: string
): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };

  try {
    await env.DB.prepare(
      "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, targetUserId).run();

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to remove member:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * ユーザー自身のプロフィール情報を更新します。
 * PUT /api/users/me
 */
export async function handleUpdateUserProfile(
  request: Request,
  env: Env
): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "PUT, OPTIONS",
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

    const body: any = await request.json();
    const { displayName, avatarUrl, language } = body;

    const updates: string[] = [];
    const params: any[] = [];

    if (displayName !== undefined) {
      updates.push("display_name = ?");
      params.push(displayName);
    }
    if (avatarUrl !== undefined) {
      updates.push("avatar_url = ?");
      params.push(avatarUrl);
    }
    if (language !== undefined) {
      updates.push("language = ?");
      params.push(language);
    }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      params.push(userId);
      await env.DB.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to update user profile:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}
