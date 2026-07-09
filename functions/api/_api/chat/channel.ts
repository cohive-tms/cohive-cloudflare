import type { Env } from "../../[[route]]";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id",
};

// チャンネル一覧取得 API
export async function handleGetChannels(request: Request, env: Env, workspaceId: string): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    const url = new URL(request.url);
    const lastReadsParam = url.searchParams.get("last_reads");
    let lastReads: Record<string, string> = {};
    if (lastReadsParam) {
      try {
        lastReads = JSON.parse(lastReadsParam);
      } catch {
        lastReads = {};
      }
    }

    // ユーザーのワークスペース内のロールを取得
    const member = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, userId).first<{ role: string }>();

    const userRole = member?.role || 'member';

    let results;
    if (userRole === 'guest') {
      // ゲストの場合は、自分が明示的にメンバーになっているチャンネルのみ（DMは除外）
      const queryResult = await env.DB.prepare(`
        SELECT c.* FROM channels c
        WHERE c.workspace_id = ?
          AND (c.type = 'channel' OR c.type IS NULL)
          AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?)
        ORDER BY c.created_at ASC
      `).bind(workspaceId, userId).all<any>();
      results = queryResult.results;
    } else {
      // 閲覧権限があるチャンネルのみを取得するSQL
      const queryResult = await env.DB.prepare(`
        SELECT c.* FROM channels c
        WHERE c.workspace_id = ?
          AND (
            -- 1. デフォルトルーム: general パブリックチャンネル
            ((c.type = 'channel' OR c.type IS NULL) AND c.is_private = 0 AND c.name = 'general')
            OR
            -- 2. 自分が明示的にメンバーになっているチャンネル/DM
            EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?)
          )
        ORDER BY c.created_at ASC
      `).bind(workspaceId, userId).all<any>();
      results = queryResult.results;
    }

    // 各チャンネルの未読件数を一括でカウント（D1.batch）
    const countQueries = results.map((row: any) => {
      const lastReadTime = lastReads[row.id];
      if (lastReadTime) {
        return env.DB.prepare(`
          SELECT COUNT(*) as count FROM messages 
          WHERE channel_id = ? AND created_at > ? AND user_id != ?
        `).bind(row.id, lastReadTime, userId);
      } else {
        return env.DB.prepare("SELECT 0 as count");
      }
    });

    let counts: any[] = [];
    if (countQueries.length > 0) {
      counts = await env.DB.batch(countQueries);
    }

    const data = results.map((row: any, index: number) => {
      const unreadCount = counts[index]?.results?.[0]?.count || 0;
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        name: row.name,
        isPrivate: row.is_private === 1,
        description: row.description,
        type: row.type || 'channel',
        groupId: row.group_id || null,
        updatedAt: row.updated_at || null,
        unreadCount,
      };
    });

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

// チャンネル作成 API
export async function handleCreateChannel(request: Request, env: Env, workspaceId: string): Promise<Response> {
  try {
    const body: any = await request.json();
    const { name, description, isPrivate, groupId, type, memberIds } = body;

    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    const creator = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, userId).first<{ role: string }>();

    const channelType = type || 'channel';

    if (channelType === 'dm') {
      if (creator?.role === 'guest') {
        return new Response(JSON.stringify({ error: "Guests are not allowed to start DMs" }), {
          status: 403,
          headers,
        });
      }
      if (Array.isArray(memberIds) && memberIds.length > 0) {
        const placeholders = memberIds.map(() => "?").join(",");
        const query = `
          SELECT user_id FROM workspace_members 
          WHERE workspace_id = ? AND role = 'guest' AND user_id IN (${placeholders})
        `;
        const { results } = await env.DB.prepare(query)
          .bind(workspaceId, ...memberIds)
          .all<{ user_id: string }>();

        if (results && results.length > 0) {
          return new Response(JSON.stringify({ error: "Cannot start DM with a guest user" }), {
            status: 403,
            headers,
          });
        }
      }
    }

    // 既に同じ組み合わせの1対1 DMが存在するかチェックする
    if (channelType === 'dm' && Array.isArray(memberIds) && memberIds.length === 2) {
      const existingDm = await env.DB.prepare(`
        SELECT cm1.channel_id
        FROM channel_members cm1
        JOIN channel_members cm2 ON cm1.channel_id = cm2.channel_id
        JOIN channels c ON cm1.channel_id = c.id
        WHERE c.type = 'dm'
          AND cm1.user_id = ?
          AND cm2.user_id = ?
          AND (SELECT COUNT(*) FROM channel_members cm WHERE cm.channel_id = c.id) = 2
      `).bind(memberIds[0], memberIds[1]).first<{ channel_id: string }>();

      if (existingDm) {
        const ch = await env.DB.prepare("SELECT * FROM channels WHERE id = ?").bind(existingDm.channel_id).first<{ id: string; name: string }>();
        return new Response(JSON.stringify({
          success: true,
          data: {
            id: ch?.id,
            workspaceId,
            name: ch?.name,
            isPrivate: true,
            type: 'dm'
          }
        }), {
          status: 200,
          headers,
        });
      }
    }

    const channelId = crypto.randomUUID();
    const isPrivateInt = (isPrivate || channelType === 'dm') ? 1 : 0;

    await env.DB.prepare(
      "INSERT INTO channels (id, workspace_id, name, description, is_private, type, group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).bind(channelId, workspaceId, name || "DM", description || "", isPrivateInt, channelType, groupId || null).run();

    // 参加ユーザーを設定（作成者自身も自動登録）
    const assignedMemberIds = new Set<string>();
    if (Array.isArray(memberIds)) {
      memberIds.forEach(id => assignedMemberIds.add(id));
    }
    assignedMemberIds.add(userId);

    const batch = Array.from(assignedMemberIds).map(uid =>
      env.DB.prepare("INSERT INTO channel_members (channel_id, user_id, created_at) VALUES (?, ?, datetime('now'))").bind(channelId, uid)
    );
    await env.DB.batch(batch);

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: channelId,
        workspaceId,
        name: name || "DM",
        description,
        isPrivate: isPrivateInt === 1,
        type: channelType,
        groupId: groupId || null,
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

// チャンネル更新 API
export async function handleUpdateChannel(request: Request, env: Env, channelId: string): Promise<Response> {
  try {
    const body: any = await request.json();
    const { name, description, isPrivate } = body;
    const operatorId = request.headers.get("X-User-Id");

    if (!operatorId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    // チャンネルと所属ワークスペースの取得
    const channel = await env.DB.prepare(
      "SELECT workspace_id as workspaceId, is_private as isPrivate, type, group_id as groupId FROM channels WHERE id = ?"
    ).bind(channelId).first<{ workspaceId: string; isPrivate: number; type: string; groupId: string | null }>();

    if (!channel) {
      return new Response(JSON.stringify({ error: "Channel not found" }), {
        status: 404,
        headers,
      });
    }

    // DM の場合はパブリック化（isPrivate = false）を拒否
    if (channel.type === 'dm' && isPrivate === false) {
      return new Response(JSON.stringify({ error: "DM cannot be made public" }), {
        status: 400,
        headers,
      });
    }

    // 操作者のロールを取得
    const operator = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(channel.workspaceId, operatorId).first<{ role: string }>();

    if (!operator) {
      return new Response(JSON.stringify({ error: "Permission denied" }), {
        status: 403,
        headers,
      });
    }

    const isOwner = operator.role === 'owner';
    const isGroupAdmin = operator.role === 'group_admin';

    let hasPermission = isOwner;

    // グループ管理者の場合、このチャンネルが自分の管理する（リーダーである）グループに属しているかチェック
    if (isGroupAdmin && channel.groupId) {
      const isLeader = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM group_members WHERE group_id = ? AND user_id = ? AND is_leader = 1"
      ).bind(channel.groupId, operatorId).first<{ count: number }>();

      if (isLeader && isLeader.count > 0) {
        hasPermission = true;
      }
    }

    if (!hasPermission) {
      return new Response(JSON.stringify({ error: "Permission denied" }), {
        status: 403,
        headers,
      });
    }

    const isPrivateInt = isPrivate !== undefined ? (isPrivate ? 1 : 0) : channel.isPrivate;

    await env.DB.prepare(
      "UPDATE channels SET name = ?, description = ?, is_private = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(name || "", description || "", isPrivateInt, channelId).run();

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: channelId,
        name: name || "",
        description: description || "",
        isPrivate: isPrivateInt === 1,
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

// チャンネル削除 API
export async function handleDeleteChannel(request: Request, env: Env, channelId: string): Promise<Response> {
  try {
    const operatorId = request.headers.get("X-User-Id");

    if (!operatorId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    // チャンネルと所属ワークスペースの取得
    const channel = await env.DB.prepare(
      "SELECT workspace_id as workspaceId, group_id as groupId FROM channels WHERE id = ?"
    ).bind(channelId).first<{ workspaceId: string; groupId: string | null }>();

    if (!channel) {
      return new Response(JSON.stringify({ error: "Channel not found" }), {
        status: 404,
        headers,
      });
    }

    // 操作者のロールを取得
    const operator = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(channel.workspaceId, operatorId).first<{ role: string }>();

    if (!operator) {
      return new Response(JSON.stringify({ error: "Permission denied" }), {
        status: 403,
        headers,
      });
    }

    const isOwner = operator.role === 'owner';
    const isGroupAdmin = operator.role === 'group_admin';

    let hasPermission = isOwner;

    // グループ管理者の場合、このチャンネルが自分の管理する（リーダーである）グループに属しているかチェック
    if (isGroupAdmin && channel.groupId) {
      const isLeader = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM group_members WHERE group_id = ? AND user_id = ? AND is_leader = 1"
      ).bind(channel.groupId, operatorId).first<{ count: number }>();

      if (isLeader && isLeader.count > 0) {
        hasPermission = true;
      }
    }

    if (!hasPermission) {
      return new Response(JSON.stringify({ error: "Permission denied" }), {
        status: 403,
        headers,
      });
    }

    await env.DB.prepare(
      "DELETE FROM channels WHERE id = ?"
    ).bind(channelId).run();

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

// 未参加のブラウズ可能なチャンネル一覧取得 API
export async function handleBrowseChannels(request: Request, env: Env, workspaceId: string): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    const member = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, userId).first<{ role: string }>();

    const userRole = member?.role || 'member';

    if (userRole === 'guest') {
      return new Response(JSON.stringify({ error: "Permission denied for guests" }), {
        status: 403,
        headers,
      });
    }

    const { results } = await env.DB.prepare(`
      SELECT c.* FROM channels c
      WHERE c.workspace_id = ?
        AND (c.type = 'channel' OR c.type IS NULL)
        AND c.name != 'general'
        AND NOT EXISTS (
          SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?
        )
        AND (
          -- 1. 公開チャンネル
          c.is_private = 0
          OR
          -- 2. 所属グループに紐づくプライベートチャンネル
          (c.is_private = 1 AND c.group_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM group_members gm WHERE gm.group_id = c.group_id AND gm.user_id = ?
          ))
          OR
          -- 3. オーナーはすべてのチャンネルをブラウズ可能
          (c.is_private = 1 AND ? = 'owner')
        )
      ORDER BY c.name ASC
    `).bind(workspaceId, userId, userId, userRole).all<any>();

    const data = results.map((row: any) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      isPrivate: row.is_private === 1,
      description: row.description,
      type: row.type || 'channel',
      groupId: row.group_id || null,
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
