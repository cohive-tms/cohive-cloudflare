import type { Env } from "../../[[route]]";
import { logAudit } from "../../_utils/audit";
import { getWorkspaceSubscription } from "../../_utils/saas";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id",
};

// ワークスペース一覧取得 API
export async function handleGetWorkspaces(request: Request, env: Env): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");

    let query = `
      SELECT 
        w.*,
        COALESCE(sub.status, 'active') as status,
        COALESCE(n.unread_count, 0) as unreadCount
      FROM workspaces w
      INNER JOIN workspace_members wm ON w.id = wm.workspace_id
      LEFT JOIN workspace_subscriptions sub ON w.id = sub.workspace_id
      LEFT JOIN (
        SELECT workspace_id, COUNT(*) as unread_count 
        FROM notifications 
        WHERE user_id = ? AND is_read = 0 AND is_archived = 0
        GROUP BY workspace_id
      ) n ON w.id = n.workspace_id
      WHERE wm.user_id = ?
      ORDER BY w.created_at ASC
    `;

    const { results } = await env.DB.prepare(query)
      .bind(userId || "", userId || "")
      .all();

    const filteredResults = (results || []).filter((w: any) => {
      if (env.SAAS_MODE === "true" && w.status === "suspended") {
        return false;
      }
      return true;
    });

    return new Response(JSON.stringify({ success: true, data: filteredResults }), {
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

// ワークスペース作成 API
export async function handleCreateWorkspace(request: Request, env: Env): Promise<Response> {
  try {
    const body: any = await request.json();
    const { name } = body;
    if (!name) {
      return new Response(JSON.stringify({ error: "Workspace name is required" }), {
        status: 400,
        headers,
      });
    }

    const workspaceId = crypto.randomUUID();
    const defaultChannelId = crypto.randomUUID();
    const userId = request.headers.get("X-User-Id");

    if (env.SAAS_MODE === "true" && userId) {
      const ownedWSResult = await env.DB.prepare(
        "SELECT workspace_id FROM workspace_members WHERE user_id = ? AND role = 'owner'"
      ).bind(userId).all<{ workspace_id: string }>();

      const ownedWSList = ownedWSResult?.results || [];
      let freeCount = 0;
      for (const ws of ownedWSList) {
        const sub = await getWorkspaceSubscription(env, ws.workspace_id);
        if (!sub.plan || sub.plan === 'free' || sub.plan === 'default') {
          freeCount++;
        }
      }

      if (freeCount >= 3) {
        return new Response(JSON.stringify({ 
          error: "自身が所有する初期(Free)ワークスペースが上限(3/3)に達しています。新しく作成するには、既存のワークスペースを上位プランへ変更申請するか、不要な無料ワークスペースを削除してください。" 
        }), {
          status: 403,
          headers,
        });
      }
    }

    const insertWorkspace = env.DB.prepare(
      "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))"
    ).bind(workspaceId, name);

    const insertChannel = env.DB.prepare(
      "INSERT INTO channels (id, workspace_id, name, description, is_private, type, created_at, updated_at) VALUES (?, ?, 'general', '全メンバーが参加するデフォルトのチャンネルです', 0, 'channel', datetime('now'), datetime('now'))"
    ).bind(defaultChannelId, workspaceId);

    const batch = [insertWorkspace, insertChannel];

    if (userId) {
      const insertMember = env.DB.prepare(
        "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'owner', datetime('now'), datetime('now'))"
      ).bind(workspaceId, userId);
      batch.push(insertMember);
    }

    if (env.SAAS_LIMITS?.onWorkspaceCreated) {
      await env.SAAS_LIMITS.onWorkspaceCreated(env, workspaceId);
    }

    await env.DB.batch(batch);

    // 監査ログの記録
    logAudit(env, workspaceId, userId, "workspace_create", { workspaceName: name }, request).catch(console.error);

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: workspaceId,
        name: name,
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

// ワークスペース更新 API
export async function handleUpdateWorkspace(request: Request, env: Env, workspaceId: string): Promise<Response> {
  try {
    const operatorId = request.headers.get("X-User-Id");
    if (!operatorId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    // 操作者のロールを取得して認可チェック
    const operator = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, operatorId).first<{ role: string }>();

    if (!operator) {
      return new Response(JSON.stringify({ error: "Permission denied: Not a member of this workspace" }), {
        status: 403,
        headers,
      });
    }

    if (operator.role !== 'owner' && operator.role !== 'group_admin') {
      return new Response(JSON.stringify({ error: "Permission denied: Insufficient permissions" }), {
        status: 403,
        headers,
      });
    }

    const body: any = await request.json();
    const { name, customStatuses } = body;

    if (!name && customStatuses === undefined) {
      return new Response(JSON.stringify({ error: "Missing fields to update" }), {
        status: 400,
        headers,
      });
    }

    let updateFields = "updated_at = datetime('now')";
    const params: any[] = [];

    if (name !== undefined) {
      updateFields += ", name = ?";
      params.push(name);
    }
    if (customStatuses !== undefined) {
      updateFields += ", custom_statuses = ?";
      params.push(customStatuses);
    }

    params.push(workspaceId);

    await env.DB.prepare(
      `UPDATE workspaces SET ${updateFields} WHERE id = ?`
    ).bind(...params).run();

    // 監査ログの記録
    logAudit(env, workspaceId, operatorId, "workspace_update", { workspaceName: name, customStatuses }, request).catch(console.error);

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: workspaceId,
        name,
        customStatuses,
      }
    }), {
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

// ワークスペース削除 API
export async function handleDeleteWorkspace(request: Request, env: Env, workspaceId: string): Promise<Response> {
  try {
    const operatorId = request.headers.get("X-User-Id");
    if (!operatorId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    // 操作者のロールを取得して認可チェック（削除はownerのみ）
    const operator = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, operatorId).first<{ role: string }>();

    if (!operator) {
      return new Response(JSON.stringify({ error: "Permission denied: Not a member of this workspace" }), {
        status: 403,
        headers,
      });
    }

    if (operator.role !== 'owner') {
      return new Response(JSON.stringify({ error: "Permission denied: Only owners can delete a workspace" }), {
        status: 403,
        headers,
      });
    }

    await env.DB.prepare(
      "DELETE FROM workspaces WHERE id = ?"
    ).bind(workspaceId).run();

    // 監査ログの記録
    logAudit(env, workspaceId, operatorId, "workspace_delete", {}, request).catch(console.error);

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
