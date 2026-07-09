import type { Env } from "../[[route]]";
import { canAccessChannel } from "./chat/message";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

// GET /api/workspaces/:workspaceId/document
export async function handleGetWorkspaceDocument(request: Request, env: Env, workspaceId: string): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    // ワークスペースのメンバーであることを確認
    const member = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, userId).first<{ role: string }>();
    if (!member || member.role === 'guest') {
      return new Response(JSON.stringify({ error: "Access denied for guests" }), { status: 403, headers });
    }

    const row = await env.DB.prepare(
      "SELECT document FROM workspaces WHERE id = ?"
    ).bind(workspaceId).first<{ document: string | null }>();

    return new Response(JSON.stringify({
      success: true,
      document: row?.document ?? ""
    }), { status: 200, headers });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// PUT /api/workspaces/:workspaceId/document
export async function handleUpdateWorkspaceDocument(request: Request, env: Env, workspaceId: string): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    // ワークスペースメンバーの存在・権限確認（メンバーであれば編集可）
    const member = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, userId).first<{ role: string }>();
    if (!member || member.role === 'guest') {
      return new Response(JSON.stringify({ error: "Access denied for guests" }), { status: 403, headers });
    }

    const { document } = await request.json<{ document: string }>();

    await env.DB.prepare(
      "UPDATE workspaces SET document = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(document || '', workspaceId).run();

    return new Response(JSON.stringify({
      success: true,
      message: "Workspace document updated successfully"
    }), { status: 200, headers });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// GET /api/channels/:channelId/document
export async function handleGetChannelDocument(request: Request, env: Env, channelId: string): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const hasAccess = await canAccessChannel(env, channelId, userId);
    if (!hasAccess) {
      return new Response(JSON.stringify({ error: "Access denied" }), { status: 403, headers });
    }

    const row = await env.DB.prepare(
      "SELECT document FROM channels WHERE id = ?"
    ).bind(channelId).first<{ document: string | null }>();

    return new Response(JSON.stringify({
      success: true,
      document: row?.document ?? ""
    }), { status: 200, headers });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), { status: 500, headers });
  }
}

// PUT /api/channels/:channelId/document
export async function handleUpdateChannelDocument(request: Request, env: Env, channelId: string): Promise<Response> {
  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const hasAccess = await canAccessChannel(env, channelId, userId);
    if (!hasAccess) {
      return new Response(JSON.stringify({ error: "Access denied" }), { status: 403, headers });
    }

    const { document } = await request.json<{ document: string }>();

    await env.DB.prepare(
      "UPDATE channels SET document = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(document || '', channelId).run();

    return new Response(JSON.stringify({
      success: true,
      message: "Channel document updated successfully"
    }), { status: 200, headers });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), { status: 500, headers });
  }
}
