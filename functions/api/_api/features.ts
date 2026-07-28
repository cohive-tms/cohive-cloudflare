import type { Env } from "../[[route]]";

/**
 * ワークスペース内を横断検索します（メッセージ・タスク）。
 * GET /api/workspaces/:workspaceId/search?q=...
 */
export async function handleSearchWorkspace(
  request: Request,
  env: Env,
  workspaceId: string
): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };

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
 * アクティビティログを取得します。
 * GET /api/activities
 */
export async function handleGetActivities(
  request: Request,
  env: Env
): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };

  try {
    return new Response(JSON.stringify({
      success: true,
      data: []
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

/**
 * ワークスペースのカスタム絵文字一覧を取得します。
 * GET /api/workspaces/:workspaceId/emojis
 */
export async function handleGetCustomEmojis(
  request: Request,
  env: Env,
  workspaceId: string
): Promise<Response> {
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };

  try {
    return new Response(JSON.stringify({
      success: true,
      data: []
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
