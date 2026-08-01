import type { Env } from "../[[route]]";
import { verifyUserAuth, verifyWorkspaceMember } from "../_utils/jwt";
import { getCorsHeaders } from "../_utils/cors";

/**
 * ワークスペースのグループ一覧を取得します。
 * GET /api/workspaces/:workspaceId/groups
 */
export async function handleGetWorkspaceGroups(
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
    const { results: groups } = await env.DB.prepare(`
      SELECT id, workspace_id as workspaceId, name, is_private as isPrivate, created_at as createdAt
      FROM groups
      WHERE workspace_id = ?
      ORDER BY created_at ASC
    `).bind(workspaceId).all<any>();

    const groupIds = (groups || []).map((g: any) => g.id);
    let membersMap: Record<string, { userId: string; isLeader: boolean }[]> = {};

    if (groupIds.length > 0) {
      const placeholders = groupIds.map(() => '?').join(',');
      const { results: members } = await env.DB.prepare(`
        SELECT group_id, user_id, is_leader FROM group_members WHERE group_id IN (${placeholders})
      `).bind(...groupIds).all<any>();

      if (members) {
        for (const m of members) {
          if (!membersMap[m.group_id]) membersMap[m.group_id] = [];
          membersMap[m.group_id].push({
            userId: m.user_id,
            isLeader: Boolean(m.is_leader)
          });
        }
      }
    }

    const formatted = (groups || []).map((g: any) => ({
      ...g,
      isPrivate: Boolean(g.isPrivate),
      members: membersMap[g.id] || []
    }));

    return new Response(JSON.stringify({
      success: true,
      data: formatted
    }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to fetch workspace groups:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * 新規グループを作成します。
 * POST /api/workspaces/:workspaceId/groups
 */
export async function handleCreateGroup(
  request: Request,
  env: Env,
  workspaceId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "POST, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    if (!(await verifyWorkspaceMember(env, workspaceId, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }
    const body: any = await request.json();
    const { name, isPrivate = false, memberUserIds = [], leaderUserIds = [] } = body;

    if (!name) {
      return new Response(JSON.stringify({ error: "Group name is required" }), {
        status: 400,
        headers,
      });
    }

    const groupId = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO groups (id, workspace_id, name, is_private, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(groupId, workspaceId, name, isPrivate ? 1 : 0, now, now).run();

    if (Array.isArray(memberUserIds)) {
      const leadersSet = new Set(Array.isArray(leaderUserIds) ? leaderUserIds : []);
      for (const uId of memberUserIds) {
        const isLeader = leadersSet.has(uId) ? 1 : 0;
        await env.DB.prepare(
          "INSERT OR IGNORE INTO group_members (group_id, user_id, is_leader, created_at) VALUES (?, ?, ?, ?)"
        ).bind(groupId, uId, isLeader, now).run();
      }
    }

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: groupId,
        workspaceId,
        name,
        isPrivate: Boolean(isPrivate),
        createdAt: now,
      }
    }), {
      status: 201,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to create group:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * グループを削除します。
 * DELETE /api/workspaces/:workspaceId/groups/:groupId
 */
export async function handleDeleteGroup(
  request: Request,
  env: Env,
  workspaceId: string,
  groupId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "DELETE, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    if (!(await verifyWorkspaceMember(env, workspaceId, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }
    await env.DB.prepare("DELETE FROM groups WHERE id = ? AND workspace_id = ?").bind(groupId, workspaceId).run();
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to delete group:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * DM (ダイレクトメッセージ) チャンネルを取得または作成します。
 * POST /api/dm
 */
export async function handleCreateOrGetDm(
  request: Request,
  env: Env
): Promise<Response> {
  const headers = getCorsHeaders(request, "POST, OPTIONS");

  try {
    const currentUserId = await verifyUserAuth(request, env);

    if (!currentUserId) {
      return new Response(JSON.stringify({ error: "Unauthorized: User ID missing" }), {
        status: 401,
        headers,
      });
    }

    const body: any = await request.json();
    const { targetUserId, workspaceId } = body;

    if (!targetUserId || !workspaceId) {
      return new Response(JSON.stringify({ error: "targetUserId and workspaceId are required" }), {
        status: 400,
        headers,
      });
    }

    if (!(await verifyWorkspaceMember(env, workspaceId, currentUserId))) {
      return new Response(JSON.stringify({ error: "Forbidden: You are not a member of this workspace" }), { status: 403, headers });
    }

    // 既存のDMチャンネルがあるか確認
    const existingDm = await env.DB.prepare(`
      SELECT c.id, c.name
      FROM channels c
      JOIN channel_members cm1 ON c.id = cm1.channel_id AND cm1.user_id = ?
      JOIN channel_members cm2 ON c.id = cm2.channel_id AND cm2.user_id = ?
      WHERE c.workspace_id = ? AND c.type = 'dm'
      LIMIT 1
    `).bind(currentUserId, targetUserId, workspaceId).first<{ id: string; name: string }>();

    if (existingDm) {
      return new Response(JSON.stringify({
        success: true,
        data: {
          id: existingDm.id,
          workspaceId,
          name: existingDm.name,
          type: 'dm',
          isPrivate: true,
        }
      }), {
        status: 200,
        headers,
      });
    }

    // 相手のユーザー表示名を取得
    const targetUser = await env.DB.prepare("SELECT display_name FROM users WHERE id = ?").bind(targetUserId).first<{ display_name: string }>();
    const dmName = targetUser?.display_name || "DM";

    const channelId = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO channels (id, workspace_id, group_id, name, description, is_private, type, document, created_at, updated_at)
      VALUES (?, ?, NULL, ?, 'DM Channel', 1, 'dm', '', ?, ?)
    `).bind(channelId, workspaceId, dmName, now, now).run();

    await env.DB.prepare("INSERT INTO channel_members (channel_id, user_id, created_at) VALUES (?, ?, ?)").bind(channelId, currentUserId, now).run();
    await env.DB.prepare("INSERT INTO channel_members (channel_id, user_id, created_at) VALUES (?, ?, ?)").bind(channelId, targetUserId, now).run();

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: channelId,
        workspaceId,
        name: dmName,
        type: 'dm',
        isPrivate: true,
      }
    }), {
      status: 201,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to create DM channel:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}
