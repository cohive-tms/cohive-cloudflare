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
import { handleUploadAvatar, handleGetAvatar } from "./_api/avatars";
import { handleLogin, handleChangePassword, handleRefresh, handleLogout, handleVerifyMfa, handleRegister } from "./_api/auth";
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
  handleDeleteChannelMember,
  handleGetEmailChangeStatus,
  handleRequestEmailChange,
  handleConfirmEmailChange
} from "./_api/chat/member";
import {
  handleGetNotifications,
  handleReadNotification,
  handleReadAllNotifications,
  handleArchiveNotification,
  handleGetUnreadNotificationsCount
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
import { handleSearchWorkspace } from "./_api/chat/search";
import {
  handleCreateCustomEmoji,
  handleGetCustomEmojis,
  handleDeleteCustomEmoji,
  handleGetCustomEmojiRaw
} from "./_api/chat/emoji";
import {
  handleGetDocumentLock,
  handleAcquireDocumentLock,
  handleHeartbeatDocumentLock,
  handleReleaseDocumentLock
} from "./_api/document_locks";
import {
  handlePinMessage,
  handleUnpinMessage,
  handleGetPinnedMessages,
  handleStarChannel,
  handleUnstarChannel
} from "./_api/pins_and_stars";
import { handleGetVapidPublicKey, handleSubscribe, handleSendTestPush, handleUnsubscribeAll, handleCheckRegistration } from "./_api/push";
import { getWorkspaceSubscription } from "./_utils/saas";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  RATE_LIMITER?: any;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  JWT_SECRET?: string;
  SAAS_LIMITS?: any;
  ENCRYPTION_SECRET?: string;
  ALLOWED_ORIGINS?: string;
}

async function runMigrations(env: Env) {
  // 1. users テーブルの既存データベースへの自動カラム追加（動的マイグレーション）
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

  try {
    await env.DB.prepare("SELECT last_active_at FROM users LIMIT 1").all();
  } catch (colErr: any) {
    if (colErr.message && (colErr.message.includes("no such column") || colErr.message.includes("has no column"))) {
      console.log("Database Migration: Adding last_active_at column to users table...");
      await env.DB.prepare("ALTER TABLE users ADD COLUMN last_active_at DATETIME").run();
    }
  }

  // 2. system_settings テーブルが存在するか確認、なければ作成
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

  // 3. document_locks テーブルが存在するか確認、なければ作成 (0003相当)
  try {
    await env.DB.prepare("SELECT 1 FROM document_locks LIMIT 1").all();
  } catch (tblErr: any) {
    if (tblErr.message && (tblErr.message.includes("no such table") || tblErr.message.includes("does not exist"))) {
      console.log("Database Migration: Creating document_locks table...");
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS document_locks (
          lock_key TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          user_display_name TEXT NOT NULL,
          locked_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        )
      `).run();
    }
  }

  // 4. message_pins テーブルが存在するか確認、なければ作成 (0004相当)
  try {
    await env.DB.prepare("SELECT 1 FROM message_pins LIMIT 1").all();
  } catch (tblErr: any) {
    if (tblErr.message && (tblErr.message.includes("no such table") || tblErr.message.includes("does not exist"))) {
      console.log("Database Migration: Creating message_pins table...");
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS message_pins (
          message_id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          pinned_by TEXT NOT NULL,
          pinned_at TEXT NOT NULL
        )
      `).run();
    }
  }

  // 5. channel_stars テーブルが存在するか確認、なければ作成 (0004相当)
  try {
    await env.DB.prepare("SELECT 1 FROM channel_stars LIMIT 1").all();
  } catch (tblErr: any) {
    if (tblErr.message && (tblErr.message.includes("no such table") || tblErr.message.includes("does not exist"))) {
      console.log("Database Migration: Creating channel_stars table...");
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS channel_stars (
          user_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          starred_at TEXT NOT NULL,
          PRIMARY KEY (user_id, channel_id)
        )
      `).run();
    }
  }

  // 6. messages_fts (FTS5) テーブルとトリガーが存在するか確認、なければ作成 (0005相当)
  try {
    await env.DB.prepare("SELECT 1 FROM messages_fts LIMIT 1").all();
  } catch (tblErr: any) {
    if (tblErr.message && (tblErr.message.includes("no such table") || tblErr.message.includes("does not exist"))) {
      console.log("Database Migration: Creating messages_fts table and triggers...");
      await env.DB.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          message_id,
          content,
          tokenize='trigram'
        )
      `).run();

      await env.DB.prepare(`
        CREATE TRIGGER IF NOT EXISTS after_messages_insert AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(message_id, content) VALUES(new.id, new.content);
        END
      `).run();

      await env.DB.prepare(`
        CREATE TRIGGER IF NOT EXISTS after_messages_update AFTER UPDATE ON messages BEGIN
          UPDATE messages_fts SET content = new.content WHERE message_id = old.id;
        END
      `).run();

      await env.DB.prepare(`
        CREATE TRIGGER IF NOT EXISTS after_messages_delete AFTER DELETE ON messages BEGIN
          DELETE FROM messages_fts WHERE message_id = old.id;
        END
      `).run();

      // 既存データの流し込み
      try {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO messages_fts (message_id, content)
          SELECT id, content FROM messages
        `).run();
      } catch (dataErr) {
        console.error("FTS messages sync failed:", dataErr);
      }
    }
  }

  // 7. documents_fts (FTS5) テーブルとトリガーが存在するか確認、なければ作成 (0005相当)
  try {
    await env.DB.prepare("SELECT 1 FROM documents_fts LIMIT 1").all();
  } catch (tblErr: any) {
    if (tblErr.message && (tblErr.message.includes("no such table") || tblErr.message.includes("does not exist"))) {
      console.log("Database Migration: Creating documents_fts table and triggers...");
      await env.DB.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
          source_type,
          source_id,
          title,
          content,
          tokenize='trigram'
        )
      `).run();

      await env.DB.prepare(`
        CREATE TRIGGER IF NOT EXISTS after_workspaces_insert AFTER INSERT ON workspaces BEGIN
          INSERT INTO documents_fts(source_type, source_id, title, content) VALUES('workspace', new.id, new.name, COALESCE(new.document, ''));
        END
      `).run();

      await env.DB.prepare(`
        CREATE TRIGGER IF NOT EXISTS after_workspaces_update AFTER UPDATE ON workspaces BEGIN
          DELETE FROM documents_fts WHERE source_type = 'workspace' AND source_id = old.id;
          INSERT INTO documents_fts(source_type, source_id, title, content) VALUES('workspace', new.id, new.name, COALESCE(new.document, ''));
        END
      `).run();

      await env.DB.prepare(`
        CREATE TRIGGER IF NOT EXISTS after_workspaces_delete AFTER DELETE ON workspaces BEGIN
          DELETE FROM documents_fts WHERE source_type = 'workspace' AND source_id = old.id;
        END
      `).run();

      await env.DB.prepare(`
        CREATE TRIGGER IF NOT EXISTS after_channels_insert AFTER INSERT ON channels BEGIN
          INSERT INTO documents_fts(source_type, source_id, title, content) VALUES('channel', new.id, new.name, COALESCE(new.document, ''));
        END
      `).run();

      await env.DB.prepare(`
        CREATE TRIGGER IF NOT EXISTS after_channels_update AFTER UPDATE ON channels BEGIN
          DELETE FROM documents_fts WHERE source_type = 'channel' AND source_id = old.id;
          INSERT INTO documents_fts(source_type, source_id, title, content) VALUES('channel', new.id, new.name, COALESCE(new.document, ''));
        END
      `).run();

      await env.DB.prepare(`
        CREATE TRIGGER IF NOT EXISTS after_channels_delete AFTER DELETE ON channels BEGIN
          DELETE FROM documents_fts WHERE source_type = 'channel' AND source_id = old.id;
        END
      `).run();

      // 既存データの流し込み
      try {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO documents_fts (source_type, source_id, title, content)
          SELECT 'workspace', id, name, COALESCE(document, '') FROM workspaces
        `).run();

        await env.DB.prepare(`
          INSERT OR IGNORE INTO documents_fts (source_type, source_id, title, content)
          SELECT 'channel', id, name, COALESCE(document, '') FROM channels
        `).run();
      } catch (dataErr) {
        console.error("FTS documents sync failed:", dataErr);
      }
    }
  }

  // 8. custom_emojis テーブルが存在するか確認、なければ作成 (0005相当)
  try {
    await env.DB.prepare("SELECT 1 FROM custom_emojis LIMIT 1").all();
  } catch (tblErr: any) {
    if (tblErr.message && (tblErr.message.includes("no such table") || tblErr.message.includes("does not exist"))) {
      console.log("Database Migration: Creating custom_emojis table...");
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS custom_emojis (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          code TEXT NOT NULL,
          url TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE (workspace_id, code)
        )
      `).run();
    }
  }

  // 9. push_vapid_key テーブルが存在するか確認、なければ作成
  try {
    await env.DB.prepare("SELECT 1 FROM push_vapid_key LIMIT 1").all();
  } catch (tblErr: any) {
    if (tblErr.message && (tblErr.message.includes("no such table") || tblErr.message.includes("does not exist"))) {
      console.log("Database Migration: Creating push_vapid_key table...");
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS push_vapid_key (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          public_key TEXT NOT NULL,
          private_key TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `).run();
    }
  }

  // 10. push_subscriptions テーブルが存在するか確認、なければ作成
  try {
    await env.DB.prepare("SELECT 1 FROM push_subscriptions LIMIT 1").all();
  } catch (tblErr: any) {
    if (tblErr.message && (tblErr.message.includes("no such table") || tblErr.message.includes("does not exist"))) {
      console.log("Database Migration: Creating push_subscriptions table...");
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(user_id, endpoint)
        )
      `).run();
    }
  }

  // 7. login_verification_codes テーブルが存在するか確認、なければ作成
  try {
    await env.DB.prepare("SELECT 1 FROM login_verification_codes LIMIT 1").all();
  } catch (tblErr: any) {
    if (tblErr.message && (tblErr.message.includes("no such table") || tblErr.message.includes("does not exist"))) {
      console.log("Database Migration: Creating login_verification_codes table...");
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS login_verification_codes (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            code TEXT NOT NULL,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `).run();
      await env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_login_verification_codes_user_id ON login_verification_codes(user_id)
      `).run();
    }
  }

  // 11. 未読通知カウント高速化インデックスの追加
  try {
    await env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_notifications_unread_lookup ON notifications(user_id, is_read, is_archived)
    `).run();
  } catch (idxErr) {
    console.error("Database Migration: Failed to create idx_notifications_unread_lookup:", idxErr);
  }
}

async function ensureDatabaseInitialized(env: Env) {
  try {
    await env.DB.prepare("SELECT 1 FROM users LIMIT 1").all();
    
    // 既存データベースに自動マイグレーションを実行
    await runMigrations(env);
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
      
      // 初期化直後にも追加のマイグレーションを実行
      await runMigrations(env);
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

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // データベースの自動初期化
  try {
    await ensureDatabaseInitialized(env);
  } catch (err) {
    console.error("Failed to auto-initialize database:", err);
  }

  const url = new URL(request.url);

  // API以外のリクエスト（静的アセットやSPAルーティングなど）はアセットサーバーへ直接パススルーする
  if (!url.pathname.startsWith("/api/")) {
    return await context.next();
  }

  const requestOrigin = request.headers.get("Origin");
  let origin = "*";

  if (requestOrigin) {
    if (env.ALLOWED_ORIGINS) {
      const allowed = env.ALLOWED_ORIGINS.split(",")
        .map(o => o.trim())
        .filter(o => o.length > 0);
      if (allowed.includes(requestOrigin)) {
        origin = requestOrigin;
      } else {
        origin = "null";
      }
    } else {
      origin = requestOrigin;
    }
  }

  const method = request.method;

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

  let response: Response;
  try {
    response = await handleApiRequests(context, origin);
  } catch (error: any) {
    response = new Response(
      JSON.stringify({ error: error.message || "Internal Server Error" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }

  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("Access-Control-Allow-Origin", origin);
  responseHeaders.set("Access-Control-Allow-Credentials", "true");
  responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  responseHeaders.set("Access-Control-Allow-Headers", "Content-Type, X-Workspace-Id, X-User-Id, Authorization");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
};

async function handleApiRequests(context: EventContext<Env, any, any>, origin: string): Promise<Response> {
  const { request: req, env } = context;
  let request = req;
  const url = new URL(request.url);
  const method = request.method;

  // レートリミットの適用（ログイン・リカバリー、高負荷・書き込み系APIが対象）
  const isAuthPost = (url.pathname === "/api/auth/login" || url.pathname === "/api/auth/recovery") && method === "POST";
  const isMessagePost = (url.pathname.match(/^\/api\/channels\/([^\/]+)\/messages$/) || url.pathname === "/api/messages") && method === "POST";
  const isSearchGet = url.pathname.includes("/search") && method === "GET";

  if (isAuthPost || isMessagePost || isSearchGet) {
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
  const isEmojiRawRoute = !!url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/emojis\/raw\/([^\/]+)$/);
  const isAdminRoute = url.pathname.startsWith("/api/admin/");
  const isPublicRoute = 
    url.pathname === "/api/auth/login" ||
    url.pathname === "/api/auth/login/verify" ||
    url.pathname === "/api/auth/register" ||
    url.pathname === "/api/auth/refresh" ||
    url.pathname === "/api/auth/recovery" ||
    url.pathname === "/api/setup/status" ||
    url.pathname === "/api/setup/register" ||
    isEmojiRawRoute ||
    isAdminRoute;

  let authenticatedUserId: string | null = null;

  const isApiRoute = url.pathname.startsWith("/api/");
  if (isApiRoute && !isPublicRoute) {
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
    // 最終アクティブ日時の更新
    const updateActiveTime = async () => {
      try {
        await env.DB.prepare(
          "UPDATE users SET last_active_at = datetime('now') WHERE id = ?"
        ).bind(authenticatedUserId).run();
      } catch (e) {
        console.error("Failed to update last_active_at:", e);
      }
    };
    if (context && typeof (context as any).waitUntil === "function") {
      (context as any).waitUntil(updateActiveTime());
    } else if (context && (context as any).ctx && typeof (context as any).ctx.waitUntil === "function") {
      (context as any).ctx.waitUntil(updateActiveTime());
    } else {
      updateActiveTime();
    }

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
    if (url.pathname === "/api/auth/register" && method === "POST") {
      return await handleRegister(request, env);
    }
    if (url.pathname === "/api/auth/login" && method === "POST") {
      return await handleLogin(request, env);
    }
    if (url.pathname === "/api/auth/login/verify" && method === "POST") {
      return await handleVerifyMfa(request, env);
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
    if (url.pathname === "/api/users/email-change-status" && method === "GET") {
      return await handleGetEmailChangeStatus(request, env);
    }
    if (url.pathname === "/api/users/email-change-request" && method === "POST") {
      return await handleRequestEmailChange(request, env);
    }
    if (url.pathname === "/api/users/email-change-confirm" && method === "POST") {
      return await handleConfirmEmailChange(request, env);
    }
    if (url.pathname === "/api/push/vapid-public-key" && method === "GET") {
      return await handleGetVapidPublicKey(request, env);
    }
    if (url.pathname === "/api/push/subscribe" && method === "POST") {
      return await handleSubscribe(request, env);
    }
    if (url.pathname === "/api/push/test" && method === "POST") {
      return await handleSendTestPush(request, env);
    }
    if (url.pathname === "/api/push/unsubscribe-all" && method === "POST") {
      return await handleUnsubscribeAll(request, env);
    }
    if (url.pathname === "/api/push/check-registration" && method === "POST") {
      return await handleCheckRegistration(request, env);
    }

    // 2. R2 ファイル添付関連 API (S3 署名付きURL)
    if (url.pathname === "/api/files/presigned-upload" && method === "GET") {
      return await handleGetPresignedUploadUrl(request, env);
    }
    if (url.pathname === "/api/files/presigned-download" && method === "GET") {
      return await handleGetPresignedDownloadUrl(request, env);
    }

    // 3. R2 ファイル添付関連 API (Workers プロキシ直接アップロード)
    if (url.pathname === "/api/avatars/upload" && method === "POST") {
      return await handleUploadAvatar(request, env);
    }
    if (url.pathname.startsWith("/api/avatars/") && method === "GET") {
      const filename = url.pathname.replace("/api/avatars/", "");
      return await handleGetAvatar(request, env, filename);
    }
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

    // 一般ユーザー向け SaaS プラン一覧 API
    if (url.pathname === "/api/plans") {
      if (method === "GET") return await handleGetPublicSaaSPlans(request, env);
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
    }

    // 4. ワークスペース関連 API
    if (url.pathname === "/api/workspaces" && method === "GET") {
      return await handleGetWorkspaces(request, env);
    }
    if (url.pathname === "/api/workspaces" && method === "POST") {
      return await handleCreateWorkspace(request, env);
    }
    const subscriptionMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/subscription$/);
    if (subscriptionMatch && method === "GET") {
      const workspaceId = subscriptionMatch[1];
      try {
        const data = await getWorkspaceSubscription(env, workspaceId);
        
        let stripeEnabled = false;
        let stripePublishableKey = "";
        try {
          const stripeSettings = await getStripeSettings(env);
          stripeEnabled = stripeSettings?.enabled || false;
          stripePublishableKey = stripeSettings?.publishableKey || "";
        } catch {}

        return new Response(JSON.stringify({ 
          success: true, 
          data: {
            ...data,
            stripeEnabled,
            stripePublishableKey
          } 
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    }

    // 監査ログ（ワークスペース個別）
    const workspaceAuditLogsMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/audit-logs$/);
    if (workspaceAuditLogsMatch) {
      const workspaceId = workspaceAuditLogsMatch[1];
      return await handleGetWorkspaceAuditLogs(request, env, workspaceId);
    }

    // Stripe Checkout
    const billingCheckoutMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/billing\/checkout$/);
    if (billingCheckoutMatch) {
      const workspaceId = billingCheckoutMatch[1];
      return await handleCreateBillingCheckout(request, env, workspaceId);
    }

    // Stripe Portal
    const billingPortalMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/billing\/portal$/);
    if (billingPortalMatch) {
      const workspaceId = billingPortalMatch[1];
      return await handleCreateBillingPortal(request, env, workspaceId);
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

    // 全文検索 API
    const workspaceSearchMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/search$/);
    if (workspaceSearchMatch && method === "GET") {
      const workspaceId = workspaceSearchMatch[1];
      return await handleSearchWorkspace(request, env, workspaceId);
    }

    // カスタム絵文字 API
    const workspaceEmojiRawMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/emojis\/raw\/([^\/]+)$/);
    if (workspaceEmojiRawMatch && method === "GET") {
      const workspaceId = workspaceEmojiRawMatch[1];
      const emojiIdWithExt = workspaceEmojiRawMatch[2];
      return await handleGetCustomEmojiRaw(request, env, workspaceId, emojiIdWithExt);
    }

    const workspaceEmojisMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/emojis$/);
    if (workspaceEmojisMatch) {
      const workspaceId = workspaceEmojisMatch[1];
      if (method === "GET") {
        return await handleGetCustomEmojis(request, env, workspaceId);
      }
      if (method === "POST") {
        return await handleCreateCustomEmoji(request, env, workspaceId);
      }
    }

    const workspaceEmojiDetailMatch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/emojis\/([^\/]+)$/);
    if (workspaceEmojiDetailMatch && method === "DELETE") {
      const workspaceId = workspaceEmojiDetailMatch[1];
      const emojiId = workspaceEmojiDetailMatch[2];
      return await handleDeleteCustomEmoji(request, env, workspaceId, emojiId);
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
    if (url.pathname === "/api/notifications/unread-count" && method === "GET") {
      return await handleGetUnreadNotificationsCount(request, env);
    }
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

    // 12. ドキュメントロック関連 API
    const lockMatch = url.pathname.match(/^\/api\/document-locks\/([^\/]+)(?:\/([^\/]+))?$/);
    if (lockMatch) {
      const lockKey = decodeURIComponent(lockMatch[1]);
      const action = lockMatch[2]; // undefined, "acquire", "heartbeat", "release"
      
      if (!action && method === "GET") {
        return await handleGetDocumentLock(request, env, lockKey);
      }
      if (action === "acquire" && method === "POST") {
        return await handleAcquireDocumentLock(request, env, lockKey);
      }
      if (action === "heartbeat" && method === "POST") {
        return await handleHeartbeatDocumentLock(request, env, lockKey);
      }
      if (action === "release" && method === "POST") {
        return await handleReleaseDocumentLock(request, env, lockKey);
      }
    }

    // 13. ピン留め ＆ スター関連 API
    const pinMatch = url.pathname.match(/^\/api\/messages\/([^\/]+)\/(pin|unpin)$/);
    if (pinMatch) {
      const messageId = pinMatch[1];
      const action = pinMatch[2];
      if (action === "pin" && method === "POST") {
        return await handlePinMessage(request, env, messageId);
      }
      if (action === "unpin" && method === "POST") {
        return await handleUnpinMessage(request, env, messageId);
      }
    }

    const channelPinsMatch = url.pathname.match(/^\/api\/channels\/([^\/]+)\/pins$/);
    if (channelPinsMatch) {
      const channelId = channelPinsMatch[1];
      if (method === "GET") {
        return await handleGetPinnedMessages(request, env, channelId);
      }
    }

    const starMatch = url.pathname.match(/^\/api\/channels\/([^\/]+)\/(star|unstar)$/);
    if (starMatch) {
      const channelId = starMatch[1];
      const action = starMatch[2];
      if (action === "star" && method === "POST") {
        return await handleStarChannel(request, env, channelId);
      }
      if (action === "unstar" && method === "POST") {
        return await handleUnstarChannel(request, env, channelId);
      }
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
