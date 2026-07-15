import type { Env } from "../../[[route]]";
import { linkFileToMessage } from "../files";
import { sendWebPush } from "../../_utils/webpush";
import { sendMail, getSmtpSettings } from "../../_utils/smtp";

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

// 複数のユーザー宛に Web Push を非同期で送信するヘルパー
// 複数のユーザー宛に Web Push を非同期で送信するヘルパー
export async function sendPushToUsers(
  env: Env,
  userIds: string[],
  title: string,
  bodyText: string,
  linkUrl: string
): Promise<{ userId: string; success: boolean; error?: string }[]> {
  try {
    if (userIds.length === 0) return [];

    // 1. D1からVAPIDキーを取得
    const vapidKey = await env.DB.prepare(
      "SELECT public_key, private_key FROM push_vapid_key WHERE id = 1"
    ).first<{ public_key: string; private_key: string }>();

    if (!vapidKey) {
      console.log("Web Push: VAPID keys not generated yet. Skipping push notification.");
      return userIds.map(id => ({ userId: id, success: false, error: "VAPID keys not generated yet" }));
    }

    // 2. 送信対象ユーザーのサブスクリプションをすべて取得
    const placeholders = userIds.map(() => "?").join(",");
    const { results: subscriptions } = await env.DB.prepare(
      `SELECT user_id as userId, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${placeholders})`
    )
      .bind(...userIds)
      .all<{ userId: string; endpoint: string; p256dh: string; auth: string }>();

    if (!subscriptions || subscriptions.length === 0) {
      return userIds.map(id => ({ userId: id, success: false, error: "No active push subscription found in DB" }));
    }

    // 管理者（または最初のユーザー）のメールアドレスを取得して VAPID の sub に使用する（実在しないローカルドメインによるFCMのBadJwtTokenエラー防止）
    const adminUser = await env.DB.prepare(
      "SELECT email FROM users LIMIT 1"
    ).first<{ email: string }>();
    const adminEmail = adminUser?.email || "admin@cohive.dev";
    const subject = `mailto:${adminEmail}`;

    // 3. 各サブスクリプションへプッシュ通知を送信
    const payload = JSON.stringify({
      title,
      body: bodyText,
      linkUrl
    });

    const pushPromises = subscriptions.map(async (sub) => {
      try {
        const subFormat = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        };
        const res = await sendWebPush(subFormat, payload, {
          publicKey: vapidKey.public_key,
          privateKey: vapidKey.private_key
        }, subject);

        if (res.status >= 400) {
          const errText = await res.text().catch(() => "");
          throw new Error(`Push service returned status ${res.status}: ${errText}`);
        }

        // 購読切れ（410 Gone / 404 Not Found）の場合はDBから削除する
        if (res.status === 410 || res.status === 404) {
          console.log(`Web Push: Subscription expired (${res.status}). Removing from DB.`);
          await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
            .bind(sub.endpoint)
            .run();
        }
        return { userId: sub.userId, success: true };
      } catch (err: any) {
        console.error(`Failed to send web push to user ${sub.userId}:`, err);
        return { userId: sub.userId, success: false, error: err.message || String(err) };
      }
    });

    return await Promise.all(pushPromises);
  } catch (err: any) {
    console.error("Failed in sendPushToUsers:", err);
    return userIds.map(id => ({ userId: id, success: false, error: err.message || String(err) }));
  }
}

// メンション/DMによる通知レコードを作成するヘルパー
async function createMessageNotifications(
  env: Env,
  messageId: string,
  channelId: string,
  senderId: string,
  content: string,
  requestUrl?: string
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
        "SELECT cm.user_id as userId, u.email, u.last_active_at as lastActiveAt, u.display_name as displayName FROM channel_members cm JOIN users u ON cm.user_id = u.id WHERE cm.channel_id = ? AND cm.user_id != ?"
      ).bind(channelId, senderId).all<{ userId: string; email: string; lastActiveAt: string | null; displayName: string }>();

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
        // Web Push を送信
        const userIds = members.map(m => m.userId);
        const title = `${senderName}さんからのダイレクトメッセージ`;
        const linkUrl = `/channels/${channelId}?msg=${messageId}`;
        await sendPushToUsers(env, userIds, title, content.substring(0, 100), linkUrl);

        // オフラインメール通知を送信（SMTP設定が有効な場合）
        if (requestUrl) {
          sendOfflineMailNotifications(
            env,
            members,
            senderName,
            title,
            content,
            linkUrl,
            requestUrl
          ).catch(err => console.error("Offline mail sending failed:", err));
        }
      }
      return;
    }

    const { results: wsMembers } = await env.DB.prepare(
      "SELECT u.id as userId, u.display_name as displayName, u.email, u.last_active_at as lastActiveAt FROM workspace_members wm JOIN users u ON wm.user_id = u.id WHERE wm.workspace_id = ?"
    ).bind(channel.workspaceId).all<{ userId: string; displayName: string; email: string; lastActiveAt: string | null }>();

    console.log(`[Mention Debug] wsMembers count: ${wsMembers.length}, workspaceId: ${channel.workspaceId}`);

    const targetUserIds = new Set<string>();
    
    // HTMLエスケープの影響を排除したプレーンなテキストでも照合
    const plainContent = content
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'");

    if (content.includes("@all") || plainContent.includes("@all")) {
      wsMembers.forEach(m => {
        // テスト検証を容易にするため、自分宛ての通知制限を解除
        targetUserIds.add(m.userId);
      });
    } else {
      wsMembers.forEach(m => {
        const name = m.displayName || m.email.split('@')[0];
        console.log(`[Mention Debug] Checking member: ${name} (userId: ${m.userId}) against content: "${content}"`);
        if (content.includes(`@${name}`) || plainContent.includes(`@${name}`)) {
          targetUserIds.add(m.userId);
          console.log(`[Mention Debug] Match found for: ${name}`);
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
      console.log(`[Mention Debug] Notification DB batch insert successful. Count: ${batch.length}`);
      
      // Web Push を送信
      const userIds = Array.from(targetUserIds);
      const title = `#${channel.name} でメンションされました`;
      const linkUrl = `/channels/${channelId}?msg=${messageId}`;
      await sendPushToUsers(env, userIds, title, content.substring(0, 100), linkUrl);
      console.log(`[Mention Debug] Web Push sent to users: ${userIds.join(", ")}`);

      // オフラインメール通知を送信（SMTP設定が有効な場合）
      if (requestUrl) {
        const targetMembers = wsMembers.filter(m => targetUserIds.has(m.userId));
        sendOfflineMailNotifications(
          env,
          targetMembers,
          senderName,
          title,
          content,
          linkUrl,
          requestUrl
        ).catch(err => console.error("Offline mail sending failed:", err));
      }
    } else {
      console.log("[Mention Debug] No target users matched for notification.");
    }
  } catch (err) {
    console.error("Failed to create message notifications:", err);
  }
}

// オフラインの通知対象者へメールを送信するヘルパー
async function sendOfflineMailNotifications(
  env: Env,
  recipients: { email: string; lastActiveAt: string | null; displayName: string }[],
  senderName: string,
  title: string,
  contentSnippet: string,
  linkUrl: string,
  requestUrl: string
): Promise<void> {
  try {
    const smtpSettings = await getSmtpSettings(env);
    if (!smtpSettings) return; // SMTP設定が無効な場合は早期リターン

    const now = Date.now();
    const offlineThreshold = 5 * 60 * 1000; // 5分

    // オフライン判定された受信者のみ抽出
    const offlineRecipients = recipients.filter(r => {
      if (!r.lastActiveAt) return true;
      const lastActive = new Date(r.lastActiveAt).getTime();
      return (now - lastActive) > offlineThreshold;
    });

    if (offlineRecipients.length === 0) return;

    const url = new URL(requestUrl);
    const fullLinkUrl = `${url.protocol}//${url.host}${linkUrl}`;
    const snippet = contentSnippet.length > 100 ? contentSnippet.substring(0, 100) + "..." : contentSnippet;

    const mailPromises = offlineRecipients.map(async (r) => {
      try {
        await sendMail(smtpSettings, {
          to: r.email,
          subject: `[CoHive] ${title}`,
          text: `こんにちは、${r.displayName}さん。\n\nCoHiveにて新しい通知があります。\n\n件名: ${title}\n送信者: ${senderName}\n内容:\n${snippet}\n\n以下のリンクから確認してください。\n${fullLinkUrl}`,
          html: `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eaeaea; border-radius: 5px; max-width: 600px; margin: 0 auto; color: #333;">
              <h2 style="color: #4f46e5; margin-top: 0; font-size: 18px; border-bottom: 2px solid #4f46e5; padding-bottom: 8px;">CoHive 通知</h2>
              <p>こんにちは、<strong>${r.displayName}</strong> さん。</p>
              <p>${title}</p>
              <div style="background: #f9fafb; padding: 15px; border-left: 4px solid #4f46e5; margin: 15px 0; font-size: 14px; white-space: pre-wrap; color: #444;">
                <strong>${senderName}</strong>: ${escapeHtml(snippet)}
              </div>
              <div style="margin: 25px 0; text-align: center;">
                <a href="${fullLinkUrl}" style="background: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold; font-size: 14px; box-shadow: 0 2px 4px rgba(79, 70, 229, 0.2);">
                   通知を確認する
                </a>
              </div>
              <p style="color: #9ca3af; font-size: 11px; margin-top: 25px; border-top: 1px solid #eee; padding-top: 10px; text-align: center;">
                ※本メールは自動送信されています。返信は受け付けておりません。
              </p>
            </div>
          `
        });
      } catch (err) {
        console.error(`Failed to send offline notification mail to ${r.email}:`, err);
      }
    });

    await Promise.all(mailPromises);
  } catch (err) {
    console.error("Failed in sendOfflineMailNotifications:", err);
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
        CASE WHEN EXISTS(SELECT 1 FROM message_pins mp WHERE mp.message_id = m.id) THEN 1 ELSE 0 END as isPinned,
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
      isPinned: row.isPinned === 1,
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

    // 通知を作成
    try {
      await createMessageNotifications(env, messageId, channelId, userId, sanitizedContent, request.url);
    } catch (err) {
      console.error("Failed to create message notifications:", err);
    }

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
        (CASE WHEN pin.message_id IS NOT NULL THEN 1 ELSE 0 END) as isPinned,
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
      LEFT JOIN message_pins pin ON m.id = pin.message_id
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
      isPinned: !!row.isPinned,
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

    // 通知を作成
    try {
      await createMessageNotifications(env, messageId, channelId, userId, sanitizedContent, request.url);
    } catch (err) {
      console.error("Failed to create message notifications:", err);
    }

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
