import type { Env } from "../[[route]]";
import { verifyUserAuth, verifyWorkspaceMember, verifyChannelMember } from "../_utils/jwt";
import { getCorsHeaders } from "../_utils/cors";



/**
 * ファイルのアップロード処理（チャット添付ファイル・メディアライブラリ）
 * POST /api/files/upload
 */
export async function handleFileUpload(request: Request, env: Env): Promise<Response> {
  const headers = getCorsHeaders(request, "POST, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    // レートリミット制限の適用
    const ip = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: `file-up-${userId}-${ip}` });
      if (!success) {
        return new Response(
          JSON.stringify({ error: "Too many file uploads. Please slow down and try again later." }),
          { status: 429, headers }
        );
      }
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const workspaceId = formData.get("workspaceId") as string | null;
    const channelId = formData.get("channelId") as string | null;

    if (!file || !workspaceId) {
      return new Response(JSON.stringify({ error: "Missing file or workspaceId" }), { status: 400, headers });
    }

    if (!(await verifyWorkspaceMember(env, workspaceId, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden: You do not have access to this workspace" }), { status: 403, headers });
    }

    // 容量制限および拡張子制限チェック（SaaSプランの上限）
    let maxFileSizeMb = 100; // デフォルト100MB
    let allowedExtensionsStr = "";
    let mediaEnabled = true;

    if ((env as any).SAAS_LIMITS) {
      try {
        const sub = await (env as any).SAAS_LIMITS.getWorkspaceSubscriptionPlan({ DB: env.DB, SAAS_LIMITS: (env as any).SAAS_LIMITS }, workspaceId);
        if (sub) {
          if (sub.maxFileSizeMb) maxFileSizeMb = sub.maxFileSizeMb;
          if (sub.mediaEnabled !== undefined) mediaEnabled = sub.mediaEnabled;
          if (sub.allowedExtensions) allowedExtensionsStr = sub.allowedExtensions;
        }
      } catch (limitErr) {
        console.warn("Failed to check SaaS limits during upload:", limitErr);
      }
    }

    if (!mediaEnabled) {
      return new Response(
        JSON.stringify({ error: "File upload is disabled for this workspace plan." }),
        { status: 403, headers }
      );
    }

    if (file.size > maxFileSizeMb * 1024 * 1024) {
      return new Response(
        JSON.stringify({ error: `File size exceeds the limit of ${maxFileSizeMb}MB` }),
        { status: 400, headers }
      );
    }

    const fileId = crypto.randomUUID();
    const fileName = file.name;

    // プランで許可された拡張子の検証
    if (allowedExtensionsStr && allowedExtensionsStr.trim()) {
      const allowedList = allowedExtensionsStr.split(',').map(e => e.trim().toLowerCase().replace(/^\./, ''));
      const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() || '' : '';
      if (!allowedList.includes(ext)) {
        return new Response(
          JSON.stringify({ error: `File extension .${ext} is not allowed.` }),
          { status: 400, headers }
        );
      }
    }

    const contentType = file.type || "application/octet-stream";
    const fileSize = file.size;

    // R2キー設計: workspaces/${workspaceId}/files/${fileId}_${fileName}
    // ワークスペース削除時に spaces/ 配下がパージされる設計と整合性を取ります。
    const objectKey = `workspaces/${workspaceId}/files/${fileId}_${fileName}`;

    const storage = env.BUCKET;
    if (!storage) {
      return new Response(JSON.stringify({ error: "R2 storage binding 'BUCKET' not found" }), { status: 500, headers });
    }

    // R2へストリームで保存
    await storage.put(objectKey, file.stream(), {
      httpMetadata: {
        contentType: contentType,
        contentDisposition: `inline; filename="${encodeURIComponent(fileName)}"`
      },
      customMetadata: {
        uploaderId: userId,
        workspaceId: workspaceId,
        channelId: channelId || ""
      }
    });

    // D1 データベースへのメタデータ登録
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO files (id, workspace_id, channel_id, uploader_id, file_name, object_key, file_size, content_type, is_private, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).bind(
      fileId,
      workspaceId,
      channelId || null,
      userId,
      fileName,
      objectKey,
      fileSize,
      contentType,
      now,
      now
    ).run();

    const fileUrl = `/api/files/download/${objectKey}`;

    return new Response(
      JSON.stringify({
        success: true,
        fileUrl,
        fileName,
        fileSize
      }),
      { status: 200, headers }
    );
  } catch (error: any) {
    console.error("Failed to upload file:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers
    });
  }
}

/**
 * ユーザーアバター画像のアップロード処理
 * POST /api/avatars/upload
 */
export async function handleAvatarUpload(request: Request, env: Env): Promise<Response> {
  const headers = getCorsHeaders(request, "POST, OPTIONS");

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return new Response(JSON.stringify({ error: "Missing file" }), { status: 400, headers });
    }

    // アバター容量制限（5MB）
    if (file.size > 5 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: "Avatar size exceeds the limit of 5MB" }), { status: 400, headers });
    }

    // アバター画像形式の検証
    const allowedAvatarMimes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    const ext = file.name.includes(".") ? file.name.split(".").pop()?.toLowerCase() || "" : "";
    const allowedAvatarExts = ["jpg", "jpeg", "png", "webp", "gif"];

    if (!allowedAvatarMimes.includes(file.type) || !allowedAvatarExts.includes(ext)) {
      return new Response(JSON.stringify({ error: "Only image files (JPEG, PNG, WebP, GIF) are allowed for avatars" }), { status: 400, headers });
    }

    const fileId = crypto.randomUUID();
    const fileName = file.name;
    const contentType = file.type || "image/jpeg";

    // R2キー設計: avatars/${userId}/${fileId}_${fileName}
    // ユーザーアバターはグローバルデータのため、ワークスペース配下とは別ディレクトリにします。
    const objectKey = `avatars/${userId}/${fileId}_${fileName}`;

    const storage = env.BUCKET;
    if (!storage) {
      return new Response(JSON.stringify({ error: "R2 storage binding 'BUCKET' not found" }), { status: 500, headers });
    }

    await storage.put(objectKey, file.stream(), {
      httpMetadata: {
        contentType: contentType,
        contentDisposition: `inline; filename="${encodeURIComponent(fileName)}"`
      },
      customMetadata: {
        uploaderId: userId,
        isAvatar: "true"
      }
    });

    const avatarUrl = `/api/files/download/${objectKey}`;

    // 古いアバター画像を R2 バケットから自動削除（ストレージゾンビの防止）
    const oldUser = await env.DB.prepare(
      "SELECT avatar_url FROM users WHERE id = ?"
    ).bind(userId).first<{ avatar_url: string | null }>();

    if (oldUser && oldUser.avatar_url && oldUser.avatar_url.startsWith("/api/files/download/")) {
      const oldKey = oldUser.avatar_url.substring("/api/files/download/".length);
      try {
        await storage.delete(oldKey);
      } catch (delErr) {
        console.error("Failed to delete old avatar from R2:", delErr);
      }
    }

    // D1 users テーブルのアバターURLを更新
    await env.DB.prepare(`
      UPDATE users
      SET avatar_url = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(avatarUrl, userId).run();

    return new Response(
      JSON.stringify({
        success: true,
        avatarUrl
      }),
      { status: 200, headers }
    );
  } catch (error: any) {
    console.error("Failed to upload avatar:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers
    });
  }
}

/**
 * ファイルのダウンロード/配信処理
 * GET /api/files/download/*
 */
export async function handleFileDownload(request: Request, env: Env, objectKey: string): Promise<Response> {
  const corsHeaders = getCorsHeaders(request, "GET, OPTIONS");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // ダウンロード前の認証確認
    const userId = await verifyUserAuth(request, env);
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    }

    // filesテーブルからファイルに紐づく情報を取得する
    const fileRecord = await env.DB.prepare(
      "SELECT workspace_id, channel_id FROM files WHERE object_key = ?"
    ).bind(objectKey).first<{ workspace_id: string; channel_id: string | null }>();

    if (fileRecord) {
      // ワークスペースメンバーの確認
      const member = await env.DB.prepare(
        "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
      ).bind(fileRecord.workspace_id, userId).first();

      if (!member) {
        return new Response(
          JSON.stringify({ error: "Forbidden: You do not have access to this workspace's files." }),
          { status: 403, headers: corsHeaders }
        );
      }

      // チャンネルIDが紐付いている場合は、そのチャンネルのアクセス権（メンバーシップ）を確認
      if (fileRecord.channel_id) {
        const isChanMember = await verifyChannelMember(env, fileRecord.channel_id, userId);
        if (!isChanMember) {
          return new Response(
            JSON.stringify({ error: "Forbidden: You do not have access to this channel's files." }),
            { status: 403, headers: corsHeaders }
          );
        }
      }
    } else {
      // filesテーブルに登録されていないアバターなどのファイル
      // objectKey が workspaces/workspaceId/ で始まる場合、メンバー検証を行う (BOLA対策)
      const keyParts = objectKey.split("/");
      if (keyParts[0] === "workspaces" && keyParts[1]) {
        const workspaceId = keyParts[1];
        const member = await env.DB.prepare(
          "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
        ).bind(workspaceId, userId).first();

        if (!member) {
          return new Response(
            JSON.stringify({ error: "Forbidden: You do not have access to this workspace's files." }),
            { status: 403, headers: corsHeaders }
          );
        }
      }
    }

    const storage = env.BUCKET;
    if (!storage) {
      return new Response(JSON.stringify({ error: "R2 storage binding 'BUCKET' not found" }), { status: 500, headers: corsHeaders });
    }

    const object = await storage.get(objectKey);
    if (!object) {
      return new Response(JSON.stringify({ error: "File not found" }), { status: 404, headers: corsHeaders });
    }

    const headers = new Headers();
    Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));

    // Content-Type を引き継ぐ
    const contentType = object.httpMetadata?.contentType || "application/octet-stream";
    headers.set("Content-Type", contentType);

    // セキュリティヘッダーの追加 (Stored XSSおよびMIMEスニッフィング防止)
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Content-Security-Policy", "default-src 'none'; sandbox;");

    // インライン表示（プレビュー）可能な拡張子かどうかをチェック
    const inlineTypes = ["image/", "video/", "audio/", "application/pdf", "text/"];
    const isInline = inlineTypes.some(type => contentType.startsWith(type));

    // キー名から元のファイル名を取り出す（UUID_fileName 形式からUUID部分を除去）
    const parts = objectKey.split("/");
    const lastPart = parts[parts.length - 1];
    let fileName = lastPart;
    if (lastPart.length > 37 && lastPart.charAt(36) === "_") {
      fileName = lastPart.substring(37);
    }

    const disposition = isInline ? "inline" : "attachment";
    headers.set("Content-Disposition", `${disposition}; filename="${encodeURIComponent(fileName)}"`);
    headers.set("Cache-Control", "public, max-age=31536000");

    // R2オブジェクトのBodyをレスポンスに流し込む（ストリーミング配信）
    return new Response(object.body, {
      status: 200,
      headers
    });
  } catch (error: any) {
    console.error("Failed to download file:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

/**
 * メディアファイル一覧の取得
 * GET /api/media?workspaceId=...&channelId=...&fileType=...
 */
export async function handleGetMediaFiles(request: Request, env: Env): Promise<Response> {
  const headers = getCorsHeaders(request, "GET, OPTIONS");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });

    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspaceId");
    if (!workspaceId) return new Response(JSON.stringify({ error: "workspaceId is required" }), { status: 400, headers });

    if (!(await verifyWorkspaceMember(env, workspaceId, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }

    const channelId = url.searchParams.get("channelId");
    const fileType = url.searchParams.get("fileType");

    let query = `
      SELECT 
        f.id,
        f.workspace_id,
        f.channel_id,
        f.message_id,
        f.uploader_id,
        f.file_name,
        f.object_key,
        f.file_size,
        f.content_type,
        f.is_private,
        f.created_at,
        u.display_name as uploader_name,
        c.name as channel_name
      FROM files f
      LEFT JOIN users u ON f.uploader_id = u.id
      LEFT JOIN channels c ON f.channel_id = c.id
      WHERE f.workspace_id = ?
        AND (
          f.channel_id IS NULL 
          OR c.is_private = 0 
          OR f.channel_id IN (SELECT channel_id FROM channel_members WHERE user_id = ?)
        )
        AND (
          f.is_private = 0 
          OR f.uploader_id = ?
        )
    `;
    const params: any[] = [workspaceId, userId, userId];

    if (channelId) {
      query += ` AND f.channel_id = ?`;
      params.push(channelId);
    }

    if (fileType) {
      if (fileType === "image") {
        query += ` AND f.content_type LIKE 'image/%'`;
      } else if (fileType === "video") {
        query += ` AND f.content_type LIKE 'video/%'`;
      } else if (fileType === "document") {
        query += ` AND (f.content_type LIKE 'application/%' OR f.content_type LIKE 'text/%')`;
      }
    }

    query += ` ORDER BY f.created_at DESC LIMIT 200`;

    const { results } = await env.DB.prepare(query).bind(...params).all<any>();

    return new Response(JSON.stringify({
      success: true,
      files: results || []
    }), { status: 200, headers });
  } catch (error: any) {
    console.error("Failed to fetch media files:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers
    });
  }
}

/**
 * ファイルの削除
 * DELETE /api/files/:fileId
 */
export async function handleDeleteFile(request: Request, env: Env, fileId: string): Promise<Response> {
  const headers = getCorsHeaders(request, "DELETE, OPTIONS");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  try {
    const userId = await verifyUserAuth(request, env);
    if (!userId) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });

    const file = await env.DB.prepare(
      "SELECT * FROM files WHERE id = ?"
    ).bind(fileId).first<any>();

    if (!file) {
      return new Response(JSON.stringify({ error: "File not found" }), { status: 404, headers });
    }

    if (!(await verifyWorkspaceMember(env, file.workspace_id, userId))) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
    }

    // 削除権限: アップロード者本人、またはワークスペース管理者（owner/admin）
    const member = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(file.workspace_id, userId).first<{ role: string }>();

    const isAdmin = member && (member.role === "owner" || member.role === "admin");
    if (file.uploader_id !== userId && !isAdmin) {
      return new Response(JSON.stringify({ error: "Forbidden: You cannot delete this file" }), { status: 403, headers });
    }

    // R2からオブジェクト削除
    if (file.object_key) {
      await env.BUCKET.delete(file.object_key).catch((err: any) => {
        console.warn("Failed to delete R2 object:", err);
      });
    }

    // DBから削除
    await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(fileId).run();

    return new Response(JSON.stringify({
      success: true,
      message: "File deleted successfully"
    }), { status: 200, headers });
  } catch (error: any) {
    console.error("Failed to delete file:", error);
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers
    });
  }
}
