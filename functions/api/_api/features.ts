import type { Env } from "../[[route]]";
import { verifyUserAuth } from "../_utils/jwt";
import { getCorsHeaders } from "../_utils/cors";



/**
 * ワークスペース内を横断検索します（メッセージ・タスク）。
 * GET /api/workspaces/:workspaceId/search?q=...
 */
export async function handleSearchWorkspace(
  request: Request,
  env: Env,
  workspaceId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "GET, OPTIONS");

  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q") || "";

    if (!query.trim()) {
      return new Response(JSON.stringify({ success: true, messages: [], items: [] }), {
        status: 200,
        headers,
      });
    }

    const searchPattern = `%${query.trim()}%`;

    const { results: messages } = await env.DB.prepare(`
      SELECT m.id, m.channel_id as channelId, m.user_id as userId, COALESCE(u.display_name, 'ユーザー') as userName, m.content, m.created_at as createdAt
      FROM messages m
      JOIN channels c ON m.channel_id = c.id
      LEFT JOIN users u ON m.user_id = u.id
      WHERE c.workspace_id = ? AND m.content LIKE ?
      LIMIT 20
    `).bind(workspaceId, searchPattern).all<any>();

    const { results: items } = await env.DB.prepare(`
      SELECT id, title, description, status, priority, created_at as createdAt
      FROM items
      WHERE workspace_id = ? AND (title LIKE ? OR description LIKE ?)
      LIMIT 20
    `).bind(workspaceId, searchPattern, searchPattern).all<any>();

    return new Response(JSON.stringify({
      success: true,
      messages: messages || [],
      items: items || []
    }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to execute search:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * 所属ワークスペースの新着活動履歴（イベントログ）を取得します。
 * GET /api/activities
 */
export async function handleGetActivities(
  request: Request,
  env: Env
): Promise<Response> {
  const headers = getCorsHeaders(request, "GET, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    // ユーザーが所属するワークスペース一覧を取得
    const { results: workspaces } = await env.DB.prepare(`
      SELECT workspace_id FROM workspace_members WHERE user_id = ?
    `).bind(userId).all<{ workspace_id: string }>();

    if (!workspaces || workspaces.length === 0) {
      return new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers });
    }

    const wsIds = workspaces.map(w => w.workspace_id);
    const placeholders = wsIds.map(() => "?").join(",");

    // チャンネル作成、タスク作成、ファイルアップロードの履歴をマージして取得
    const query = `
      SELECT 
        'channel' as type,
        c.id,
        c.workspace_id as workspaceId,
        w.name as workspaceName,
        c.name as title,
        COALESCE(c.description, '') as content,
        c.created_at as createdAt,
        NULL as userName
      FROM channels c
      JOIN workspaces w ON c.workspace_id = w.id
      WHERE c.workspace_id IN (${placeholders})

      UNION ALL

      SELECT 
        'task' as type,
        i.id,
        i.workspace_id as workspaceId,
        w.name as workspaceName,
        i.title,
        COALESCE(i.description, '') as content,
        i.created_at as createdAt,
        u.display_name as userName
      FROM items i
      JOIN workspaces w ON i.workspace_id = w.id
      LEFT JOIN users u ON i.creator_id = u.id
      WHERE i.workspace_id IN (${placeholders})

      UNION ALL

      SELECT 
        'file' as type,
        f.id,
        f.workspace_id as workspaceId,
        w.name as workspaceName,
        f.file_name as title,
        '' as content,
        f.created_at as createdAt,
        u.display_name as userName
      FROM files f
      JOIN workspaces w ON f.workspace_id = w.id
      LEFT JOIN users u ON f.uploader_id = u.id
      WHERE f.workspace_id IN (${placeholders})

      ORDER BY createdAt DESC
      LIMIT 30
    `;

    // 3箇所分プレースホルダーパラメータをマインドする
    const bindParams = [...wsIds, ...wsIds, ...wsIds];
    const { results: activities } = await env.DB.prepare(query).bind(...bindParams).all<any>();

    return new Response(JSON.stringify({
      success: true,
      data: activities || []
    }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to fetch activities:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * ワークスペースのカスタム絵文字一覧を取得します。
 * GET /api/workspaces/:workspaceId/emojis
 */
export async function handleGetCustomEmojis(
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

    const { results } = await env.DB.prepare(`
      SELECT id, code, object_key FROM custom_emojis 
      WHERE workspace_id = ?
      ORDER BY created_at ASC
    `).bind(workspaceId).all<any>();

    const emojis = (results || []).map(emoji => ({
      id: emoji.id,
      code: emoji.code,
      url: `/api/files/download/${emoji.object_key}`
    }));

    return new Response(JSON.stringify({
      success: true,
      data: emojis
    }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to fetch custom emojis:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * カスタム絵文字をアップロードし登録します。
 * POST /api/workspaces/:workspaceId/emojis
 */
export async function handleCreateCustomEmoji(
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

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const code = formData.get("code") as string | null;

    if (!file || !code) {
      return new Response(JSON.stringify({ error: "Missing file or emoji code" }), { status: 400, headers });
    }

    let formattedCode = code.trim();
    if (!formattedCode.startsWith(":")) formattedCode = ":" + formattedCode;
    if (!formattedCode.endsWith(":")) formattedCode = formattedCode + ":";

    // 1MB以下制限
    if (file.size > 1024 * 1024) {
      return new Response(JSON.stringify({ error: "Emoji size must be under 1MB" }), { status: 400, headers });
    }

    const emojiId = crypto.randomUUID();
    const fileName = file.name;
    const contentType = file.type || "image/png";

    // workspaces/${workspaceId}/emojis/ プレフィックスで保存
    const objectKey = `workspaces/${workspaceId}/emojis/${emojiId}_${fileName}`;

    const storage = env.BUCKET;
    if (!storage) {
      return new Response(JSON.stringify({ error: "R2 storage binding 'BUCKET' not found" }), { status: 500, headers });
    }

    // R2へ保存
    await storage.put(objectKey, file.stream(), {
      httpMetadata: {
        contentType: contentType,
        contentDisposition: `inline; filename="${encodeURIComponent(fileName)}"`
      },
      customMetadata: {
        uploaderId: userId,
        workspaceId: workspaceId,
        isEmoji: "true"
      }
    });

    // D1登録 (ON CONFLICTで同一絵文字コードは上書き)
    await env.DB.prepare(`
      INSERT INTO custom_emojis (id, workspace_id, code, object_key, creator_id, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(workspace_id, code) DO UPDATE SET
        object_key = excluded.object_key,
        creator_id = excluded.creator_id,
        created_at = datetime('now')
    `).bind(emojiId, workspaceId, formattedCode, objectKey, userId).run();

    return new Response(
      JSON.stringify({
        success: true,
        message: "Emoji uploaded successfully!"
      }),
      { status: 200, headers }
    );
  } catch (error: any) {
    console.error("Failed to upload custom emoji:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers
    });
  }
}
