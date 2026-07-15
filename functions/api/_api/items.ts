import type { Env } from "../[[route]]";
import { canAccessChannel, sendPushToUsers } from "./chat/message";

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

// ユーザーがワークスペースのオーナーかどうかを確認するヘルパー
async function isWorkspaceOwner(env: Env, workspaceId: string, userId: string): Promise<boolean> {
  try {
    const member = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, userId).first<{ role: string }>();
    return member?.role === "owner";
  } catch {
    return false;
  }
}

// ユーザーの表示名を取得するヘルパー
async function getUserDisplayName(env: Env, userId: string): Promise<string> {
  try {
    const user = await env.DB.prepare(
      "SELECT display_name FROM users WHERE id = ?"
    ).bind(userId).first<{ display_name: string }>();
    return user?.display_name || "未知のユーザー";
  } catch {
    return "未知のユーザー";
  }
}

// タスク通知レコードを作成するヘルパー
async function createTaskNotifications(
  env: Env,
  itemId: string,
  workspaceId: string,
  senderId: string,
  type: "assign" | "task_done",
  extraData?: { title?: string }
): Promise<void> {
  try {
    const item = await env.DB.prepare(
      "SELECT creator_id as creatorId, title FROM items WHERE id = ?"
    ).bind(itemId).first<{ creatorId: string; title: string }>();

    if (!item) return;

    const sender = await env.DB.prepare(
      "SELECT display_name FROM users WHERE id = ?"
    ).bind(senderId).first<{ display_name: string }>();
    const senderName = sender?.display_name || "誰か";

    const { results: assignees } = await env.DB.prepare(
      "SELECT user_id as userId FROM item_assignees WHERE item_id = ?"
    ).bind(itemId).all<{ userId: string }>();

    const targetUserIds = new Set<string>();

    if (type === "assign") {
      assignees.forEach(a => {
        if (a.userId !== senderId) {
          targetUserIds.add(a.userId);
        }
      });

      const batch = Array.from(targetUserIds).map(userId => {
        const notificationId = crypto.randomUUID();
        const title = `タスクにアサインされました`;
        const content = `${senderName} さんがあなたをタスク「${item.title}」の担当者にアサインしました。`;
        const linkUrl = `/items?item=${itemId}`;
        return env.DB.prepare(
          "INSERT INTO notifications (id, workspace_id, user_id, sender_id, type, title, content, link_url) VALUES (?, ?, ?, ?, 'assign', ?, ?, ?)"
        ).bind(notificationId, workspaceId, userId, senderId, title, content, linkUrl);
      });

      if (batch.length > 0) {
        await env.DB.batch(batch);
        
        // Web Push の送信を追加
        const userIds = Array.from(targetUserIds);
        const title = `タスクにアサインされました`;
        const content = `${senderName} さんがあなたをタスク「${item.title}」の担当者にアサインしました。`;
        const linkUrl = `/items?item=${itemId}`;
        await sendPushToUsers(env, userIds, title, content, linkUrl);
      }
    } else if (type === "task_done") {
      if (item.creatorId !== senderId) {
        targetUserIds.add(item.creatorId);
      }
      assignees.forEach(a => {
        if (a.userId !== senderId) {
          targetUserIds.add(a.userId);
        }
      });

      const batch = Array.from(targetUserIds).map(userId => {
        const notificationId = crypto.randomUUID();
        const title = `タスクが完了しました`;
        const content = `${senderName} さんがタスク「${item.title || extraData?.title}」を完了（Done）にしました。`;
        const linkUrl = `/items?item=${itemId}`;
        return env.DB.prepare(
          "INSERT INTO notifications (id, workspace_id, user_id, sender_id, type, title, content, link_url) VALUES (?, ?, ?, ?, 'task_done', ?, ?, ?)"
        ).bind(notificationId, workspaceId, userId, senderId, title, content, linkUrl);
      });

      if (batch.length > 0) {
        await env.DB.batch(batch);
        
        // Web Push の送信を追加
        const userIds = Array.from(targetUserIds);
        const title = `タスクが完了しました`;
        const content = `${senderName} さんがタスク「${item.title || extraData?.title}」を完了（Done）にしました。`;
        const linkUrl = `/items?item=${itemId}`;
        await sendPushToUsers(env, userIds, title, content, linkUrl);
      }
    }
  } catch (err) {
    console.error("Failed to create task notifications:", err);
  }
}


// 1. アイテム一覧取得
export async function handleGetItems(request: Request, env: Env, workspaceId: string): Promise<Response> {
  try {
    const url = new URL(request.url);
    const filter = url.searchParams.get("filter") || "all"; // all, mine, created
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    const userId = request.headers.get("X-User-Id");

    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    const isGlobal = workspaceId === "all";

    const member = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(isGlobal ? "" : workspaceId, userId).first<{ role: string }>();
    const userRole = member?.role || 'member';

    const channelId = url.searchParams.get("channelId") || url.searchParams.get("channel_id");

    if (userRole === 'guest' && !channelId) {
      return new Response(JSON.stringify({ error: "Access denied for guests on global tasks" }), {
        status: 403,
        headers,
      });
    }

    if (channelId) {
      const hasChanAccess = await canAccessChannel(env, channelId, userId);
      if (!hasChanAccess) {
        return new Response(JSON.stringify({ error: "Forbidden: No access to this channel" }), {
          status: 403,
          headers,
        });
      }
    }

    // 1. アイテム本体の取得クエリ構築
    let query = `
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
        i.created_at as createdAt,
        uc.display_name as creatorName,
        w.name as workspaceName
      FROM items i
      LEFT JOIN users uc ON i.creator_id = uc.id
      LEFT JOIN workspaces w ON i.workspace_id = w.id
      WHERE ${isGlobal ? "1=1" : "i.workspace_id = ?"}
    `;

    const params: any[] = [];
    if (!isGlobal) {
      params.push(workspaceId);
    }

    if (channelId) {
      query += " AND i.id IN (SELECT item_id FROM item_channels WHERE channel_id = ?)";
      params.push(channelId);
    }

    // プライベート表示の制限（作成者、アサインされている担当者、またはオーナーのみ閲覧可能）
    query += " AND (i.is_private = 0 OR i.creator_id = ? OR i.id IN (SELECT item_id FROM item_assignees WHERE user_id = ?))";
    params.push(userId, userId);

    // フィルターの適用
    if (filter === "mine") {
      query += " AND i.id IN (SELECT item_id FROM item_assignees WHERE user_id = ?)";
      params.push(userId);
    } else if (filter === "created") {
      query += " AND i.creator_id = ?";
      params.push(userId);
    }

    // カレンダー用の期間フィルター
    if (start) {
      query += " AND i.start_at >= ?";
      params.push(start);
    }
    if (end) {
      query += " AND i.end_at <= ?";
      params.push(end);
    }

    query += " ORDER BY i.created_at DESC";

    // 2. 関連する担当者とチャンネルの一括取得クエリ
    const itemsQuery = env.DB.prepare(query).bind(...params);

    const assigneesQuery = env.DB.prepare(`
      SELECT 
        ia.item_id as itemId,
        ia.user_id as userId,
        u.display_name as displayName,
        u.avatar_url as avatarUrl
      FROM item_assignees ia
      JOIN users u ON ia.user_id = u.id
      WHERE ia.item_id IN (
        SELECT id FROM items WHERE workspace_id = ?
      )
    `).bind(workspaceId);

    const channelsQuery = env.DB.prepare(`
      SELECT 
        ic.item_id as itemId,
        ic.channel_id as channelId,
        c.name as name
      FROM item_channels ic
      JOIN channels c ON ic.channel_id = c.id
      WHERE ic.item_id IN (
        SELECT id FROM items WHERE workspace_id = ?
      )
    `).bind(workspaceId);

    // バッチ実行によるパフォーマンス向上
    const [itemsRes, assigneesRes, channelsRes] = await env.DB.batch([
      itemsQuery,
      assigneesQuery,
      channelsQuery
    ]);

    // 3. 担当者とチャンネルをマップに整理
    const assigneesMap: Record<string, any[]> = {};
    for (const row of assigneesRes.results as any[]) {
      if (!assigneesMap[row.itemId]) assigneesMap[row.itemId] = [];
      assigneesMap[row.itemId].push({
        userId: row.userId,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl || null
      });
    }

    const channelsMap: Record<string, any[]> = {};
    for (const row of channelsRes.results as any[]) {
      if (!channelsMap[row.itemId]) channelsMap[row.itemId] = [];
      channelsMap[row.itemId].push({
        id: row.channelId,
        name: row.name
      });
    }

    // 4. 返却用オブジェクトの整形（閲覧権限チェックを適用）
    const data: any[] = [];
    const isOwner = await isWorkspaceOwner(env, workspaceId, userId);

    for (const row of itemsRes.results as any[]) {
      const itemAssignees = assigneesMap[row.id] || [];
      const itemChannels = channelsMap[row.id] || [];
      
      const isCreator = row.creatorId === userId;
      const isAssignee = itemAssignees.some((a: any) => a.userId === userId);
      
      // チャンネル連動セキュリティのチェック
      if (itemChannels.length > 0) {
        if (!isCreator && !isAssignee && !isOwner) {
          let hasChannelAccess = false;
          for (const chan of itemChannels) {
            if (await canAccessChannel(env, chan.id, userId)) {
              hasChannelAccess = true;
              break;
            }
          }
          if (!hasChannelAccess) {
            continue; // 閲覧不可のため除外
          }
        }
      }

      data.push({
        id: row.id,
        workspaceId: row.workspaceId,
        creatorId: row.creatorId,
        creatorName: row.creatorName || "Unknown",
        assignees: itemAssignees,
        channels: itemChannels,
        title: row.title,
        description: row.description || "",
        status: row.status,
        priority: row.priority || "none",
        tags: row.tags ? row.tags.split(",").filter(Boolean) : [],
        startAt: row.startAt || null,
        endAt: row.endAt || null,
        isAllDay: row.isAllDay === 1,
        isPrivate: row.isPrivate === 1,
        createdAt: row.createdAt,
      });
    }
 
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

// 2. アイテム新規登録
export async function handleCreateItem(request: Request, env: Env, workspaceId: string): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    const body: any = await request.json();
    const { title, description, assigneeIds, status, startAt, endAt, isAllDay, isPrivate, channelIds, priority, tags } = body;

    const member = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, userId).first<{ role: string }>();
    const userRole = member?.role || 'member';

    if (userRole === 'guest') {
      if (!Array.isArray(channelIds) || channelIds.length === 0) {
        return new Response(JSON.stringify({ error: "Guests must associate tasks with at least one channel" }), {
          status: 403,
          headers,
        });
      }
      for (const chId of channelIds) {
        const isChanMem = await env.DB.prepare(
          "SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?"
        ).bind(chId, userId).first();
        if (!isChanMem) {
          return new Response(JSON.stringify({ error: "Forbidden: You are not a member of the associated channel" }), {
            status: 403,
            headers,
          });
        }
      }
    }

    if (!title) {
      return new Response(JSON.stringify({ error: "Title is required" }), {
        status: 400,
        headers,
      });
    }

    const sanitizedTitle = escapeHtml(title);
    const sanitizedDescription = description ? escapeHtml(description) : null;

    const itemId = crypto.randomUUID();
    const itemStatus = status || "todo";
    const isAllDayInt = isAllDay ? 1 : 0;
    const isPrivateInt = isPrivate ? 1 : 0;
    const createdAt = new Date().toISOString();
    const itemPriority = priority || "none";
    const itemTagsStr = Array.isArray(tags) ? tags.filter(Boolean).join(",") : (tags || "");

    // 1. アイテム本体の保存
    const insertItem = env.DB.prepare(`
      INSERT INTO items (
        id, workspace_id, creator_id, title, description, status, priority, tags, start_at, end_at, is_all_day, is_private, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      itemId,
      workspaceId,
      userId,
      sanitizedTitle,
      sanitizedDescription,
      itemStatus,
      itemPriority,
      itemTagsStr,
      startAt || null,
      endAt || null,
      isAllDayInt,
      isPrivateInt,
      createdAt,
      createdAt
    );

    const batchStatements = [insertItem];

    // 2. 複数担当者の登録
    if (Array.isArray(assigneeIds) && assigneeIds.length > 0) {
      for (const aId of assigneeIds) {
        if (aId && aId !== "null") {
          batchStatements.push(
            env.DB.prepare("INSERT INTO item_assignees (item_id, user_id) VALUES (?, ?)")
              .bind(itemId, aId)
          );
        }
      }
    }

    // 3. 複数関連チャンネルの登録
    if (Array.isArray(channelIds) && channelIds.length > 0) {
      for (const cId of channelIds) {
        if (cId && cId !== "null") {
          batchStatements.push(
            env.DB.prepare("INSERT INTO item_channels (item_id, channel_id) VALUES (?, ?)")
              .bind(itemId, cId)
          );
        }
      }
    }

    await env.DB.batch(batchStatements);

    // アサイン通知の送信
    await createTaskNotifications(env, itemId, workspaceId, userId, "assign");

    // 4. 複数チャンネルへの自動通知（非公開設定でない場合）
    if (isPrivateInt === 0 && Array.isArray(channelIds) && channelIds.length > 0) {
      try {
        const displayName = await getUserDisplayName(env, userId);
        let dateText = "";
        if (startAt) {
          if (isAllDay) {
            dateText = `\n**日時:** ${new Date(startAt).toLocaleDateString("ja-JP")} (終日)`;
          } else {
            dateText = `\n**日時:** ${startAt} 〜 ${endAt || ""}`;
          }
        } else if (endAt) {
          dateText = `\n**期限:** ${new Date(endAt).toLocaleDateString("ja-JP")}`;
        }

        const notificationContent = `📋 **[タスク・予定登録]** ${displayName} さんが新しいアイテムを作成しました。\n**タイトル:** ${title}${dateText}`;

        const notifStatements = [];
        for (const cId of channelIds) {
          if (cId && cId !== "null") {
            const messageId = crypto.randomUUID();
            notifStatements.push(
              env.DB.prepare(`
                INSERT INTO messages (id, channel_id, user_id, content, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
              `).bind(messageId, cId, userId, notificationContent, createdAt, createdAt)
            );
          }
        }
        if (notifStatements.length > 0) {
          await env.DB.batch(notifStatements);
        }
      } catch (notificationError) {
        console.error("Failed to send creation notification to channels:", notificationError);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: itemId,
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

// 3. アイテム更新
export async function handleUpdateItem(request: Request, env: Env, itemId: string): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    // アイテムの存在と権限の確認
    const item = await env.DB.prepare(
      "SELECT creator_id as creatorId, workspace_id as workspaceId, title, status, is_private as isPrivate FROM items WHERE id = ?"
    ).bind(itemId).first<{ creatorId: string; workspaceId: string; title: string; status: string; isPrivate: number }>();

    if (!item) {
      return new Response(JSON.stringify({ error: "Item not found" }), {
        status: 404,
        headers,
      });
    }

    // ユーザーのワークスペース内のロールを取得
    const member = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(item.workspaceId, userId).first<{ role: string }>();
    const userRole = member?.role || 'member';

    if (userRole === 'guest') {
      const itemChans = await env.DB.prepare(
        "SELECT channel_id FROM item_channels WHERE item_id = ?"
      ).bind(itemId).all<{ channel_id: string }>();
      
      let isChanMember = false;
      for (const ch of itemChans.results) {
        const isMem = await env.DB.prepare(
          "SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?"
        ).bind(ch.channel_id, userId).first();
        if (isMem) {
          isChanMember = true;
          break;
        }
      }

      if (!isChanMember) {
        return new Response(JSON.stringify({ error: "Forbidden: Guest cannot update this task as they are not member of associated channels" }), {
          status: 403,
          headers,
        });
      }
    }

    // 担当者のうちの1人かどうかの確認
    const assignees = await env.DB.prepare(
      "SELECT user_id FROM item_assignees WHERE item_id = ?"
    ).bind(itemId).all<{ user_id: string }>();
    const isAssignee = assignees.results.some((r: any) => r.user_id === userId);

    const isOwner = await isWorkspaceOwner(env, item.workspaceId, userId);
    const hasPermission = item.creatorId === userId || isAssignee || isOwner;

    if (!hasPermission) {
      return new Response(JSON.stringify({ error: "Permission denied" }), {
        status: 403,
        headers,
      });
    }

    const body: any = await request.json();
    const { title, description, assigneeIds, status, startAt, endAt, isAllDay, isPrivate, channelIds, priority, tags } = body;

    if (userRole === 'guest' && Array.isArray(channelIds)) {
      if (channelIds.length === 0) {
        return new Response(JSON.stringify({ error: "Guests must associate tasks with at least one channel" }), {
          status: 403,
          headers,
        });
      }
      for (const chId of channelIds) {
        const isChanMem = await env.DB.prepare(
          "SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?"
        ).bind(chId, userId).first();
        if (!isChanMem) {
          return new Response(JSON.stringify({ error: "Forbidden: You are not a member of the associated channel" }), {
            status: 403,
            headers,
          });
        }
      }
    }

    const itemTitle = title !== undefined ? escapeHtml(title) : item.title;
    const sanitizedDescription = description !== undefined ? (description ? escapeHtml(description) : null) : null;
    const itemStatus = status !== undefined ? status : item.status;
    const isAllDayInt = isAllDay !== undefined ? (isAllDay ? 1 : 0) : undefined;
    const isPrivateInt = isPrivate !== undefined ? (isPrivate ? 1 : 0) : item.isPrivate;
    const updatedAt = new Date().toISOString();
    const itemPriority = priority !== undefined ? priority : undefined;
    const itemTagsStr = Array.isArray(tags) ? tags.filter(Boolean).join(",") : (tags !== undefined ? tags : undefined);

    // 動的SQLの構築
    let updateFields = "title = ?, description = ?, status = ?, is_private = ?, updated_at = ?";
    const params: any[] = [
      itemTitle,
      sanitizedDescription,
      itemStatus,
      isPrivateInt,
      updatedAt
    ];

    if (itemPriority !== undefined) {
      updateFields += ", priority = ?";
      params.push(itemPriority);
    }
    if (itemTagsStr !== undefined) {
      updateFields += ", tags = ?";
      params.push(itemTagsStr);
    }
    if (startAt !== undefined) {
      updateFields += ", start_at = ?";
      params.push(startAt);
    }
    if (endAt !== undefined) {
      updateFields += ", end_at = ?";
      params.push(endAt);
    }
    if (isAllDayInt !== undefined) {
      updateFields += ", is_all_day = ?";
      params.push(isAllDayInt);
    }

    params.push(itemId);

    const batchStatements = [
      env.DB.prepare(`UPDATE items SET ${updateFields} WHERE id = ?`).bind(...params)
    ];

    // 担当者の更新（配列が渡された場合のみ）
    if (assigneeIds !== undefined) {
      batchStatements.push(env.DB.prepare("DELETE FROM item_assignees WHERE item_id = ?").bind(itemId));
      if (Array.isArray(assigneeIds) && assigneeIds.length > 0) {
        for (const aId of assigneeIds) {
          if (aId && aId !== "null") {
            batchStatements.push(
              env.DB.prepare("INSERT INTO item_assignees (item_id, user_id) VALUES (?, ?)")
                .bind(itemId, aId)
            );
          }
        }
      }
    }

    // 関連チャンネルの更新（配列が渡された場合のみ）
    if (channelIds !== undefined) {
      batchStatements.push(env.DB.prepare("DELETE FROM item_channels WHERE item_id = ?").bind(itemId));
      if (Array.isArray(channelIds) && channelIds.length > 0) {
        for (const cId of channelIds) {
          if (cId && cId !== "null") {
            batchStatements.push(
              env.DB.prepare("INSERT INTO item_channels (item_id, channel_id) VALUES (?, ?)")
                .bind(itemId, cId)
            );
          }
        }
      }
    }

    await env.DB.batch(batchStatements);

    // アサイン通知および完了通知の送信
    if (assigneeIds !== undefined) {
      await createTaskNotifications(env, itemId, item.workspaceId, userId, "assign");
    }
    if (itemStatus === "done" && item.status !== "done") {
      await createTaskNotifications(env, itemId, item.workspaceId, userId, "task_done", { title: itemTitle });
    }

    // ステータスが完了(doneまたは設定された最終ステータスに準拠)に変更された場合、自動通知を送る（パブリックかつ関連チャンネルがある場合）
    if (itemStatus === "done" && item.status !== "done" && isPrivateInt === 0) {
      try {
        const currentChannels = await env.DB.prepare(
          "SELECT channel_id FROM item_channels WHERE item_id = ?"
        ).bind(itemId).all<{ channel_id: string }>();

        if (currentChannels.results.length > 0) {
          const displayName = await getUserDisplayName(env, userId);
          const notificationContent = `✅ **[タスク完了]** ${displayName} さんがアイテム「**${itemTitle}**」を完了しました！`;
          
          const notifStatements = [];
          for (const row of currentChannels.results) {
            const messageId = crypto.randomUUID();
            notifStatements.push(
              env.DB.prepare(`
                INSERT INTO messages (id, channel_id, user_id, content, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
              `).bind(messageId, row.channel_id, userId, notificationContent, updatedAt, updatedAt)
            );
          }
          await env.DB.batch(notifStatements);
        }
      } catch (notificationError) {
        console.error("Failed to send done notification to channels:", notificationError);
      }
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

// 4. アイテム削除
export async function handleDeleteItem(request: Request, env: Env, itemId: string): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    // アイテムの存在と権限の確認
    const item = await env.DB.prepare(
      "SELECT creator_id as creatorId, workspace_id as workspaceId FROM items WHERE id = ?"
    ).bind(itemId).first<{ creatorId: string; workspaceId: string }>();

    if (!item) {
      return new Response(JSON.stringify({ error: "Item not found" }), {
        status: 404,
        headers,
      });
    }

    // ユーザーのワークスペース内のロールを取得
    const member = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(item.workspaceId, userId).first<{ role: string }>();
    const userRole = member?.role || 'member';

    if (userRole === 'guest') {
      const itemChans = await env.DB.prepare(
        "SELECT channel_id FROM item_channels WHERE item_id = ?"
      ).bind(itemId).all<{ channel_id: string }>();
      
      let isChanMember = false;
      for (const ch of itemChans.results) {
        const isMem = await env.DB.prepare(
          "SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?"
        ).bind(ch.channel_id, userId).first();
        if (isMem) {
          isChanMember = true;
          break;
        }
      }

      if (!isChanMember) {
        return new Response(JSON.stringify({ error: "Forbidden: Guest cannot delete this task as they are not member of associated channels" }), {
          status: 403,
          headers,
        });
      }
    }

    const isOwner = await isWorkspaceOwner(env, item.workspaceId, userId);
    if (item.creatorId !== userId && !isOwner) {
      return new Response(JSON.stringify({ error: "Permission denied" }), {
        status: 403,
        headers,
      });
    }

    await env.DB.prepare("DELETE FROM items WHERE id = ?").bind(itemId).run();

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
