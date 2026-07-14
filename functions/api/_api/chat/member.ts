import type { Env } from "../../[[route]]";
import { sendMail, getSmtpSettings } from "../../_utils/smtp";
import { canAccessChannel } from "./message";
import { verifyPassword } from "../setup";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id",
};

// ユーザープロフィール更新 API
export async function handleUpdateUser(request: Request, env: Env): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    const body: any = await request.json();
    const { displayName, avatarUrl, language } = body;

    if (!displayName) {
      return new Response(JSON.stringify({ error: "Display name is required" }), {
        status: 400,
        headers,
      });
    }

    await env.DB.prepare(
      "UPDATE users SET display_name = ?, avatar_url = ?, language = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(displayName, avatarUrl || null, language || 'ja', userId).run();

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: userId,
        displayName,
        avatarUrl,
        language: language || 'ja'
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

// ワークスペースメンバー一覧取得 API
export async function handleGetWorkspaceMembers(request: Request, env: Env, workspaceId: string): Promise<Response> {
  try {
    const operatorId = request.headers.get("X-User-Id");
    if (!operatorId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    const operator = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, operatorId).first<{ role: string }>();

    if (!operator || operator.role === 'guest') {
      return new Response(JSON.stringify({ error: "Permission denied for guests" }), {
        status: 403,
        headers,
      });
    }

    const { results } = await env.DB.prepare(`
      SELECT 
        u.id as userId,
        u.email,
        u.display_name as displayName,
        u.avatar_url as avatarUrl,
        wm.role,
        (
          SELECT json_group_array(group_id) 
          FROM group_members 
          WHERE user_id = u.id
        ) as groupIdsJson
      FROM workspace_members wm
      JOIN users u ON wm.user_id = u.id
      WHERE wm.workspace_id = ?
      ORDER BY wm.created_at ASC
    `).bind(workspaceId).all<any>();

    const data = results.map(r => ({
      ...r,
      groupIds: r.groupIdsJson ? JSON.parse(r.groupIdsJson) : []
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

// メンバー追加 API
export async function handleAddWorkspaceMember(request: Request, env: Env, workspaceId: string): Promise<Response> {
  try {
    const body: any = await request.json();
    const { email, role } = body;

    if (!email) {
      return new Response(JSON.stringify({ error: "Email is required" }), {
        status: 400,
        headers,
      });
    }

    const memberRole = role || 'member';

    // 既存ユーザーを検索
    let user = await env.DB.prepare(
      "SELECT id, email, display_name as displayName, avatar_url as avatarUrl FROM users WHERE email = ?"
    ).bind(email).first<{ id: string; email: string; displayName: string; avatarUrl: string | null }>();

    let userId = user?.id;

    if (!user) {
      // 存在しない場合は仮パスワードで自動生成
      userId = crypto.randomUUID();
      const displayName = email.split('@')[0];
      const tempHash = "pbkdf2$100000$0000000000000000$0000000000000000000000000000000000000000000000000000000000000000";

      await env.DB.prepare(
        "INSERT INTO users (id, email, password_hash, display_name, language, created_at, updated_at) VALUES (?, ?, ?, ?, 'ja', datetime('now'), datetime('now'))"
      ).bind(userId, email, tempHash, displayName).run();
    }

    // 重複チェック
    const existingMember = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, userId).first();

    if (existingMember) {
      return new Response(JSON.stringify({ error: "User is already a member of this workspace" }), {
        status: 400,
        headers,
      });
    }

    // メンバーとしてインサート
    await env.DB.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
    ).bind(workspaceId, userId, memberRole).run();

    // 招待メールの送信（SMTP設定が有効な場合のみ）
    const smtpSettings = await getSmtpSettings(env);
    if (smtpSettings) {
      try {
        const workspace = await env.DB.prepare(
          "SELECT name FROM workspaces WHERE id = ?"
        ).bind(workspaceId).first<{ name: string }>();
        const workspaceName = workspace?.name || "Cohive";

        const url = new URL(request.url);
        const loginUrl = `${url.protocol}//${url.host}`;

        await sendMail(smtpSettings, {
          to: email,
          subject: `[Cohive] ${workspaceName} ワークスペースへの招待`,
          text: `こんにちは。\r\n\r\n${workspaceName} ワークスペースへの招待が届きました。\r\n以下のリンクからログインしてください。\r\n\r\nログインURL: ${loginUrl}\r\n\r\n※初めてのログインの際は、管理者から発行された初期パスワードをご使用ください。ログイン後、右上の設定よりパスワードの変更をお願いいたします。`,
          html: `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eaeaea; border-radius: 5px; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #4f46e5;">Cohive 招待のお知らせ</h2>
              <p>こんにちは。</p>
              <p><strong>${workspaceName}</strong> ワークスペースへの招待が届きました。</p>
              <div style="margin: 25px 0;">
                <a href="${loginUrl}" style="background: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
                   Cohive にログインする
                </a>
              </div>
              <p style="color: #6b7280; font-size: 13px; line-height: 1.5; border-top: 1px solid #eee; padding-top: 15px;">
                ※初めてログインする場合は、管理者から発行された初期パスワードをご入力ください。ログイン後、右上メニューの「設定」からパスワードを新しいものへ変更することをお勧めします。
              </p>
            </div>
          `
        });
      } catch (mailErr) {
        console.error("Failed to send invitation email:", mailErr);
      }
    }

    const addedUser = await env.DB.prepare(
      "SELECT id as userId, email, display_name as displayName, avatar_url as avatarUrl FROM users WHERE id = ?"
    ).bind(userId).first<any>();

    return new Response(JSON.stringify({
      success: true,
      data: {
        ...addedUser,
        role: memberRole
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

// メンバーロール更新 API
export async function handleUpdateWorkspaceMember(request: Request, env: Env, workspaceId: string, userId: string): Promise<Response> {
  try {
    const body: any = await request.json();
    const { role } = body;
    const operatorId = request.headers.get("X-User-Id");

    if (!role || !['owner', 'group_admin', 'member', 'guest'].includes(role)) {
      return new Response(JSON.stringify({ error: "Valid role is required" }), {
        status: 400,
        headers,
      });
    }

    if (!operatorId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    // 操作者のロールを取得
    const operator = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, operatorId).first<{ role: string }>();

    if (!operator) {
      return new Response(JSON.stringify({ error: "Operator not found in workspace" }), {
        status: 403,
        headers,
      });
    }

    const isOperatorOwner = operator.role === 'owner';
    const isOperatorGroupAdmin = operator.role === 'group_admin';

    if (!isOperatorOwner && !isOperatorGroupAdmin) {
      return new Response(JSON.stringify({ error: "Permission denied" }), {
        status: 403,
        headers,
      });
    }

    // グループ管理者の場合、対象ユーザーが「自分がリーダーを務めるグループ」の所属メンバーであるかをチェック
    if (isOperatorGroupAdmin) {
      const leaderGroups = await env.DB.prepare(`
        SELECT group_id FROM group_members WHERE user_id = ? AND is_leader = 1
      `).bind(operatorId).all<{ group_id: string }>();

      const groupIds = leaderGroups.results.map(g => g.group_id);
      if (groupIds.length === 0) {
        return new Response(JSON.stringify({ error: "Permission denied (Not leading any group)" }), {
          status: 403,
          headers,
        });
      }

      // 対象ユーザーがグループに属しているかプレースホルダーバインドで確認
      const placeholders = groupIds.map(() => '?').join(',');
      const isTargetInGroup = await env.DB.prepare(`
        SELECT COUNT(*) as count FROM group_members 
        WHERE user_id = ? AND group_id IN (${placeholders})
      `).bind(userId, ...groupIds).first<{ count: number }>();

      if (!isTargetInGroup || isTargetInGroup.count === 0) {
        return new Response(JSON.stringify({ error: "Permission denied (Target user not in led groups)" }), {
          status: 403,
          headers,
        });
      }

      // グループ管理者は owner に昇格させることはできない
      if (role === 'owner') {
        return new Response(JSON.stringify({ error: "Permission denied (Cannot promote to owner)" }), {
          status: 403,
          headers,
        });
      }

      // 対象ユーザーが owner の場合は降格できない
      const target = await env.DB.prepare(
        "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
      ).bind(workspaceId, userId).first<{ role: string }>();
      if (target?.role === 'owner') {
        return new Response(JSON.stringify({ error: "Permission denied (Cannot downgrade owner)" }), {
          status: 403,
          headers,
        });
      }
    }

    await env.DB.prepare(
      "UPDATE workspace_members SET role = ?, updated_at = datetime('now') WHERE workspace_id = ? AND user_id = ?"
    ).bind(role, workspaceId, userId).run();

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

// メンバー削除 API
export async function handleDeleteWorkspaceMember(request: Request, env: Env, workspaceId: string, userId: string): Promise<Response> {
  try {
    const operatorId = request.headers.get("X-User-Id");

    if (!operatorId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    // 操作者のロールを取得
    const operator = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, operatorId).first<{ role: string }>();

    if (!operator) {
      return new Response(JSON.stringify({ error: "Operator not found in workspace" }), {
        status: 403,
        headers,
      });
    }

    const isOperatorOwner = operator.role === 'owner';
    const isOperatorGroupAdmin = operator.role === 'group_admin';

    if (!isOperatorOwner && !isOperatorGroupAdmin) {
      return new Response(JSON.stringify({ error: "Permission denied" }), {
        status: 403,
        headers,
      });
    }

    // グループ管理者の場合、対象ユーザーが「自分がリーダーを務めるグループ」の所属メンバーであるかをチェック
    if (isOperatorGroupAdmin) {
      const leaderGroups = await env.DB.prepare(`
        SELECT group_id FROM group_members WHERE user_id = ? AND is_leader = 1
      `).bind(operatorId).all<{ group_id: string }>();

      const groupIds = leaderGroups.results.map(g => g.group_id);
      if (groupIds.length === 0) {
        return new Response(JSON.stringify({ error: "Permission denied (Not leading any group)" }), {
          status: 403,
          headers,
        });
      }

      const placeholders = groupIds.map(() => '?').join(',');
      const isTargetInGroup = await env.DB.prepare(`
        SELECT COUNT(*) as count FROM group_members 
        WHERE user_id = ? AND group_id IN (${placeholders})
      `).bind(userId, ...groupIds).first<{ count: number }>();

      if (!isTargetInGroup || isTargetInGroup.count === 0) {
        return new Response(JSON.stringify({ error: "Permission denied (Target user not in led groups)" }), {
          status: 403,
          headers,
        });
      }

      // 対象ユーザーが owner の場合は除外できない
      const target = await env.DB.prepare(
        "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
      ).bind(workspaceId, userId).first<{ role: string }>();
      if (target?.role === 'owner') {
        return new Response(JSON.stringify({ error: "Permission denied (Cannot remove owner)" }), {
          status: 403,
          headers,
        });
      }
    }

    await env.DB.prepare(
      "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, userId).run();

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

// ログインユーザーのワークスペースにおけるロール取得 API
export async function handleGetWorkspaceUserRole(request: Request, env: Env, workspaceId: string): Promise<Response> {
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

    // ユーザーがリーダーを務めるグループのID一覧も一緒に返却する
    const leaderGroups = await env.DB.prepare(
      "SELECT group_id as groupId FROM group_members WHERE user_id = ? AND is_leader = 1"
    ).bind(userId).all<{ groupId: string }>();

    return new Response(JSON.stringify({
      success: true,
      role: member?.role || 'member',
      ledGroups: leaderGroups.results.map(g => g.groupId)
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

// グループメンバー一覧取得 API
export async function handleGetGroupMembers(request: Request, env: Env, groupId: string): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(`
      SELECT 
        u.id as userId,
        u.email,
        u.display_name as displayName,
        u.avatar_url as avatarUrl,
        gm.is_leader as isLeader
      FROM group_members gm
      JOIN users u ON gm.user_id = u.id
      WHERE gm.group_id = ?
      ORDER BY gm.created_at ASC
    `).bind(groupId).all<any>();

    const data = results.map(r => ({
      ...r,
      isLeader: r.isLeader === 1,
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

// グループメンバー追加 API
export async function handleAddGroupMember(request: Request, env: Env, groupId: string): Promise<Response> {
  try {
    const body: any = await request.json();
    const { userId, isLeader } = body;

    if (!userId) {
      return new Response(JSON.stringify({ error: "userId is required" }), {
        status: 400,
        headers,
      });
    }

    const leaderVal = isLeader ? 1 : 0;

    // 重複チェック
    const existing = await env.DB.prepare(
      "SELECT group_id FROM group_members WHERE group_id = ? AND user_id = ?"
    ).bind(groupId, userId).first();

    if (existing) {
      return new Response(JSON.stringify({ error: "User is already a member of this group" }), {
        status: 400,
        headers,
      });
    }

    await env.DB.prepare(
      "INSERT INTO group_members (group_id, user_id, is_leader, created_at) VALUES (?, ?, ?, datetime('now'))"
    ).bind(groupId, userId, leaderVal).run();

    const user = await env.DB.prepare(`
      SELECT 
        u.id as userId,
        u.email,
        u.display_name as displayName,
        u.avatar_url as avatarUrl
      FROM users u
      WHERE u.id = ?
    `).bind(userId).first<any>();

    return new Response(JSON.stringify({
      success: true,
      data: {
        ...user,
        isLeader: !!isLeader
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

// グループメンバー更新 API
export async function handleUpdateGroupMember(request: Request, env: Env, groupId: string, userId: string): Promise<Response> {
  try {
    const body: any = await request.json();
    const { isLeader } = body;

    const leaderVal = isLeader ? 1 : 0;

    await env.DB.prepare(
      "UPDATE group_members SET is_leader = ? WHERE group_id = ? AND user_id = ?"
    ).bind(leaderVal, groupId, userId).run();

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

// グループメンバー削除 API
export async function handleDeleteGroupMember(request: Request, env: Env, groupId: string, userId: string): Promise<Response> {
  try {
    await env.DB.prepare(
      "DELETE FROM group_members WHERE group_id = ? AND user_id = ?"
    ).bind(groupId, userId).run();

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

// チャンネルメンバー一覧取得 API
export async function handleGetChannelMembers(request: Request, env: Env, channelId: string): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    const hasAccess = await canAccessChannel(env, channelId, userId);
    if (!hasAccess) {
      return new Response(JSON.stringify({ error: "Permission denied" }), {
        status: 403,
        headers,
      });
    }

    // チャンネル情報を取得して、generalチャンネル（パブリック）かどうかを判定
    const channel = await env.DB.prepare(
      "SELECT workspace_id as workspaceId, name, is_private as isPrivate FROM channels WHERE id = ?"
    ).bind(channelId).first<{ workspaceId: string; name: string; isPrivate: number }>();

    if (!channel) {
      return new Response(JSON.stringify({ error: "Channel not found" }), {
        status: 404,
        headers,
      });
    }

    let results;
    if (channel.name === 'general' && channel.isPrivate === 0) {
      // general パブリックチャンネルの場合は、ワークスペースの全メンバーを返す
      const { results: wsMembers } = await env.DB.prepare(`
        SELECT 
          u.id as userId,
          u.email,
          u.display_name as displayName,
          u.avatar_url as avatarUrl
        FROM workspace_members wm
        JOIN users u ON wm.user_id = u.id
        WHERE wm.workspace_id = ?
        ORDER BY wm.created_at ASC
      `).bind(channel.workspaceId).all<any>();
      results = wsMembers;
    } else {
      // それ以外のチャンネル（一般のパブリック/プライベート/DM）は、実際にそのチャンネルに参加しているメンバーを返す
      const { results: chMembers } = await env.DB.prepare(`
        SELECT 
          u.id as userId,
          u.email,
          u.display_name as displayName,
          u.avatar_url as avatarUrl
        FROM channel_members cm
        JOIN users u ON cm.user_id = u.id
        WHERE cm.channel_id = ?
        ORDER BY cm.created_at ASC
      `).bind(channelId).all<any>();
      results = chMembers;
    }

    return new Response(JSON.stringify({ success: true, data: results }), {
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

// チャンネルメンバー追加 API
export async function handleAddChannelMember(request: Request, env: Env, channelId: string): Promise<Response> {
  try {
    const body: any = await request.json();
    const { userId } = body;
    const operatorId = request.headers.get("X-User-Id");

    if (!operatorId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    if (!userId) {
      return new Response(JSON.stringify({ error: "userId is required" }), {
        status: 400,
        headers,
      });
    }

    // チャンネルと所属ワークスペースの取得
    const channel = await env.DB.prepare(
      "SELECT workspace_id as workspaceId, type, group_id as groupId FROM channels WHERE id = ?"
    ).bind(channelId).first<{ workspaceId: string; type: string; groupId: string | null }>();

    if (!channel) {
      return new Response(JSON.stringify({ error: "Channel not found" }), {
        status: 404,
        headers,
      });
    }

    // 認可チェック
    // 1. オーナーならOK
    const operator = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(channel.workspaceId, operatorId).first<{ role: string }>();

    let hasPermission = operator?.role === 'owner';

    // 2. グループ管理者で、そのチャンネルが紐づくグループのリーダーならOK
    if (operator?.role === 'group_admin' && channel.groupId) {
      const isLeader = await env.DB.prepare(
        "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND is_leader = 1"
      ).bind(channel.groupId, operatorId).first();
      if (isLeader) {
        hasPermission = true;
      }
    }

    // 3. DMの場合、自身がメンバーなら招待可能
    if (channel.type === 'dm') {
      const isMember = await env.DB.prepare(
        "SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?"
      ).bind(channelId, operatorId).first();
      if (isMember) {
        hasPermission = true;
      }
    }

    if (!hasPermission) {
      return new Response(JSON.stringify({ error: "Permission denied" }), {
        status: 403,
        headers,
      });
    }

    // 重複チェック
    const existing = await env.DB.prepare(
      "SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?"
    ).bind(channelId, userId).first();

    if (existing) {
      return new Response(JSON.stringify({ error: "User is already a member of this channel" }), {
        status: 400,
        headers,
      });
    }

    await env.DB.prepare(
      "INSERT INTO channel_members (channel_id, user_id, created_at) VALUES (?, ?, datetime('now'))"
    ).bind(channelId, userId).run();

    const user = await env.DB.prepare(`
      SELECT 
        u.id as userId,
        u.email,
        u.display_name as displayName,
        u.avatar_url as avatarUrl
      FROM users u
      WHERE u.id = ?
    `).bind(userId).first<any>();

    return new Response(JSON.stringify({ success: true, data: user }), {
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

// チャンネルメンバー削除 API
export async function handleDeleteChannelMember(request: Request, env: Env, channelId: string, userId: string): Promise<Response> {
  try {
    const operatorId = request.headers.get("X-User-Id");

    if (!operatorId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    // チャンネルと所属ワークスペース of workspace の取得
    const channel = await env.DB.prepare(
      "SELECT workspace_id as workspaceId, type, group_id as groupId FROM channels WHERE id = ?"
    ).bind(channelId).first<{ workspaceId: string; type: string; groupId: string | null }>();

    if (!channel) {
      return new Response(JSON.stringify({ error: "Channel not found" }), {
        status: 404,
        headers,
      });
    }

    // 認可チェック
    const operator = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(channel.workspaceId, operatorId).first<{ role: string }>();

    let hasPermission = operator?.role === 'owner';

    if (operator?.role === 'group_admin' && channel.groupId) {
      const isLeader = await env.DB.prepare(
        "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND is_leader = 1"
      ).bind(channel.groupId, operatorId).first();
      if (isLeader) {
        hasPermission = true;
      }
    }

    if (channel.type === 'dm') {
      const isMember = await env.DB.prepare(
        "SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?"
      ).bind(channelId, operatorId).first();
      if (isMember) {
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
      "DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?"
    ).bind(channelId, userId).run();

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

// メールアドレス変更ステータス取得 API
export async function handleGetEmailChangeStatus(request: Request, env: Env): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    const smtpSettings = await getSmtpSettings(env);
    const isSmtpConfigured = !!smtpSettings;

    // 保留中の変更リクエストがあるか確認
    const pendingRequest = await env.DB.prepare(
      "SELECT new_email, expires_at FROM email_change_requests WHERE user_id = ?"
    ).bind(userId).first<{ new_email: string; expires_at: string }>();

    let pendingChange = null;
    if (pendingRequest) {
      pendingChange = {
        newEmail: pendingRequest.new_email,
        expiresAt: pendingRequest.expires_at,
      };
    }

    return new Response(JSON.stringify({
      success: true,
      isSmtpConfigured,
      pendingChange,
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

// メールアドレス変更リクエスト API
export async function handleRequestEmailChange(request: Request, env: Env): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    const body: any = await request.json();
    const { newEmail, currentPassword } = body;

    if (!newEmail || !currentPassword) {
      return new Response(JSON.stringify({ error: "New email and password are required" }), {
        status: 400,
        headers,
      });
    }

    // パスワードの確認
    const user = await env.DB.prepare(
      "SELECT password_hash, email FROM users WHERE id = ?"
    ).bind(userId).first<{ password_hash: string; email: string }>();

    if (!user || !user.password_hash) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers,
      });
    }

    const isPasswordValid = await verifyPassword(currentPassword, user.password_hash);
    if (!isPasswordValid) {
      return new Response(JSON.stringify({ error: "Incorrect password" }), {
        status: 400,
        headers,
      });
    }

    // すでに同じメールアドレスの場合はエラー
    if (user.email === newEmail) {
      return new Response(JSON.stringify({ error: "New email must be different from current email" }), {
        status: 400,
        headers,
      });
    }

    // 重複チェック
    const emailExists = await env.DB.prepare(
      "SELECT 1 FROM users WHERE email = ?"
    ).bind(newEmail).first();

    if (emailExists) {
      return new Response(JSON.stringify({ error: "Email already in use" }), {
        status: 400,
        headers,
      });
    }

    const smtpSettings = await getSmtpSettings(env);

    if (!smtpSettings) {
      // SMTP未設定なら即時変更
      await env.DB.prepare(
        "UPDATE users SET email = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(newEmail, userId).run();

      return new Response(JSON.stringify({
        success: true,
        emailUpdated: true,
        newEmail,
      }), {
        status: 200,
        headers,
      });
    } else {
      // SMTP設定済みの場合は確認コード送信フロー
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15分後

      // 一時変更要求の作成（既存があれば置換）
      await env.DB.prepare(
        "INSERT OR REPLACE INTO email_change_requests (user_id, new_email, verification_code, expires_at) VALUES (?, ?, ?, ?)"
      ).bind(userId, newEmail, code, expiresAt).run();

      // メールの送信
      try {
        await sendMail(smtpSettings, {
          to: newEmail,
          subject: "【CoHive】メールアドレス変更の確認コード",
          text: `CoHive をご利用いただきありがとうございます。\n\nメールアドレスの変更リクエストを受け付けました。\n以下の確認コードをプロフィール画面に入力して、変更を完了してください。\n\n確認コード: ${code}\n有効期限: 15分（${new Date(expiresAt).toLocaleString("ja-JP")} まで）\n\nもしこの変更に心当たりがない場合は、このメールを無視してください。`,
        });
      } catch (mailError: any) {
        console.error("Failed to send verification email:", mailError);
        return new Response(JSON.stringify({ error: "Failed to send verification email: " + mailError.message }), {
          status: 500,
          headers,
        });
      }

      return new Response(JSON.stringify({
        success: true,
        emailUpdated: false,
        newEmail,
      }), {
        status: 200,
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

// メールアドレス変更確定 API
export async function handleConfirmEmailChange(request: Request, env: Env): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    const body: any = await request.json();
    const { code } = body;

    if (!code) {
      return new Response(JSON.stringify({ error: "Verification code is required" }), {
        status: 400,
        headers,
      });
    }

    // 保留中のリクエストを取得
    const pendingRequest = await env.DB.prepare(
      "SELECT new_email, verification_code, expires_at FROM email_change_requests WHERE user_id = ?"
    ).bind(userId).first<{ new_email: string; verification_code: string; expires_at: string }>();

    if (!pendingRequest) {
      return new Response(JSON.stringify({ error: "No pending email change request found" }), {
        status: 400,
        headers,
      });
    }

    // 期限切れチェック
    const isExpired = new Date(pendingRequest.expires_at).getTime() < Date.now();
    if (isExpired) {
      // 期限切れレコードの削除
      await env.DB.prepare("DELETE FROM email_change_requests WHERE user_id = ?").bind(userId).run();
      return new Response(JSON.stringify({ error: "Verification code has expired" }), {
        status: 400,
        headers,
      });
    }

    // コードチェック
    if (pendingRequest.verification_code !== code) {
      return new Response(JSON.stringify({ error: "Invalid verification code" }), {
        status: 400,
        headers,
      });
    }

    // 重複チェック（コード入力するまでの間に他者が登録した場合を想定）
    const emailExists = await env.DB.prepare(
      "SELECT 1 FROM users WHERE email = ?"
    ).bind(pendingRequest.new_email).first();

    if (emailExists) {
      return new Response(JSON.stringify({ error: "Email already in use" }), {
        status: 400,
        headers,
      });
    }

    // メールアドレスの更新
    await env.DB.prepare(
      "UPDATE users SET email = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(pendingRequest.new_email, userId).run();

    // 保留中リクエストの削除
    await env.DB.prepare(
      "DELETE FROM email_change_requests WHERE user_id = ?"
    ).bind(userId).run();

    return new Response(JSON.stringify({
      success: true,
      newEmail: pendingRequest.new_email,
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

