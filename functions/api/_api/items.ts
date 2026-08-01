import type { Env } from "../[[route]]";
import { verifyUserAuth, verifyWorkspaceMember } from "../_utils/jwt";
import { getCorsHeaders } from "../_utils/cors";

/**
 * ワークスペース内のアイテム（タスク/予定）一覧を取得します。
 * GET /api/workspaces/:workspaceId/items
 */
export async function handleGetWorkspaceItems(
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
    const url = new URL(request.url);
    const channelId = url.searchParams.get("channelId");

    let sql = `
      SELECT 
        i.id, 
        i.workspace_id as workspaceId, 
        i.creator_id as creatorId, 
        i.title, 
        i.description, 
        i.status, 
        i.priority, 
        i.tags, 
        i.start_at as startAt, 
        i.end_at as endAt, 
        i.is_all_day as isAllDay, 
        i.is_private as isPrivate, 
        i.assigned_group_id as assignedGroupId,
        i.created_at as createdAt, 
        i.updated_at as updatedAt
      FROM items i
      WHERE i.workspace_id = ?
    `;

    const params: any[] = [workspaceId];
    if (channelId) {
      sql += ` AND (i.tags LIKE ? OR i.tags LIKE ?)`;
      params.push(`%channel:${channelId}%`, `%${channelId}%`);
    }

    sql += ` ORDER BY i.created_at DESC`;

    const { results: items } = await env.DB.prepare(sql).bind(...params).all<any>();

    // 担当者の取得
    const itemIds = (items || []).map((it: any) => it.id);
    let assigneesMap: Record<string, string[]> = {};
    if (itemIds.length > 0) {
      const placeholders = itemIds.map(() => '?').join(',');
      const { results: assignees } = await env.DB.prepare(`
        SELECT item_id, user_id FROM item_assignees WHERE item_id IN (${placeholders})
      `).bind(...itemIds).all<any>();

      if (assignees) {
        for (const a of assignees) {
          if (!assigneesMap[a.item_id]) assigneesMap[a.item_id] = [];
          assigneesMap[a.item_id].push(a.user_id);
        }
      }
    }

    const formatted = (items || []).map((it: any) => {
      const rawTags = it.tags ? it.tags.split(',').filter(Boolean) : [];
      const channelIds = rawTags
        .filter((t: string) => t.startsWith('channel:'))
        .map((t: string) => t.replace('channel:', ''));
      const normalTags = rawTags.filter((t: string) => !t.startsWith('channel:'));

      return {
        ...it,
        isAllDay: Boolean(it.isAllDay),
        isPrivate: Boolean(it.isPrivate),
        assigneeUserIds: assigneesMap[it.id] || [],
        channelIds,
        tags: normalTags,
      };
    });

    return new Response(JSON.stringify({
      success: true,
      data: formatted
    }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to fetch workspace items:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * ユーザーの全アイテム（タスク/予定）一覧を取得します（ダッシュボード用）。
 * GET /api/items
 */
export async function handleGetItems(
  request: Request,
  env: Env
): Promise<Response> {
  const headers = getCorsHeaders(request, "GET, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);

    if (!userId) {
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers,
      });
    }

    const { results: items } = await env.DB.prepare(`
      SELECT 
        i.id, 
        i.workspace_id as workspaceId, 
        i.creator_id as creatorId, 
        i.title, 
        i.description, 
        i.status, 
        i.priority, 
        i.tags, 
        i.start_at as startAt, 
        i.end_at as endAt, 
        i.is_all_day as isAllDay, 
        i.is_private as isPrivate, 
        i.assigned_group_id as assignedGroupId,
        i.created_at as createdAt, 
        i.updated_at as updatedAt
      FROM items i
      LEFT JOIN item_assignees ia ON i.id = ia.item_id
      WHERE i.creator_id = ? OR ia.user_id = ?
      GROUP BY i.id
      ORDER BY i.created_at DESC
    `).bind(userId, userId).all<any>();

    const formatted = (items || []).map((it: any) => {
      const rawTags = it.tags ? it.tags.split(',').filter(Boolean) : [];
      const channelIds = rawTags
        .filter((t: string) => t.startsWith('channel:'))
        .map((t: string) => t.replace('channel:', ''));
      const normalTags = rawTags.filter((t: string) => !t.startsWith('channel:'));

      return {
        ...it,
        isAllDay: Boolean(it.isAllDay),
        isPrivate: Boolean(it.isPrivate),
        channelIds,
        tags: normalTags,
      };
    });

    return new Response(JSON.stringify({
      success: true,
      data: formatted
    }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to fetch user items:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * 新規アイテム（タスク/予定）を作成します。
 * POST /api/workspaces/:workspaceId/items
 */
export async function handleCreateItem(
  request: Request,
  env: Env,
  workspaceId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "POST, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers,
      });
    }
    if (!(await verifyWorkspaceMember(env, workspaceId, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }

    const body: any = await request.json();
    const {
      title,
      description = '',
      status = 'todo',
      priority = 'none',
      tags = [],
      channelIds = [],
      startAt = null,
      endAt = null,
      isAllDay = false,
      isPrivate = false,
      assignedGroupId = null,
      assigneeUserIds = []
    } = body;

    if (!title) {
      return new Response(JSON.stringify({ error: "Title is required" }), {
        status: 400,
        headers,
      });
    }

    const itemId = crypto.randomUUID();
    const now = new Date().toISOString();

    // channelIds を channel:<id> タグとして結合保存
    const normalTags = Array.isArray(tags) ? tags : [];
    const chanTags = (Array.isArray(channelIds) ? channelIds : []).map((cid: string) => `channel:${cid}`);
    const allTagsArr = [...normalTags, ...chanTags];
    const tagsStr = allTagsArr.join(',');

    await env.DB.prepare(`
      INSERT INTO items (id, workspace_id, creator_id, title, description, status, priority, tags, start_at, end_at, is_all_day, is_private, assigned_group_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      itemId, workspaceId, userId, title, description, status, priority, tagsStr,
      startAt || null, endAt || null, isAllDay ? 1 : 0, isPrivate ? 1 : 0, assignedGroupId || null, now, now
    ).run();

    // 担当者の登録
    if (Array.isArray(assigneeUserIds) && assigneeUserIds.length > 0) {
      for (const assigneeId of assigneeUserIds) {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO item_assignees (item_id, user_id) VALUES (?, ?)"
        ).bind(itemId, assigneeId).run();
      }
    }

    const newItem = {
      id: itemId,
      workspaceId,
      creatorId: userId,
      title,
      description,
      status,
      priority,
      tags: normalTags,
      channelIds: Array.isArray(channelIds) ? channelIds : [],
      startAt: startAt || null,
      endAt: endAt || null,
      isAllDay: Boolean(isAllDay),
      isPrivate: Boolean(isPrivate),
      assignedGroupId: assignedGroupId || null,
      assigneeUserIds: Array.isArray(assigneeUserIds) ? assigneeUserIds : [],
      createdAt: now,
      updatedAt: now,
    };

    return new Response(JSON.stringify({
      success: true,
      data: newItem
    }), {
      status: 201,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to create item:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * アイテム（タスク/予定）を更新します。
 * PUT /api/items/:itemId
 */
export async function handleUpdateItem(
  request: Request,
  env: Env,
  itemId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "PUT, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const item = await env.DB.prepare(
      "SELECT workspace_id FROM items WHERE id = ?"
    ).bind(itemId).first<{ workspace_id: string }>();

    if (!item || !(await verifyWorkspaceMember(env, item.workspace_id, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }
    const body: any = await request.json();
    const {
      title,
      description,
      status,
      priority,
      tags,
      channelIds,
      startAt,
      endAt,
      isAllDay,
      isPrivate,
      assignedGroupId,
      assigneeUserIds
    } = body;

    const updates: string[] = [];
    const params: any[] = [];

    if (title !== undefined) { updates.push("title = ?"); params.push(title); }
    if (description !== undefined) { updates.push("description = ?"); params.push(description); }
    if (status !== undefined) { updates.push("status = ?"); params.push(status); }
    if (priority !== undefined) { updates.push("priority = ?"); params.push(priority); }
    if (tags !== undefined || channelIds !== undefined) {
      const normalTags = Array.isArray(tags) ? tags : [];
      const chanTags = (Array.isArray(channelIds) ? channelIds : []).map((cid: string) => `channel:${cid}`);
      const allTagsStr = [...normalTags, ...chanTags].join(',');
      updates.push("tags = ?");
      params.push(allTagsStr);
    }
    if (startAt !== undefined) { updates.push("start_at = ?"); params.push(startAt || null); }
    if (endAt !== undefined) { updates.push("end_at = ?"); params.push(endAt || null); }
    if (isAllDay !== undefined) { updates.push("is_all_day = ?"); params.push(isAllDay ? 1 : 0); }
    if (isPrivate !== undefined) { updates.push("is_private = ?"); params.push(isPrivate ? 1 : 0); }
    if (assignedGroupId !== undefined) { updates.push("assigned_group_id = ?"); params.push(assignedGroupId || null); }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      params.push(itemId);
      await env.DB.prepare(`UPDATE items SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
    }

    if (Array.isArray(assigneeUserIds)) {
      await env.DB.prepare("DELETE FROM item_assignees WHERE item_id = ?").bind(itemId).run();
      for (const aId of assigneeUserIds) {
        await env.DB.prepare("INSERT OR IGNORE INTO item_assignees (item_id, user_id) VALUES (?, ?)").bind(itemId, aId).run();
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to update item:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * アイテム（タスク/予定）を削除します。
 * DELETE /api/items/:itemId
 */
export async function handleDeleteItem(
  request: Request,
  env: Env,
  itemId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "DELETE, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const item = await env.DB.prepare(
      "SELECT workspace_id FROM items WHERE id = ?"
    ).bind(itemId).first<{ workspace_id: string }>();

    if (!item || !(await verifyWorkspaceMember(env, item.workspace_id, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }
    await env.DB.prepare("DELETE FROM items WHERE id = ?").bind(itemId).run();
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to delete item:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}
