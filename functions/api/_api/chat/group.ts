import type { Env } from "../../[[route]]";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id",
};

// グループ一覧取得 API
export async function handleGetGroups(request: Request, env: Env, workspaceId: string): Promise<Response> {
  try {
    if (!workspaceId) {
      return new Response(JSON.stringify({ error: "workspaceId is required" }), {
        status: 400,
        headers,
      });
    }

    const { results } = await env.DB.prepare(`
      SELECT 
        g.id,
        g.name,
        g.is_private as isPrivate,
        g.created_at as createdAt,
        (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) as memberCount
      FROM groups g
      WHERE g.workspace_id = ?
      ORDER BY g.created_at ASC
    `).bind(workspaceId).all<any>();

    const data = results.map((row: any) => ({
      id: row.id,
      name: row.name,
      isPrivate: row.isPrivate === 1,
      createdAt: row.createdAt,
      memberCount: row.memberCount
    }));

    return new Response(JSON.stringify({ success: true, data }), {
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

// グループ作成 API
export async function handleCreateGroup(request: Request, env: Env, workspaceId: string): Promise<Response> {
  try {
    const body: any = await request.json();
    const { name, isPrivate } = body;

    if (!name || !workspaceId) {
      return new Response(JSON.stringify({ error: "name and workspaceId are required" }), {
        status: 400,
        headers,
      });
    }

    const isPrivateInt = isPrivate ? 1 : 0;
    const groupId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO groups (id, workspace_id, name, is_private, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).bind(groupId, workspaceId, name, isPrivateInt).run();

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: groupId,
        name,
        isPrivate: isPrivateInt === 1,
        memberCount: 0,
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

// グループ更新 API
export async function handleUpdateGroup(request: Request, env: Env, groupId: string): Promise<Response> {
  try {
    const body: any = await request.json();
    const { name, isPrivate } = body;
    const operatorId = request.headers.get("X-User-Id");

    if (!operatorId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    if (!name) {
      return new Response(JSON.stringify({ error: "name is required" }), {
        status: 400,
        headers,
      });
    }

    // グループが属する workspaceId を取得
    const group = await env.DB.prepare(
      "SELECT workspace_id as workspaceId FROM groups WHERE id = ?"
    ).bind(groupId).first<{ workspaceId: string }>();

    if (!group) {
      return new Response(JSON.stringify({ error: "Group not found" }), {
        status: 404,
        headers,
      });
    }

    // 操作者のロールを取得
    const operator = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(group.workspaceId, operatorId).first<{ role: string }>();

    if (!operator) {
      return new Response(JSON.stringify({ error: "Permission denied" }), {
        status: 403,
        headers,
      });
    }

    let hasPermission = operator.role === 'owner';

    // グループ管理者 (group_admin) の場合、そのグループのリーダー (is_leader = 1) であるか確認
    if (operator.role === 'group_admin') {
      const isLeader = await env.DB.prepare(
        "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND is_leader = 1"
      ).bind(groupId, operatorId).first();
      if (isLeader) {
        hasPermission = true;
      }
    }

    if (!hasPermission) {
      return new Response(JSON.stringify({ error: "Permission denied" }), {
        status: 403,
        headers,
      });
    }

    const isPrivateInt = isPrivate !== undefined ? (isPrivate ? 1 : 0) : null;

    if (isPrivateInt !== null) {
      await env.DB.prepare(
        "UPDATE groups SET name = ?, is_private = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(name, isPrivateInt, groupId).run();
    } else {
      await env.DB.prepare(
        "UPDATE groups SET name = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(name, groupId).run();
    }

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: groupId,
        name,
        isPrivate: isPrivateInt === 1
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

// グループ削除 API
export async function handleDeleteGroup(request: Request, env: Env, groupId: string): Promise<Response> {
  try {
    await env.DB.prepare(
      "DELETE FROM groups WHERE id = ?"
    ).bind(groupId).run();

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
