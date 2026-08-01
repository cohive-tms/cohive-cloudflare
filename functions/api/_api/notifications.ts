import type { Env } from "../[[route]]";
import { verifyUserAuth, verifyWorkspaceMember } from "../_utils/jwt";
import { getCorsHeaders } from "../_utils/cors";

/**
 * ユーザーの通知一覧を取得します。
 * GET /api/notifications
 */
export async function handleGetNotifications(
  request: Request,
  env: Env
): Promise<Response> {
  const headers = getCorsHeaders(request, "GET, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);

    if (!userId) {
      return new Response(JSON.stringify({ success: true, data: [], unreadCount: 0 }), {
        status: 200,
        headers,
      });
    }

    try {
      const { results: notifications } = await env.DB.prepare(`
        SELECT id, user_id as userId, workspace_id as workspaceId, type, title, message, link_url as linkUrl, is_read as isRead, created_at as createdAt
        FROM notifications
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 100
      `).bind(userId).all<any>();

      const formatted = (notifications || []).map((n: any) => ({
        ...n,
        isRead: Boolean(n.isRead),
      }));

      const unreadCount = formatted.filter((n: any) => !n.isRead).length;

      return new Response(JSON.stringify({
        success: true,
        data: formatted,
        unreadCount
      }), {
        status: 200,
        headers,
      });
    } catch (tblErr) {
      return new Response(JSON.stringify({ success: true, data: [], unreadCount: 0 }), {
        status: 200,
        headers,
      });
    }
  } catch (error: any) {
    console.error("Failed to fetch notifications:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * 未読通知件数を取得します。
 * GET /api/notifications/unread-count
 */
export async function handleGetUnreadNotificationsCount(
  request: Request,
  env: Env
): Promise<Response> {
  const headers = getCorsHeaders(request, "GET, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);

    if (!userId) {
      return new Response(JSON.stringify({ success: true, count: 0 }), {
        status: 200,
        headers,
      });
    }

    try {
      const res = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0"
      ).bind(userId).first<{ count: number }>();

      return new Response(JSON.stringify({
        success: true,
        count: res?.count || 0
      }), {
        status: 200,
        headers,
      });
    } catch (tblErr) {
      return new Response(JSON.stringify({ success: true, count: 0 }), {
        status: 200,
        headers,
      });
    }
  } catch (error: any) {
    console.error("Failed to fetch unread notifications count:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * 通知を既読にします。
 * PUT /api/notifications/:id/read
 */
export async function handleMarkNotificationAsRead(
  request: Request,
  env: Env,
  notificationId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "PUT, OPTIONS");

  try {
    try {
      await env.DB.prepare(
        "UPDATE notifications SET is_read = 1 WHERE id = ?"
      ).bind(notificationId).run();
    } catch (e) {}

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to mark notification as read:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * 通知をアーカイブします。
 * PUT /api/notifications/:id/archive
 */
export async function handleArchiveNotification(
  request: Request,
  env: Env,
  notificationId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "PUT, OPTIONS");

  try {
    try {
      await env.DB.prepare(
        "DELETE FROM notifications WHERE id = ?"
      ).bind(notificationId).run();
    } catch (e) {}

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to archive notification:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * ワークスペースの全通知を既読にします。
 * PUT /api/workspaces/:workspaceId/notifications/read-all
 */
export async function handleMarkAllNotificationsAsRead(
  request: Request,
  env: Env,
  workspaceId: string
): Promise<Response> {
  const headers = getCorsHeaders(request, "PUT, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
    if (!(await verifyWorkspaceMember(env, workspaceId, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }

    try {
      await env.DB.prepare(
        "UPDATE notifications SET is_read = 1 WHERE workspace_id = ? AND user_id = ?"
      ).bind(workspaceId, userId).run();
    } catch (e) {}

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    console.error("Failed to mark all notifications as read:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}
