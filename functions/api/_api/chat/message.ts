import type { Env } from "../../[[route]]";
import { linkFileToMessage } from "../files";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id",
};

// HTMLエスケープヘルパー
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// 危険なURLスキームの無害化ヘルパー
function sanitizeUrl(urlStr: string | null | undefined): string | null {
  if (!urlStr) return null;
  const parsed = urlStr.trim().toLowerCase();
  if (
    parsed.startsWith("javascript:") ||
    parsed.startsWith("data:") ||
    parsed.startsWith("vbscript:")
  ) {
    return "about:blank";
  }
  return urlStr;
}

// チャンネル個別アクセス権限のチェックヘルパー
export async function canAccessChannel(env: Env, channelId: string, userId: string): Promise<boolean> {
  try {
    const channel = await env.DB.prepare(
      "SELECT workspace_id as workspaceId, is_private as isPrivate, type, group_id as groupId FROM channels WHERE id = ?"
    ).bind(channelId).first<{ workspaceId: string; isPrivate: number; type: string; groupId: string | null }>();

    if (!channel) return false;

    // パブリックチャンネルなら全員OK
    if ((channel.type === 'channel' || !channel.type) && channel.isPrivate === 0) return true;

    // 自分が明示的に channel_members にいるならOK
    const isMember = await env.DB.prepare(
      "SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?"
    ).bind(channelId, userId).first();
    if (isMember) return true;

    // グループに紐づくチャンネルで、自分がそのグループのメンバーならOK
    if ((channel.type === 'channel' || !channel.type) && channel.groupId) {
      const isGroupMember = await env.DB.prepare(
        "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?"
      ).bind(channel.groupId, userId).first();
      if (isGroupMember) return true;
    }

    // ワークスペースのオーナー(owner)なら、DM以外の通常チャンネルはOK
    if (channel.type === 'channel' || !channel.type) {
      const member = await env.DB.prepare(
        "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
      ).bind(channel.workspaceId, userId).first<{ role: string }>();
      if (member?.role === 'owner') return true;
    }

    return false;
  } catch {
    return false;
  }
}

// メンション/DMによる通知レコードを作成するヘルパー
async function createMessageNotifications(
  env: Env,
  messageId: string,
  channelId: string,
  senderId: string,
  content: string
): Promise<void> {
  try {
    // チャンネルの最終更新日時を更新
    await env.DB.prepare(
      "UPDATE channels SET updated_at = datetime('now') WHERE id = ?"
    ).bind(channelId).run();

    const channel = await env.DB.prepare(
      "SELECT workspace_id as workspaceId, name, type, is_private as isPrivate FROM channels WHERE id = ?"
    ).bind(channelId).first<{ workspaceId: string; name: string; type: string; isPrivate: number }>();

    if (!channel) return;

    const sender = await env.DB.prepare(
      "SELECT display_name FROM users WHERE id = ?"
    ).bind(senderId).first<{ display_name: string }>();
    const senderName = sender?.display_name || "誰か";

    if (channel.type === "dm") {
      const { results: members } = await env.DB.prepare(
        "SELECT user_id as userId FROM channel_members WHERE channel_id = ? AND user_id != ?"
      ).bind(channelId, senderId).all<{ userId: string }>();

      const batch = members.map(m => {
        const notificationId = crypto.randomUUID();
        const title = `${senderName}さんからのダイレクトメッセージ`;
        const linkUrl = `/channels/${channelId}?msg=${messageId}`;
        return env.DB.prepare(
          "INSERT INTO notifications (id, workspace_id, user_id, sender_id, type, title, content, link_url) VALUES (?, ?, ?, ?, 'dm', ?, ?, ?)"
        ).bind(notificationId, channel.workspaceId, m.userId, senderId, title, content.substring(0, 100), linkUrl);
      });

      if (batch.length > 0) {
        await env.DB.batch(batch);
      }
      return;
    }

    const { results: wsMembers } = await env.DB.prepare(
      "SELECT u.id as userId, u.display_name as displayName FROM workspace_members wm JOIN users u ON wm.user_id = u.id WHERE wm.workspace_id = ?"
    ).bind(channel.workspaceId).all<{ userId: string; displayName: string }>();

    const targetUserIds = new Set<string>();

    if (content.includes("@all")) {
      wsMembers.forEach(m => {
        if (m.userId !== senderId) {
          targetUserIds.add(m.userId);
        }
      });
    } else {
      wsMembers.forEach(m => {
        if (m.userId !== senderId && content.includes(`@${m.displayName}`)) {
          targetUserIds.add(m.userId);
        }
      });
    }

    const batch = Array.from(targetUserIds).map(userId => {
      const notificationId = crypto.randomUUID();
      const title = `#${channel.name} でメンションされました`;
      const linkUrl = `/channels/${channelId}?msg=${messageId}`;
      return env.DB.prepare(
        "INSERT INTO notifications (id, workspace_id, user_id, sender_id, type, title, content, link_url) VALUES (?, ?, ?, ?, 'mention', ?, ?, ?)"
      ).bind(notificationId, channel.workspaceId, userId, senderId, title, content.substring(0, 100), linkUrl);
    });

    if (batch.length > 0) {
      await env.DB.batch(batch);
    }
  } catch (err) {
    console.error("Failed to create message notifications:", err);
  }
}

// メッセージ取得 API
export async function handleGetMessages(request: Request, env: Env, channelId: string): Promise<Response> {
  try {
    const url = new URL(request.url);
    const since = url.searchParams.get("since");
    const userId = request.headers.get("X-User-Id");

    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    // 認可チェック
    const hasAccess = await canAccessChannel(env, channelId, userId);
    if (!hasAccess) {
      return new Response(JSON.stringify({ error: "Permission denied" }), {
        status: 403,
        headers,
      });
    }

    let query = `
      SELECT 
        m.id, 
        m.channel_id as channelId, 
        m.user_id as userId, 
        m.parent_id as parentId, 
        m.content, 
        m.file_url as fileUrl, 
        m.file_name as fileName, 
        m.file_size as fileSize, 
        m.created_at as createdAt,
        u.display_name as userDisplayName,
        u.avatar_url as userAvatarUrl,
        pm.content as parentContent,
        pu.display_name as parentUserDisplayName,
        (SELECT COUNT(*) FROM messages r WHERE r.parent_id = m.id) as replyCount,
        (SELECT MAX(created_at) FROM messages r WHERE r.parent_id = m.id) as lastReplyAt,
        (
          SELECT json_group_array(
            json_object(
              'id', r.id,
              'emoji', r.emoji,
              'userId', r.user_id,
              'displayName', ru.display_name
            )
          )
          FROM reactions r
          LEFT JOIN users ru ON r.user_id = ru.id
          WHERE r.message_id = m.id
        ) as reactionsJson
      FROM messages m
      LEFT JOIN users u ON m.user_id = u.id
      LEFT JOIN messages pm ON m.parent_id = pm.id
      LEFT JOIN users pu ON pm.user_id = pu.id
      WHERE m.channel_id = ?
    `;

    const params: any[] = [channelId];

    if (since) {
      query += " AND m.created_at > ?";
      params.push(since);
    }

    query += " ORDER BY m.created_at ASC";

    const { results } = await env.DB.prepare(query).bind(...params).all<any>();

    const data = results.map((row: any) => ({
      id: row.id,
      channelId: row.channelId,
      userId: row.userId,
      parentId: row.parentId,
      parentMessage: row.parentId ? {
        content: row.parentContent || '',
        userDisplayName: row.parentUserDisplayName || 'Unknown User',
      } : null,
      content: row.content,
      fileUrl: row.fileUrl,
      fileName: row.fileName,
      fileSize: row.fileSize,
      status: 'sent',
      createdAt: row.createdAt,
      user: {
        id: row.userId,
        displayName: row.userDisplayName || 'Unknown User',
        avatarUrl: row.userAvatarUrl || undefined,
      },
      replyCount: row.replyCount || 0,
      lastReplyAt: row.lastReplyAt || null,
      reactions: row.reactionsJson ? JSON.parse(row.reactionsJson) : [],
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

// メッセージ作成 API
export async function handleCreateMessage(request: Request, env: Env, channelId: string): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");

    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    // 認可チェック
    const hasAccess = await canAccessChannel(env, channelId, userId);
    if (!hasAccess) {
      return new Response(JSON.stringify({ error: "Permission denied" }), {
        status: 403,
        headers,
      });
    }

    const body: any = await request.json();
    const { content, parentId, fileUrl, fileName, fileSize } = body;

    if (!content) {
      return new Response(JSON.stringify({ error: "Message content is required" }), {
        status: 400,
        headers,
      });
    }

    const sanitizedContent = escapeHtml(content);
    const sanitizedFileUrl = sanitizeUrl(fileUrl);

    const messageId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    await env.DB.prepare(
      "INSERT INTO messages (id, channel_id, user_id, parent_id, content, file_url, file_name, file_size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(messageId, channelId, userId, parentId || null, sanitizedContent, sanitizedFileUrl, fileName || null, fileSize || null, createdAt, createdAt).run();

    // 添付ファイルをメディアライブラリ（filesテーブル）に登録・更新
    await linkFileToMessage(env, sanitizedFileUrl, fileName, fileSize, channelId, messageId, userId);

    // 非同期で通知を作成（バックグラウンド実行）
    createMessageNotifications(env, messageId, channelId, userId, sanitizedContent).catch(err => {
      console.error("Failed to create message notifications:", err);
    });

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: messageId,
        createdAt,
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

// Generalメッセージ取得 API
export async function handleGetMessagesGeneral(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const channelId = url.searchParams.get("channel_id") || url.searchParams.get("channelId");
    const lastId = url.searchParams.get("last_id") || url.searchParams.get("lastId");
    const userId = request.headers.get("X-User-Id");

    if (!channelId) {
      return new Response(JSON.stringify({ error: "channel_id is required" }), {
        status: 400,
        headers,
      });
    }

    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    // 認可チェック
    const hasAccess = await canAccessChannel(env, channelId, userId);
    if (!hasAccess) {
      return new Response(JSON.stringify({ error: "Permission denied" }), {
        status: 403,
        headers,
      });
    }

    let query = `
      SELECT 
        m.id, 
        m.channel_id as channelId, 
        m.user_id as userId, 
        m.parent_id as parentId, 
        m.content, 
        m.file_url as fileUrl, 
        m.file_name as fileName, 
        m.file_size as fileSize, 
        m.created_at as createdAt,
        u.display_name as userDisplayName,
        u.avatar_url as userAvatarUrl,
        pm.content as parentContent,
        pu.display_name as parentUserDisplayName,
        (SELECT COUNT(*) FROM messages r WHERE r.parent_id = m.id) as replyCount,
        (SELECT MAX(created_at) FROM messages r WHERE r.parent_id = m.id) as lastReplyAt,
        (
          SELECT json_group_array(
            json_object(
              'id', r.id,
              'emoji', r.emoji,
              'userId', r.user_id,
              'displayName', ru.display_name
            )
          )
          FROM reactions r
          LEFT JOIN users ru ON r.user_id = ru.id
          WHERE r.message_id = m.id
        ) as reactionsJson
      FROM messages m
      LEFT JOIN users u ON m.user_id = u.id
      LEFT JOIN messages pm ON m.parent_id = pm.id
      LEFT JOIN users pu ON pm.user_id = pu.id
      WHERE m.channel_id = ?
    `;

    const params: any[] = [channelId];

    if (lastId) {
      const lastMsg = await env.DB.prepare(
        "SELECT created_at FROM messages WHERE id = ?"
      ).bind(lastId).first<{ created_at: string }>();

      if (lastMsg) {
        query += " AND m.created_at > ?";
        params.push(lastMsg.created_at);
      }
    }

    query += " ORDER BY m.created_at ASC";

    const { results } = await env.DB.prepare(query).bind(...params).all<any>();

    const data = results.map((row: any) => ({
      id: row.id,
      channelId: row.channelId,
      userId: row.userId,
      parentId: row.parentId,
      parentMessage: row.parentId ? {
        content: row.parentContent || '',
        userDisplayName: row.parentUserDisplayName || 'Unknown User',
      } : null,
      content: row.content,
      fileUrl: row.fileUrl,
      fileName: row.fileName,
      fileSize: row.fileSize,
      status: 'sent',
      createdAt: row.createdAt,
      user: {
        id: row.userId,
        displayName: row.userDisplayName || 'Unknown User',
        avatarUrl: row.userAvatarUrl || undefined,
      },
      replyCount: row.replyCount || 0,
      lastReplyAt: row.lastReplyAt || null,
      reactions: row.reactionsJson ? JSON.parse(row.reactionsJson) : [],
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

// Generalメッセージ作成 API
export async function handleCreateMessageGeneral(request: Request, env: Env): Promise<Response> {
  try {
    const body: any = await request.json();
    const { content, parentId, fileUrl, fileName, fileSize } = body;
    const channelId = body.channelId || body.channel_id;
    const userId = request.headers.get("X-User-Id");

    if (!channelId) {
      return new Response(JSON.stringify({ error: "channelId is required" }), {
        status: 400,
        headers,
      });
    }

    if (!content) {
      return new Response(JSON.stringify({ error: "Message content is required" }), {
        status: 400,
        headers,
      });
    }

    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    // 認可チェック
    const hasAccess = await canAccessChannel(env, channelId, userId);
    if (!hasAccess) {
      return new Response(JSON.stringify({ error: "Permission denied" }), {
        status: 403,
        headers,
      });
    }

    const sanitizedContent = escapeHtml(content);
    const sanitizedFileUrl = sanitizeUrl(fileUrl);

    const messageId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    await env.DB.prepare(
      "INSERT INTO messages (id, channel_id, user_id, parent_id, content, file_url, file_name, file_size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(messageId, channelId, userId, parentId || null, sanitizedContent, sanitizedFileUrl, fileName || null, fileSize || null, createdAt, createdAt).run();

    // 添付ファイルをメディアライブラリ（filesテーブル）に登録・更新
    await linkFileToMessage(env, sanitizedFileUrl, fileName, fileSize, channelId, messageId, userId);

    // 非同期で通知を作成（バックグラウンド実行）
    createMessageNotifications(env, messageId, channelId, userId, sanitizedContent).catch(err => {
      console.error("Failed to create message notifications:", err);
    });

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: messageId,
        createdAt,
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

// 絵文字リアクションの追加/削除（トグル）API
export async function handleToggleReaction(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/messages\/([^\/]+)\/reactions$/);
    if (!match) {
      return new Response(JSON.stringify({ error: "Invalid reaction URL" }), {
        status: 400,
        headers,
      });
    }
    const messageId = match[1];

    const body: any = await request.json();
    const { emoji } = body;
    const userId = request.headers.get("X-User-Id");

    if (!emoji) {
      return new Response(JSON.stringify({ error: "Emoji is required" }), {
        status: 400,
        headers,
      });
    }
    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    // メッセージが属するチャンネルIDと送信者を引いて認可チェック
    const msg = await env.DB.prepare(
      "SELECT channel_id as channelId, user_id as messageUserId FROM messages WHERE id = ?"
    ).bind(messageId).first<{ channelId: string; messageUserId: string }>();

    if (!msg) {
      return new Response(JSON.stringify({ error: "Message not found" }), {
        status: 404,
        headers,
      });
    }

    if (msg.messageUserId === userId) {
      return new Response(JSON.stringify({ error: "Cannot react to your own message" }), {
        status: 400,
        headers,
      });
    }

    const hasAccess = await canAccessChannel(env, msg.channelId, userId);
    if (!hasAccess) {
      return new Response(JSON.stringify({ error: "Permission denied" }), {
        status: 403,
        headers,
      });
    }

    // 既存の同一リアクションをチェック
    const existing = await env.DB.prepare(
      "SELECT id FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?"
    ).bind(messageId, userId, emoji).first();

    if (existing) {
      // 存在すれば削除（トグルオフ）
      await env.DB.prepare(
        "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?"
      ).bind(messageId, userId, emoji).run();

      return new Response(JSON.stringify({ success: true, action: "removed" }), {
        status: 200,
        headers,
      });
    } else {
      // 存在しなければ新規登録（トグルオン）
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO reactions (id, message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
      ).bind(id, messageId, userId, emoji).run();

      return new Response(JSON.stringify({ success: true, action: "added" }), {
        status: 201,
        headers,
      });
    }
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}
