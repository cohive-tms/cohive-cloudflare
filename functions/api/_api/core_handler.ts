import { handleSetupStatus, handleSetupRegister } from "./setup";
import { verifyJWT, getJwtSecret } from "../_utils/jwt";
import { INIT_SQL } from "../_utils/schema";
  handleLogin, 
  handleChangePassword, 
  handleRefresh, 
  handleLogout, 
  handleVerifyMfa, 
  handleRegister,
  handleRecovery
} from "./auth";
import { handleGetWorkspaces, handleCreateWorkspace, handleUpdateWorkspace, handleDeleteWorkspace } from "./workspace";
import { 
  handleGetWorkspaceMembers, 
  handleAddWorkspaceMember, 
  handleReinviteMember,
  handleGetUserRole, 
  handleUpdateMemberRole, 
  handleRemoveMember, 
  handleUpdateUserProfile 
} from "./members";
import { 
  handleGetWorkspaceChannels, 
  handleBrowseChannels,
  handleCreateChannel, 
  handleUpdateChannel,
  handleJoinChannel,
  handleLeaveChannel,
  handleDeleteChannel, 
  handleGetChannelMembers,
  handleAddChannelMember,
  handleRemoveChannelMember,
  handleGetMessages, 
  handleSendMessage, 
  handleDeleteMessage, 
  handleAddReaction,
  handleDeleteReaction
} from "./channels";
import { 
  handleGetWorkspaceItems, 
  handleGetItems, 
  handleCreateItem, 
  handleUpdateItem, 
  handleDeleteItem 
} from "./items";
import { 
  handleGetWorkspaceDocument, 
  handleUpdateWorkspaceDocument,
  handleAcquireDocumentLock,
  handleHeartbeatDocumentLock,
  handleReleaseDocumentLock
} from "./documents";
import { 
  handleGetNotifications, 
  handleGetUnreadNotificationsCount, 
  handleMarkNotificationAsRead, 
  handleArchiveNotification,
  handleMarkAllNotificationsAsRead 
} from "./notifications";
import { 
  handleGetWorkspaceGroups, 
  handleCreateGroup, 
  handleDeleteGroup, 
  handleCreateOrGetDm 
} from "./groups";
import { 
  handleSearchWorkspace, 
  handleGetActivities, 
  handleGetCustomEmojis,
  handleCreateCustomEmoji
} from "./features";
import { 
  handleGetActiveAnnouncements,
  handleGetWorkspaceBranding
} from "./admin";
import { 
  handleGetPublicSaaSPlans, 
  handleCreateBillingCheckout, 
  handleCreateBillingPortal, 
  getStripeSettings,
  handleGetWorkspaceSubscription
} from "./saas_extensions";
import {
  handleFileUpload,
  handleAvatarUpload,
  handleFileDownload
} from "./files";
import { handlePushSubscribe } from "./push";

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
  try {
    await env.DB.prepare("SELECT recovery_code_hash FROM users LIMIT 1").all();
  } catch (colErr: any) {
    if (colErr.message && (colErr.message.includes("no such column") || colErr.message.includes("has no column"))) {
      await env.DB.prepare("ALTER TABLE users ADD COLUMN recovery_code_hash TEXT").run();
    }
  }

  try {
    await env.DB.prepare("SELECT language FROM users LIMIT 1").all();
  } catch (colErr: any) {
    if (colErr.message && (colErr.message.includes("no such column") || colErr.message.includes("has no column"))) {
      await env.DB.prepare("ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'ja'").run();
    }
  }



  // push_subscriptions テーブルとインデックスの自動マイグレーション
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        endpoint TEXT UNIQUE NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `).run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id)").run();
  } catch (e) {
    console.error("Failed to migrate push_subscriptions table:", e);
  }

  // custom_emojis テーブルとインデックスの自動マイグレーション
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS custom_emojis (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        code TEXT NOT NULL,
        object_key TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE (workspace_id, code)
      )
    `).run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_custom_emojis_workspace_id ON custom_emojis(workspace_id)").run();
  } catch (e) {
    console.error("Failed to migrate custom_emojis table:", e);
  }
}

async function ensureDatabaseInitialized(env: Env) {
  try {
    await env.DB.prepare("SELECT 1 FROM users LIMIT 1").all();
    await runMigrations(env);
  } catch (e: any) {
    if (e.message && (e.message.includes("no such table") || e.message.includes("does not exist"))) {
      const cleanSql = INIT_SQL.split("\n")
        .filter(line => !line.trim().startsWith("--"))
        .join("\n");

      const statements = cleanSql.split(";")
        .map(sql => sql.trim())
        .filter(sql => sql.length > 0)
        .map(sql => env.DB.prepare(sql));

      await env.DB.batch(statements);
      await runMigrations(env);
    } else {
      throw e;
    }
  }
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  try {
    await ensureDatabaseInitialized(env);
  } catch (err) {
    console.error("Failed to auto-initialize database:", err);
  }

  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) {
    return await context.next();
  }

  const method = request.method;
  if (method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
        "Access-Control-Allow-Credentials": "true",
      },
    });
  }

  return await handleApiRequests(context, "*");
};

async function handleApiRequests(context: EventContext<Env, any, any>, origin: string): Promise<Response> {
  const { request: req, env } = context;
  let request = req;
  const url = new URL(request.url);
  const method = request.method;

  // 1. Setup & Auth
  if (url.pathname === "/api/setup/status" && method === "GET") return await handleSetupStatus(request, env);
  if (url.pathname === "/api/setup/register" && method === "POST") return await handleSetupRegister(request, env);
  if (url.pathname === "/api/auth/register" && method === "POST") return await handleRegister(request, env);
  if (url.pathname === "/api/auth/login" && method === "POST") return await handleLogin(request, env);
  if (url.pathname === "/api/auth/login/verify" && method === "POST") return await handleVerifyMfa(request, env);
  if (url.pathname === "/api/auth/refresh" && method === "POST") return await handleRefresh(request, env);
  if (url.pathname === "/api/auth/logout" && method === "POST") return await handleLogout(request, env);
  if (url.pathname === "/api/auth/change-password" && method === "POST") return await handleChangePassword(request, env);
  if (url.pathname === "/api/auth/recovery" && method === "POST") return await handleRecovery(request, env);

  // 2. SaaS Plans, Announcements & Billing
  if (url.pathname === "/api/plans" && method === "GET") return await handleGetPublicSaaSPlans(request, env);
  if (url.pathname === "/api/announcements/active" && method === "GET") return await handleGetActiveAnnouncements(request, env);

  // 3. Workspaces & Branding
  const matchBranding = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/branding$/);
  if (matchBranding && method === "GET") return await handleGetWorkspaceBranding(request, env, matchBranding[1]);

  const matchSubscription = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/subscription$/);
  if (matchSubscription && method === "GET") return await handleGetWorkspaceSubscription(request, env, matchSubscription[1]);

  if (url.pathname === "/api/workspaces") {
    if (method === "GET") return await handleGetWorkspaces(request, env);
    if (method === "POST") return await handleCreateWorkspace(request, env);
  }
  const matchSingleWorkspace = url.pathname.match(/^\/api\/workspaces\/([^\/]+)$/);
  if (matchSingleWorkspace) {
    const wsId = matchSingleWorkspace[1];
    if (method === "PUT") return await handleUpdateWorkspace(request, env, wsId);
    if (method === "DELETE") return await handleDeleteWorkspace(request, env, wsId);
  }

  // 4. Items (Tasks / Calendar)
  if (url.pathname === "/api/items" && method === "GET") {
    return await handleGetItems(request, env);
  }
  const matchWorkspaceItems = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/items$/);
  if (matchWorkspaceItems) {
    const wsId = matchWorkspaceItems[1];
    if (method === "GET") return await handleGetWorkspaceItems(request, env, wsId);
    if (method === "POST") return await handleCreateItem(request, env, wsId);
  }
  const matchSingleItem = url.pathname.match(/^\/api\/items\/([^\/]+)$/);
  if (matchSingleItem) {
    const itemId = matchSingleItem[1];
    if (method === "PUT") return await handleUpdateItem(request, env, itemId);
    if (method === "DELETE") return await handleDeleteItem(request, env, itemId);
  }

  // 5. Document (Wiki) & Document Locks
  const matchDocLockAcquire = url.pathname.match(/^\/api\/document-locks\/([^\/]+)\/acquire$/);
  if (matchDocLockAcquire && method === "POST") return await handleAcquireDocumentLock(request, env, matchDocLockAcquire[1]);

  const matchDocLockHeartbeat = url.pathname.match(/^\/api\/document-locks\/([^\/]+)\/heartbeat$/);
  if (matchDocLockHeartbeat && method === "POST") return await handleHeartbeatDocumentLock(request, env, matchDocLockHeartbeat[1]);

  const matchDocLockRelease = url.pathname.match(/^\/api\/document-locks\/([^\/]+)\/release$/);
  if (matchDocLockRelease && method === "POST") return await handleReleaseDocumentLock(request, env, matchDocLockRelease[1]);

  const matchDocument = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/document$/);
  if (matchDocument) {
    const wsId = matchDocument[1];
    if (method === "GET") return await handleGetWorkspaceDocument(request, env, wsId);
    if (method === "PUT") return await handleUpdateWorkspaceDocument(request, env, wsId);
  }

  // 6. Notifications
  if (url.pathname === "/api/notifications" && method === "GET") return await handleGetNotifications(request, env);
  if (url.pathname === "/api/notifications/unread-count" && method === "GET") return await handleGetUnreadNotificationsCount(request, env);
  const matchReadNotif = url.pathname.match(/^\/api\/notifications\/([^\/]+)\/read$/);
  if (matchReadNotif && method === "PUT") return await handleMarkNotificationAsRead(request, env, matchReadNotif[1]);
  const matchArchiveNotif = url.pathname.match(/^\/api\/notifications\/([^\/]+)\/archive$/);
  if (matchArchiveNotif && method === "PUT") return await handleArchiveNotification(request, env, matchArchiveNotif[1]);
  const matchReadAllNotif = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/notifications\/read-all$/);
  if (matchReadAllNotif && method === "PUT") return await handleMarkAllNotificationsAsRead(request, env, matchReadAllNotif[1]);

  if (url.pathname === "/api/push/subscribe" && method === "POST") {
    return await handlePushSubscribe(request, env);
  }

  // 7. Groups & DM
  const matchGroups = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/groups$/);
  if (matchGroups) {
    const wsId = matchGroups[1];
    if (method === "GET") return await handleGetWorkspaceGroups(request, env, wsId);
    if (method === "POST") return await handleCreateGroup(request, env, wsId);
  }
  const matchSingleGroup = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/groups\/([^\/]+)$/);
  if (matchSingleGroup && method === "DELETE") return await handleDeleteGroup(request, env, matchSingleGroup[1], matchSingleGroup[2]);
  if (url.pathname === "/api/dm" && method === "POST") return await handleCreateOrGetDm(request, env);

  // 8. Messages & Reactions
  if (url.pathname === "/api/messages") {
    if (method === "GET") return await handleGetMessages(request, env);
    if (method === "POST") return await handleSendMessage(request, env);
  }
  const matchSingleMessage = url.pathname.match(/^\/api\/messages\/([^\/]+)$/);
  if (matchSingleMessage && method === "DELETE") return await handleDeleteMessage(request, env, matchSingleMessage[1]);
  const matchReaction = url.pathname.match(/^\/api\/messages\/([^\/]+)\/reactions$/);
  if (matchReaction && method === "POST") return await handleAddReaction(request, env, matchReaction[1]);
  const matchDeleteReaction = url.pathname.match(/^\/api\/messages\/([^\/]+)\/reactions\/([^\/]+)$/);
  if (matchDeleteReaction && method === "DELETE") return await handleDeleteReaction(request, env, matchDeleteReaction[1], matchDeleteReaction[2]);

  // 9. Channels & Browse & Join/Leave & Members
  const matchChannelMemberRemove = url.pathname.match(/^\/api\/channels\/([^\/]+)\/members\/([^\/]+)$/);
  if (matchChannelMemberRemove && method === "DELETE") return await handleRemoveChannelMember(request, env, matchChannelMemberRemove[1], matchChannelMemberRemove[2]);

  const matchChannelMembers = url.pathname.match(/^\/api\/channels\/([^\/]+)\/members$/);
  if (matchChannelMembers) {
    const cId = matchChannelMembers[1];
    if (method === "GET") return await handleGetChannelMembers(request, env, cId);
    if (method === "POST") return await handleAddChannelMember(request, env, cId);
  }

  const matchBrowseChannels = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/browse-channels$/);
  if (matchBrowseChannels && method === "GET") return await handleBrowseChannels(request, env, matchBrowseChannels[1]);

  const matchChannelJoin = url.pathname.match(/^\/api\/channels\/([^\/]+)\/join$/);
  if (matchChannelJoin && method === "POST") return await handleJoinChannel(request, env, matchChannelJoin[1]);

  const matchChannelLeave = url.pathname.match(/^\/api\/channels\/([^\/]+)\/leave$/);
  if (matchChannelLeave && method === "POST") return await handleLeaveChannel(request, env, matchChannelLeave[1]);

  const matchChannels = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/channels$/);
  if (matchChannels) {
    const wsId = matchChannels[1];
    if (method === "GET") return await handleGetWorkspaceChannels(request, env, wsId);
    if (method === "POST") return await handleCreateChannel(request, env, wsId);
  }
  const matchSingleChannel = url.pathname.match(/^\/api\/channels\/([^\/]+)$/);
  if (matchSingleChannel) {
    const cId = matchSingleChannel[1];
    if (method === "PUT") return await handleUpdateChannel(request, env, cId);
    if (method === "DELETE") return await handleDeleteChannel(request, env, cId);
  }

  // 10. Members & Re-invite & Role
  const matchReinviteMember = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/members\/([^\/]+)\/reinvite$/);
  if (matchReinviteMember && method === "POST") return await handleReinviteMember(request, env, matchReinviteMember[1], matchReinviteMember[2]);

  const matchMembers = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/members$/);
  if (matchMembers) {
    const wsId = matchMembers[1];
    if (method === "GET") return await handleGetWorkspaceMembers(request, env, wsId);
    if (method === "POST") return await handleAddWorkspaceMember(request, env, wsId);
  }
  const matchSingleMember = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/members\/([^\/]+)$/);
  if (matchSingleMember) {
    const wsId = matchSingleMember[1];
    const uId = matchSingleMember[2];
    if (method === "PUT") return await handleUpdateMemberRole(request, env, wsId, uId);
    if (method === "DELETE") return await handleRemoveMember(request, env, wsId, uId);
  }
  const matchRole = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/role$/);
  if (matchRole && method === "GET") return await handleGetUserRole(request, env, matchRole[1]);
  if (url.pathname === "/api/users/me" && method === "PUT") return await handleUpdateUserProfile(request, env);

  // 11. Search, Activities, Emojis
  const matchSearch = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/search$/);
  if (matchSearch && method === "GET") return await handleSearchWorkspace(request, env, matchSearch[1]);
  if (url.pathname === "/api/activities" && method === "GET") return await handleGetActivities(request, env);
  const matchEmojis = url.pathname.match(/^\/api\/workspaces\/([^\/]+)\/emojis$/);
  if (matchEmojis) {
    const wsId = matchEmojis[1];
    if (method === "GET") return await handleGetCustomEmojis(request, env, wsId);
    if (method === "POST") return await handleCreateCustomEmoji(request, env, wsId);
  }


  // 12. File Upload / Download
  if (url.pathname === "/api/files/upload" && method === "POST") {
    return await handleFileUpload(request, env);
  }
  if (url.pathname === "/api/avatars/upload" && method === "POST") {
    return await handleAvatarUpload(request, env);
  }
  const matchFileDownload = url.pathname.match(/^\/api\/files\/download\/(.+)$/);
  if (matchFileDownload) {
    const objectKey = decodeURIComponent(matchFileDownload[1]);
    return await handleFileDownload(request, env, objectKey);
  }

  return new Response(JSON.stringify({ message: "Core route handled" }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
