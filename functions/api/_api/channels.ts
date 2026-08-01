import type { Env } from "../[[route]]";
import { verifyUserAuth, verifyWorkspaceMember, verifyChannelMember } from "../_utils/jwt";
import { getCorsHeaders } from "../_utils/cors";

/**
 * ワークスペースのチャンネル一覧を取得します。
 * GET /api/workspaces/:workspaceId/channels
 */
export async function handleGetWorkspaceChannels(
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
      return new Response(JSON.stringify({ error: "Forbidden: You are not a member of this workspace" }), { status: 403, headers });
    }
    const { results } = await env.DB.prepare(`
      SELECT 
        id, 
        workspace_id as workspaceId, 
        group_id as groupId, 
        name, 
        description, 
        is_private as isPrivate, 
        type, 
        document, 
        created_at as createdAt
      FROM channels 
      WHERE workspace_id = ?
      ORDER BY created_at ASC
    `).bind(workspaceId).all<any>();

    const mapped = (results || []).map((c: any) => ({
      ...c,
      isPrivate: Boolean(c.isPrivate),
    }));

    return new Response(JSON.stringify({
      success: true,
      data: mapped
    }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to fetch channels:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * チャンネル参加メンバー一覧を取得します。
 * GET /api/channels/:channelId/members
 */
export async function handleGetChannelMembers(
  request: Request,
  env: Env,
  channelId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "GET, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    if (!(await verifyChannelMember(env, channelId, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden: You do not have access to this channel" }), { status: 403, headers });
    }
    const { results } = await env.DB.prepare(`
      SELECT 
        u.id as userId,
        u.email,
        COALESCE(u.display_name, 'ユーザー') as displayName,
        u.avatar_url as avatarUrl,
        COALESCE(u.status, 'active') as status
      FROM channel_members cm
      JOIN users u ON cm.user_id = u.id
      WHERE cm.channel_id = ?
      ORDER BY u.display_name ASC
    `).bind(channelId).all<any>();

    return new Response(JSON.stringify({
      success: true,
      data: results || []
    }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to fetch channel members:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * チャンネルにメンバーを追加します。
 * POST /api/channels/:channelId/members
 */
export async function handleAddChannelMember(
  request: Request,
  env: Env,
  channelId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "POST, OPTIONS");

  try {
    const userIdAuth = await verifyUserAuth(request, env);
    if (!userIdAuth) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    if (!(await verifyChannelMember(env, channelId, userIdAuth))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }

    // 招待権限の検証: チャンネルが非公開の場合、招待者が該当チャンネルに所属しているか、またはワークスペース管理者(admin/owner)のみ許可
    const channel = await env.DB.prepare(
      "SELECT workspace_id, is_private FROM channels WHERE id = ?"
    ).bind(channelId).first<{ workspace_id: string; is_private: number }>();

    if (channel && channel.is_private === 1) {
      const isMemberOfChannel = await env.DB.prepare(
        "SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?"
      ).bind(channelId, userIdAuth).first();

      if (!isMemberOfChannel) {
        const member = await env.DB.prepare(
          "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
        ).bind(channel.workspace_id, userIdAuth).first<{ role: string }>();

        const isAdmin = member && (member.role === "admin" || member.role === "owner");
        if (!isAdmin) {
          return new Response(
            JSON.stringify({ error: "Forbidden: You cannot invite members to a private channel you do not belong to." }),
            { status: 403, headers }
          );
        }
      }
    }
    const body: any = await request.json();
    const { userId } = body;

    if (userId) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO channel_members (channel_id, user_id, created_at) VALUES (?, ?, datetime('now'))"
      ).bind(channelId, userId).run();
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to add channel member:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * チャンネルから特定のメンバーを削除（脱退）します。
 * DELETE /api/channels/:channelId/members/:userId
 */
export async function handleRemoveChannelMember(
  request: Request,
  env: Env,
  channelId: string,
  targetUserId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "DELETE, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    if (!(await verifyChannelMember(env, channelId, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }

    // 削除権限の検証: チャンネルが非公開かつ、他人のキックである場合、ワークスペース管理者(admin/owner)のみ許可
    const channel = await env.DB.prepare(
      "SELECT workspace_id, is_private FROM channels WHERE id = ?"
    ).bind(channelId).first<{ workspace_id: string; is_private: number }>();

    if (channel && channel.is_private === 1 && userId !== targetUserId) {
      const member = await env.DB.prepare(
        "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
      ).bind(channel.workspace_id, userId).first<{ role: string }>();

      const isAdmin = member && (member.role === "admin" || member.role === "owner");
      if (!isAdmin) {
        return new Response(
          JSON.stringify({ error: "Forbidden: Only workspace admins can remove other members from a private channel." }),
          { status: 403, headers }
        );
      }
    }

    await env.DB.prepare(
      "DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?"
    ).bind(channelId, targetUserId).run();

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to remove channel member:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * 参加可能なパブリックチャンネル一覧を取得（ブラウズ）します。
 * GET /api/workspaces/:workspaceId/browse-channels
 */
export async function handleBrowseChannels(
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
    const { results } = await env.DB.prepare(`
      SELECT 
        c.id, 
        c.workspace_id as workspaceId, 
        c.group_id as groupId, 
        c.name, 
        c.description, 
        c.is_private as isPrivate, 
        c.type, 
        c.created_at as createdAt,
        (SELECT COUNT(*) FROM channel_members cm WHERE cm.channel_id = c.id) as memberCount
      FROM channels c
      WHERE c.workspace_id = ? AND c.is_private = 0 AND c.type = 'channel'
      ORDER BY c.name ASC
    `).bind(workspaceId).all<any>();

    const mapped = (results || []).map((c: any) => ({
      ...c,
      isPrivate: false,
    }));

    return new Response(JSON.stringify({
      success: true,
      data: mapped
    }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to browse channels:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * 新規チャンネルを作成します。
 * POST /api/workspaces/:workspaceId/channels
 */
export async function handleCreateChannel(
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
    const { name, description = '', isPrivate = false, groupId = null } = body;

    if (!name) {
      return new Response(JSON.stringify({ error: "Channel name is required" }), {
        status: 400,
        headers,
      });
    }

    const channelId = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO channels (id, workspace_id, group_id, name, description, is_private, type, document, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'channel', '', ?, ?)
    `).bind(channelId, workspaceId, groupId || null, name, description, isPrivate ? 1 : 0, now, now).run();

    const newChannel = {
      id: channelId,
      workspaceId,
      groupId: groupId || null,
      name,
      description,
      isPrivate: Boolean(isPrivate),
      type: 'channel',
      document: '',
      createdAt: now,
    };

    return new Response(JSON.stringify({
      success: true,
      data: newChannel
    }), {
      status: 201,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to create channel:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * チャンネル情報を更新します。
 * PUT /api/channels/:channelId
 */
export async function handleUpdateChannel(
  request: Request,
  env: Env,
  channelId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "PUT, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    if (!(await verifyChannelMember(env, channelId, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }

    // 設定変更の権限検証: ワークスペース管理者(admin/owner)のみ許可
    const channel = await env.DB.prepare(
      "SELECT workspace_id FROM channels WHERE id = ?"
    ).bind(channelId).first<{ workspace_id: string }>();

    if (channel) {
      const member = await env.DB.prepare(
        "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
      ).bind(channel.workspace_id, userId).first<{ role: string }>();

      const isAdmin = member && (member.role === "admin" || member.role === "owner");
      if (!isAdmin) {
        return new Response(
          JSON.stringify({ error: "Forbidden: Only workspace admins can modify channel settings." }),
          { status: 403, headers }
        );
      }
    }
    const body: any = await request.json();
    const { name, description, isPrivate } = body;

    const updates: string[] = [];
    const params: any[] = [];

    if (name !== undefined) { updates.push("name = ?"); params.push(name); }
    if (description !== undefined) { updates.push("description = ?"); params.push(description); }
    if (isPrivate !== undefined) { updates.push("is_private = ?"); params.push(isPrivate ? 1 : 0); }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      params.push(channelId);
      await env.DB.prepare(`UPDATE channels SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
    }

    const updated = await env.DB.prepare(`
      SELECT id, workspace_id as workspaceId, group_id as groupId, name, description, is_private as isPrivate, type, created_at as createdAt
      FROM channels WHERE id = ?
    `).bind(channelId).first<any>();

    return new Response(JSON.stringify({
      success: true,
      data: updated ? { ...updated, isPrivate: Boolean(updated.isPrivate) } : null
    }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to update channel:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * チャンネルに参加します。
 * POST /api/channels/:channelId/join
 */
export async function handleJoinChannel(
  request: Request,
  env: Env,
  channelId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "POST, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    if (!(await verifyChannelMember(env, channelId, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }

    if (userId) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO channel_members (channel_id, user_id, created_at) VALUES (?, ?, datetime('now'))"
      ).bind(channelId, userId).run();
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to join channel:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * チャンネルから脱退します。
 * POST /api/channels/:channelId/leave
 */
export async function handleLeaveChannel(
  request: Request,
  env: Env,
  channelId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "POST, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    if (!(await verifyChannelMember(env, channelId, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }

    if (userId) {
      await env.DB.prepare(
        "DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?"
      ).bind(channelId, userId).run();
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to leave channel:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * チャンネルを削除します。
 * DELETE /api/channels/:channelId
 */
export async function handleDeleteChannel(
  request: Request,
  env: Env,
  channelId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "DELETE, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    if (!(await verifyChannelMember(env, channelId, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }
    await env.DB.prepare("DELETE FROM channels WHERE id = ?").bind(channelId).run();
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to delete channel:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * メッセージ一覧を取得します。
 * GET /api/messages?channel_id=...&before=...&since=...&limit=...
 */
export async function handleGetMessages(
  request: Request,
  env: Env
): Promise<Response> {
  const headers = getCorsHeaders(request, "GET, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const url = new URL(request.url);
    const channelId = url.searchParams.get("channel_id");
    const before = url.searchParams.get("before");
    const since = url.searchParams.get("since");
    const limitStr = url.searchParams.get("limit") || "50";
    const limit = parseInt(limitStr, 10) || 50;

    if (!channelId) {
      return new Response(JSON.stringify({ error: "channel_id is required" }), {
        status: 400,
        headers,
      });
    }

    if (!(await verifyChannelMember(env, channelId, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }


    let sql = `
      SELECT 
        m.id, 
        m.channel_id as channelId, 
        m.user_id as userId, 
        COALESCE(u.display_name, 'ユーザー') as userName, 
        u.avatar_url as userAvatar, 
        m.parent_id as parentId, 
        m.content, 
        m.file_url as fileUrl, 
        m.file_name as fileName, 
        m.file_size as fileSize, 
        m.created_at as createdAt, 
        m.updated_at as updatedAt
      FROM messages m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = ?
    `;

    const paramsArr: any[] = [channelId];

    if (before) {
      sql += ` AND m.created_at < ?`;
      paramsArr.push(before);
    }

    if (since) {
      sql += ` AND m.id > ?`;
      paramsArr.push(since);
    }

    sql += ` ORDER BY m.created_at ASC LIMIT ?`;
    paramsArr.push(limit);

    const { results: rawMessages } = await env.DB.prepare(sql).bind(...paramsArr).all<any>();

    const messages = rawMessages || [];
    if (messages.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        data: []
      }), {
        status: 200,
        headers,
      });
    }

    const messageIds = messages.map((m: any) => m.id);
    const placeholders = messageIds.map(() => '?').join(',');
    const { results: rawReactions } = await env.DB.prepare(`
      SELECT r.id, r.message_id, r.emoji, r.user_id, COALESCE(u.display_name, 'ユーザー') as display_name
      FROM reactions r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.message_id IN (${placeholders})
    `).bind(...messageIds).all<any>();

    const reactionsMap: Record<string, any[]> = {};
    if (rawReactions) {
      for (const r of rawReactions) {
        if (!reactionsMap[r.message_id]) {
          reactionsMap[r.message_id] = [];
        }
        reactionsMap[r.message_id].push({
          id: r.id,
          emoji: r.emoji,
          userId: r.user_id,
          displayName: r.display_name,
        });
      }
    }

    const formattedMessages = messages.map((m: any) => ({
      id: m.id,
      channelId: m.channelId,
      userId: m.userId,
      parentId: m.parentId || null,
      content: m.content || '',
      fileUrl: m.fileUrl || null,
      fileName: m.fileName || null,
      fileSize: m.fileSize || null,
      status: 'sent',
      createdAt: m.createdAt,
      user: {
        id: m.userId,
        displayName: m.userName || 'ユーザー',
        avatarUrl: m.userAvatar || null,
      },
      reactions: reactionsMap[m.id] || [],
    }));

    return new Response(JSON.stringify({
      success: true,
      data: formattedMessages
    }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to fetch messages:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * メッセージを送信します。
 * POST /api/messages
 */
export async function handleSendMessage(
  request: Request,
  env: Env
): Promise<Response> {
  const headers = getCorsHeaders(request, "POST, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized: User ID missing" }), {
        status: 401,
        headers,
      });
    }

    const body: any = await request.json();
    const { channelId, content, parentId = null, fileUrl = null, fileName = null, fileSize = null } = body;

    if (!channelId || (!content && !fileUrl)) {
      return new Response(JSON.stringify({ error: "channelId and content/file are required" }), {
        status: 400,
        headers,
      });
    }

    if (!(await verifyChannelMember(env, channelId, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden: You do not have access to this channel" }), { status: 403, headers });
    }

    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO messages (id, channel_id, user_id, parent_id, content, file_url, file_name, file_size, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(messageId, channelId, userId, parentId || null, content || '', fileUrl, fileName, fileSize, now, now).run();

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: messageId,
        createdAt: now,
      }
    }), {
      status: 201,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to send message:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * メッセージを削除します。
 * DELETE /api/messages/:messageId
 */
export async function handleDeleteMessage(
  request: Request,
  env: Env,
  messageId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "DELETE, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const msg = await env.DB.prepare(
      "SELECT user_id, channel_id FROM messages WHERE id = ?"
    ).bind(messageId).first<{ user_id: string; channel_id: string }>();

    if (!msg) {
      return new Response(JSON.stringify({ error: "Message not found" }), { status: 404, headers });
    }

    if (!(await verifyChannelMember(env, msg.channel_id, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }

    // 削除権限の検証: 送信者本人、またはワークスペース管理者(admin/owner)のみ許可
    if (msg.user_id !== userId) {
      const channel = await env.DB.prepare(
        "SELECT workspace_id FROM channels WHERE id = ?"
      ).bind(msg.channel_id).first<{ workspace_id: string }>();

      let isAdmin = false;
      if (channel) {
        const member = await env.DB.prepare(
          "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
        ).bind(channel.workspace_id, userId).first<{ role: string }>();
        if (member && (member.role === "admin" || member.role === "owner")) {
          isAdmin = true;
        }
      }

      if (!isAdmin) {
        return new Response(JSON.stringify({ error: "Forbidden: You cannot delete other users' messages." }), { status: 403, headers });
      }
    }

    await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(messageId).run();
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to delete message:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * メッセージにリアクションを追加します。
 * POST /api/messages/:messageId/reactions
 */
export async function handleAddReaction(
  request: Request,
  env: Env,
  messageId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "POST, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized: User ID missing" }), {
        status: 401,
        headers,
      });
    }

    const msg = await env.DB.prepare(
      "SELECT channel_id FROM messages WHERE id = ?"
    ).bind(messageId).first<{ channel_id: string }>();

    if (!msg || !(await verifyChannelMember(env, msg.channel_id, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }

    const body: any = await request.json();
    const { emoji } = body;

    if (!emoji) {
      return new Response(JSON.stringify({ error: "Emoji is required" }), {
        status: 400,
        headers,
      });
    }

    const reactionId = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(`
      INSERT OR IGNORE INTO reactions (id, message_id, user_id, emoji, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(reactionId, messageId, userId, emoji, now).run();

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to add reaction:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * メッセージからリアクションを削除します。
 * DELETE /api/messages/:messageId/reactions/:emoji
 */
export async function handleDeleteReaction(
  request: Request,
  env: Env,
  messageId: string,
  emoji: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "DELETE, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const msg = await env.DB.prepare(
      "SELECT channel_id FROM messages WHERE id = ?"
    ).bind(messageId).first<{ channel_id: string }>();

    if (!msg || !(await verifyChannelMember(env, msg.channel_id, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }

    if (userId) {
      const decodedEmoji = decodeURIComponent(emoji);
      await env.DB.prepare(
        "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?"
      ).bind(messageId, userId, decodedEmoji).run();
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to delete reaction:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}
