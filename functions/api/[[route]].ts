import { handleSetupStatus, handleSetupRegister } from "./_api/setup";
import { verifyJWT, getJwtSecret } from "./_utils/jwt";
import { INIT_SQL } from "./_utils/schema";
import { 
  handleGetPresignedUploadUrl, 
  handleGetPresignedDownloadUrl, 
  handleDirectUpload, 
  handleDirectDownload,
  handleGetMediaLibrary,
  handleDeleteFile
} from "./_api/files";
import { handleLogin, handleChangePassword, handleRefresh, handleLogout } from "./_api/auth";
import {
  handleGetItems,
  handleCreateItem,
  handleUpdateItem,
  handleDeleteItem
} from "./_api/items";
import {
  handleGetWorkspaces,
  handleCreateWorkspace,
  handleUpdateWorkspace,
  handleDeleteWorkspace
} from "./_api/chat/workspace";
import {
  handleGetChannels,
  handleCreateChannel,
  handleUpdateChannel,
  handleDeleteChannel,
  handleBrowseChannels
} from "./_api/chat/channel";
import {
  handleGetMessages,
  handleCreateMessage,
  handleGetMessagesGeneral,
  handleCreateMessageGeneral,
  handleToggleReaction
} from "./_api/chat/message";
import {
  handleGetGroups,
  handleCreateGroup,
  handleUpdateGroup,
  handleDeleteGroup
} from "./_api/chat/group";
import {
  handleUpdateUser,
  handleGetWorkspaceMembers,
  handleAddWorkspaceMember,
  handleUpdateWorkspaceMember,
  handleDeleteWorkspaceMember,
  handleGetWorkspaceUserRole,
  handleGetGroupMembers,
  handleAddGroupMember,
  handleUpdateGroupMember,
  handleDeleteGroupMember,
  handleGetChannelMembers,
  handleAddChannelMember,
  handleDeleteChannelMember
} from "./_api/chat/member";
import {
  handleGetNotifications,
  handleReadNotification,
  handleReadAllNotifications,
  handleArchiveNotification
} from "./_api/notifications";
import {
  handleGetWorkspaceDocument,
  handleUpdateWorkspaceDocument,
  handleGetChannelDocument,
  handleUpdateChannelDocument
} from "./_api/document";
import {
  handleRecovery,
  handleResetMemberPassword,
  handleSaveSmtpSettings,
  handleGetSmtpSettings,
  handleDeleteSmtpSettings,
  handleTestSmtpSettings
} from "./_api/auth-recovery";
import { handleGetActivities } from "./_api/activities";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  RATE_LIMITER?: any;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  JWT_SECRET?: string;
}

async function ensureDatabaseInitialized(env: Env) {
  try {
    await env.DB.prepare("SELECT 1 FROM users LIMIT 1").all();
    
    // 既存データベースへの自動カラム追加（動的マイグレーション）
    try {
      await env.DB.prepare("SELECT recovery_code_hash FROM users LIMIT 1").all();
    } catch (colErr: any) {
      if (colErr.message && (colErr.message.includes("no such column") || colErr.message.includes("has no column"))) {
        console.log("Database Migration: Adding recovery_code_hash column to users table...");
        await env.DB.prepare("ALTER TABLE users ADD COLUMN recovery_code_hash TEXT").run();
      }
    }

    try {
      await env.DB.prepare("SELECT language FROM users LIMIT 1").all();
    } catch (colErr: any) {
      if (colErr.message && (colErr.message.includes("no such column") || colErr.message.includes("has no column"))) {
        console.log("Database Migration: Adding language column to users table...");
        await env.DB.prepare("ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'ja'").run();
      }
    }

    // system_settings テーブルが存在するか確認、なければ作成
    try {
      await env.DB.prepare("SELECT 1 FROM system_settings LIMIT 1").all();
    } catch (tblErr: any) {
      if (tblErr.message && (tblErr.message.includes("no such table") || tblErr.message.includes("does not exist"))) {
        console.log("Database Migration: Creating system_settings table...");
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS system_settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `).run();
      }
    }
  } catch (e: any) {
    if (e.message && (e.message.includes("no such table") || e.message.includes("does not exist"))) {
      console.log("Database not initialized. Running initial schema...");
      
      // コメント行を除去し、セミコロンで分割して一括バッチ実行（本番環境D1の複数クエリ実行制限を回避）
      const cleanSql = INIT_SQL.split("\n")
        .filter(line => !line.trim().startsWith("--"))
        .join("\n");

      const statements = cleanSql.split(";")
        .map(sql => sql.trim())
        .filter(sql => sql.length > 0)
        .map(sql => env.DB.prepare(sql));

      await env.DB.batch(statements);
      console.log("Database initialized successfully.");
    } else {
      throw e;
    }
  }
}

async function checkSetupInterceptor(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  // セットアップ登録（POST）およびセットアップステータスチェック（GET）が対象
  if (url.pathname === "/api/setup/register" && request.method === "POST") {
    try {
      const { results } = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM users"
      ).all<{ count: number }>();
      const count = results?.[0]?.count ?? 0;
      if (count > 0) {
        return new Response(JSON.stringify({ 
          error: "Setup has already been completed. Administrator registration is locked." 
        }), {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          }
        });
      }
    } catch (e) {
      console.error("Middleware DB check failed:", e);
    }
  }
  return null;
}

/**
 * Cloudflare Pages Functions の統合エントリーポイント。
 */
export const onRequest: PagesFunction<Env> = async (context) => {
  const { request: req, env } = context;

  // データベースの自動初期化
  try {
    await ensureDatabaseInitialized(env);
  } catch (err) {
    console.error("Failed to auto-initialize database:", err);
  }

  let request = req;
  const url = new URL(request.url);
  const method = request.method;

  const origin = request.headers.get("Origin") || "*";

  // CORSのプリフライト (OPTIONS) リクエストへの共通応答
  if (method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // レートリミットの適用（ログイン・リカバリーAPIが対象）
  if (
    (url.pathname === "/api/auth/login" || url.pathname === "/api/auth/recovery") &&
    method === "POST"
  ) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return new Response(JSON.stringify({ error: "Too Many Requests. Please try again later." }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
          }
        });
      }
    } catch (limiterErr) {
      // ローカル環境などで RATE_LIMITER がバインドされていない場合は無視して続行
      console.warn("Rate limiter failed or not bound:", limiterErr);
    }
  }

  // JWT認証検証 (CORSプリフライトOPTIONSリクエストは認証不要)
  const jwtSecret = await getJwtSecret(env);
  const isPublicRoute = 
    url.pathname === "/api/auth/login" ||
    url.pathname === "/api/auth/refresh" ||
    url.pathname === "/api/auth/recovery" ||
    url.pathname === "/api/setup/status" ||
    url.pathname === "/api/setup/register";

  let authenticatedUserId: string | null = null;

  if (!isPublicRoute) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Authorization token required" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Credentials": "true",
        }
      });
    }

    const token = authHeader.substring(7);
    const payload = await verifyJWT(token, jwtSecret);
    if (!payload || payload.type !== "access" || !payload.userId) {
      return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Credentials": "true",
        }
      });
    }

    authenticatedUserId = payload.userId;
  }

  // X-User-Id ヘッダーの値を暗号署名検証済みのIDで上書き（なりすまし偽造ヘッダーを完全無効化）
  if (authenticatedUserId) {
    const newHeaders = new Headers(request.headers);
    newHeaders.set("X-User-Id", authenticatedUserId);
    request = new Request(req, {
      headers: newHeaders
    }) as any;
  }

  // ミドルウェア/インターセプターの適用
  const setupError = await checkSetupInterceptor(request, env);
  if (setupError) {
    return setupError;
  }

  try {
    // 1. 初期セットアップ関連 API / 認証 API / ユーザープロフィール API
    if (url.pathname === "/api/setup/status" && method === "GET") {
      return await handleSetupStatus(request, env);
    }
    if (url.pathname === "/api/setup/register" && method === "POST") {
      return await handleSetupRegister(request, env);
    }
    if (url.pathname === "/api/auth/recovery" && method === "POST") {
      return await handleRecovery(request, env);
    }
    if (url.pathname === "/api/auth/login" && method === "POST") {
      return await handleLogin(request, env);
    }
    if (url.pathname === "/api/auth/refresh" && method === "POST") {
      return await handleRefresh(request, env);
    }
    if (url.pathname === "/api/auth/logout" && method === "POST") {
      return await handleLogout(request, env);
    }
    if (url.pathname === "/api/auth/change-password" && method === "POST") {
      return await handleChangePassword(request, env);
    }
    if (url.pathname === "/api/users/me" && method === "PUT") {
      return await handleUpdateUser(request, env);
    }

    // 2. R2 ファイル添付関連 API (S3 署名付きURL)
    if (url.pathname === "/api/files/presigned-upload" && method === "GET") {
      return await handleGetPresignedUploadUrl(request, env);
    }
    if (url.pathname === "/api/files/presigned-download" && method === "GET") {
      return await handleGetPresignedDownloadUrl(request, env);
    }

    // 3. R2 ファイル添付関連 API (Workers プロキシ直接アップロード)
    if (url.pathname === "/api/files/upload" && method === "POST") {
      return await handleDirectUpload(request, env);
    }
    if (url.pathname.startsWith("/api/files/download/") && method === "GET") {
      return await handleDirectDownload(request, env);
    }
    if (url.pathname.startsWith("/api/files/") && method === "DELETE") {
      return await handleDeleteFile(request, env);
    }
    if (url.pathname === "/api/media" && method === "GET") {
      return await handleGetMediaLibrary(request, env);
    }

    // 4. ワークスペース関連 API
    if (url.pathname === "/api/workspaces" && method === "GET") {
      return await handleGetWorkspaces(request, env);
    }
    if (url.pathname === "/api/workspaces" && method === "POST") {
      return await handleCreateWorkspace(request, env);
    }
    const workspaceMembersMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/members$/);
    if (workspaceMembersMatch) {
      const workspaceId = workspaceMembersMatch[1];
      if (method === "GET") {
        return await handleGetWorkspaceMembers(request, env, workspaceId);
      }
      if (method === "POST") {
        return await handleAddWorkspaceMember(request, env, workspaceId);
      }
    }
    const workspaceMemberDetailMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/members\/([^\/]+)$/);
    if (workspaceMemberDetailMatch) {
      const workspaceId = workspaceMemberDetailMatch[1];
      const userId = workspaceMemberDetailMatch[2];
      if (method === "PUT") {
        return await handleUpdateWorkspaceMember(request, env, workspaceId, userId);
      }
      if (method === "DELETE") {
        return await handleDeleteWorkspaceMember(request, env, workspaceId, userId);
      }
    }
    const workspaceMemberResetPasswordMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/members\/([^\/]+)\/reset-password$/);
    if (workspaceMemberResetPasswordMatch) {
      const workspaceId = workspaceMemberResetPasswordMatch[1];
      const userId = workspaceMemberResetPasswordMatch[2];
      if (method === "POST") {
        return await handleResetMemberPassword(request, env, { workspaceId, userId });
      }
    }
    const workspaceRoleMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/role$/);
    if (workspaceRoleMatch && method === "GET") {
      const workspaceId = workspaceRoleMatch[1];
      return await handleGetWorkspaceUserRole(request, env, workspaceId);
    }
    const workspaceDocumentMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/document$/);
    if (workspaceDocumentMatch) {
      const workspaceId = workspaceDocumentMatch[1];
      if (method === "GET") {
        return await handleGetWorkspaceDocument(request, env, workspaceId);
      }
      if (method === "PUT") {
        return await handleUpdateWorkspaceDocument(request, env, workspaceId);
      }
    }
    const workspaceMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)$/);
    if (workspaceMatch) {
      const workspaceId = workspaceMatch[1];
      if (method === "PUT") {
        return await handleUpdateWorkspace(request, env, workspaceId);
      }
      if (method === "DELETE") {
        return await handleDeleteWorkspace(request, env, workspaceId);
      }
    }

    // 4-2. グループ関連 API
    const workspaceGroupsMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/groups$/);
    if (workspaceGroupsMatch) {
      const workspaceId = workspaceGroupsMatch[1];
      if (method === "GET") {
        return await handleGetGroups(request, env, workspaceId);
      }
      if (method === "POST") {
        return await handleCreateGroup(request, env, workspaceId);
      }
    }
    const groupMembersMatch = url.pathname.match(/^\/api\/groups\/([^\/]+)\/members$/);
    if (groupMembersMatch) {
      const groupId = groupMembersMatch[1];
      if (method === "GET") {
        return await handleGetGroupMembers(request, env, groupId);
      }
      if (method === "POST") {
        return await handleAddGroupMember(request, env, groupId);
      }
    }
    const groupMemberDetailMatch = url.pathname.match(/^\/api\/groups\/([^\/]+)\/members\/([^\/]+)$/);
    if (groupMemberDetailMatch) {
      const groupId = groupMemberDetailMatch[1];
      const userId = groupMemberDetailMatch[2];
      if (method === "PUT") {
        return await handleUpdateGroupMember(request, env, groupId, userId);
      }
      if (method === "DELETE") {
        return await handleDeleteGroupMember(request, env, groupId, userId);
      }
    }
    const groupMatch = url.pathname.match(/^\/api\/groups\/([^\/]+)$/);
    if (groupMatch) {
      const groupId = groupMatch[1];
      if (method === "PUT") {
        return await handleUpdateGroup(request, env, groupId);
      }
      if (method === "DELETE") {
        return await handleDeleteGroup(request, env, groupId);
      }
    }

    // 5. チャンネル関連 API
    const channelsMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/channels$/);
    if (channelsMatch) {
      const workspaceId = channelsMatch[1];
      if (method === "GET") {
        return await handleGetChannels(request, env, workspaceId);
      }
      if (method === "POST") {
        return await handleCreateChannel(request, env, workspaceId);
      }
    }
    const browseChannelsMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/browse-channels$/);
    if (browseChannelsMatch) {
      const workspaceId = browseChannelsMatch[1];
      if (method === "GET") {
        return await handleBrowseChannels(request, env, workspaceId);
      }
    }
    const channelDocumentMatch = url.pathname.match(/^\/api\/channels\/([^\/]+)\/document$/);
    if (channelDocumentMatch) {
      const channelId = channelDocumentMatch[1];
      if (method === "GET") {
        return await handleGetChannelDocument(request, env, channelId);
      }
      if (method === "PUT") {
        return await handleUpdateChannelDocument(request, env, channelId);
      }
    }
    const channelMatch = url.pathname.match(/^\/api\/channels\/([^\/]+)$/);
    if (channelMatch) {
      const channelId = channelMatch[1];
      if (method === "PUT") {
        return await handleUpdateChannel(request, env, channelId);
      }
      if (method === "DELETE") {
        return await handleDeleteChannel(request, env, channelId);
      }
    }

    // 5-2. チャンネルメンバー関連 API
    const channelMembersMatch = url.pathname.match(/^\/api\/channels\/([^\/]+)\/members$/);
    if (channelMembersMatch) {
      const channelId = channelMembersMatch[1];
      if (method === "GET") {
        return await handleGetChannelMembers(request, env, channelId);
      }
      if (method === "POST") {
        return await handleAddChannelMember(request, env, channelId);
      }
    }
    const channelMemberDetailMatch = url.pathname.match(/^\/api\/channels\/([^\/]+)\/members\/([^\/]+)$/);
    if (channelMemberDetailMatch) {
      const channelId = channelMemberDetailMatch[1];
      const userId = channelMemberDetailMatch[2];
      if (method === "DELETE") {
        return await handleDeleteChannelMember(request, env, channelId, userId);
      }
    }

    // 6. 新設 メッセージ共通 API
    if (url.pathname === "/api/messages") {
      if (method === "GET") {
        return await handleGetMessagesGeneral(request, env);
      }
      if (method === "POST") {
        return await handleCreateMessageGeneral(request, env);
      }
    }

    // 7. リアクション API
    const reactionMatch = url.pathname.match(/^\/api\/messages\/([^\/]+)\/reactions$/);
    if (reactionMatch) {
      if (method === "POST") {
        return await handleToggleReaction(request, env);
      }
    }

    // 8. メッセージ関連 API
    const messagesMatch = url.pathname.match(/^\/api\/channels\/([^\/]+)\/messages$/);
    if (messagesMatch) {
      const channelId = messagesMatch[1];
      if (method === "GET") {
        return await handleGetMessages(request, env, channelId);
      }
      if (method === "POST") {
        return await handleCreateMessage(request, env, channelId);
      }
    }

    // 9. アイテム（カレンダー・タスク統合）関連 API
    if (url.pathname === "/api/items" && method === "GET") {
      return await handleGetItems(request, env, "all");
    }
    const itemsMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/items$/);
    if (itemsMatch) {
      const workspaceId = itemsMatch[1];
      if (method === "GET") {
        return await handleGetItems(request, env, workspaceId);
      }
      if (method === "POST") {
        return await handleCreateItem(request, env, workspaceId);
      }
    }
    const itemDetailMatch = url.pathname.match(/^\/api\/items\/([^\/]+)$/);
    if (itemDetailMatch) {
      const itemId = itemDetailMatch[1];
      if (method === "PUT") {
        return await handleUpdateItem(request, env, itemId);
      }
      if (method === "DELETE") {
        return await handleDeleteItem(request, env, itemId);
      }
    }

    if (url.pathname === "/api/activities" && method === "GET") {
      return await handleGetActivities(request, env);
    }
    // 10. 通知関連 API
    if (url.pathname === "/api/notifications" && method === "GET") {
      return await handleGetNotifications(request, env, "all");
    }
    const notificationsMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/notifications$/);
    if (notificationsMatch) {
      const workspaceId = notificationsMatch[1];
      if (method === "GET") {
        return await handleGetNotifications(request, env, workspaceId);
      }
    }
    const notificationsReadAllMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/notifications\/read-all$/);
    if (notificationsReadAllMatch) {
      const workspaceId = notificationsReadAllMatch[1];
      if (method === "PUT") {
        return await handleReadAllNotifications(request, env, workspaceId);
      }
    }
    const notificationReadMatch = url.pathname.match(/^\/api\/notifications\/([^\/]+)\/read$/);
    if (notificationReadMatch) {
      const notificationId = notificationReadMatch[1];
      if (method === "PUT") {
        return await handleReadNotification(request, env, notificationId);
      }
    }
    const notificationArchiveMatch = url.pathname.match(/^\/api\/notifications\/([^\/]+)\/archive$/);
    if (notificationArchiveMatch) {
      const notificationId = notificationArchiveMatch[1];
      if (method === "PUT") {
        return await handleArchiveNotification(request, env, notificationId);
      }
    }

    // 11. SMTP 設定関連 API
    if (url.pathname === "/api/settings/smtp") {
      if (method === "GET") {
        return await handleGetSmtpSettings(request, env);
      }
      if (method === "POST") {
        return await handleSaveSmtpSettings(request, env);
      }
      if (method === "DELETE") {
        return await handleDeleteSmtpSettings(request, env);
      }
    }
    if (url.pathname === "/api/settings/smtp/test" && method === "POST") {
      return await handleTestSmtpSettings(request, env);
    }

    return new Response(JSON.stringify({ error: "API Route Not Found" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });

  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message || "Internal Server Error" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
};
