import type { Env } from "../[[route]]";
import { verifyJWT, getJwtSecret } from "../_utils/jwt";

/**
 * ユーザーの通知一覧を取得します。
 * GET /api/notifications
 */
export async function handleGetNotifications(
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
    let userId = request.headers.get("X-User-Id");
    if (!userId) {
      const authHeader = request.headers.get("Authorization");
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7);
        const secret = getJwtSecret(env);
        const payload = await verifyJWT(token, secret);
        if (payload && payload.userId) {
          userId = payload.userId as string;
        }
      }
    }

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
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };

  try {
    let userId = request.headers.get("X-User-Id");
    if (!userId) {
      const authHeader = request.headers.get("Authorization");
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7);
        const secret = getJwtSecret(env);
        const payload = await verifyJWT(token, secret);
        if (payload && payload.userId) {
          userId = payload.userId as string;
        }
      }
    }

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
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };

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
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };

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
  const origin = request.headers.get("Origin") || "*";
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };

  try {
    let userId = request.headers.get("X-User-Id");
    if (userId) {
      try {
        await env.DB.prepare(
          "UPDATE notifications SET is_read = 1 WHERE workspace_id = ? AND user_id = ?"
        ).bind(workspaceId, userId).run();
      } catch (e) {}
    }

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
