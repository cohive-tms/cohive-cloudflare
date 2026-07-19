import type { Env } from "../[[route]]";
import { checkWorkspaceLimit } from "../_utils/saas";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { logAudit } from "../_utils/audit";

function getS3Client(env: Env): S3Client {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID } = env;

  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID) {
    throw new Error(
      "R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_ACCOUNT_ID must be configured for presigned URLs."
    );
  }

  return new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

export async function handleGetPresignedUploadUrl(request: Request, env: Env): Promise<Response> {
  const headers = {
    "Content-Type": "application/json",
  };

  try {
    const url = new URL(request.url);
    const fileName = url.searchParams.get("fileName");
    const contentType = url.searchParams.get("contentType") || "application/octet-stream";

    if (!fileName) {
      return new Response(JSON.stringify({ error: "Missing 'fileName' query parameter" }), {
        status: 400,
        headers,
      });
    }

    const fileId = crypto.randomUUID();
    const ext = fileName.includes(".") ? `.${fileName.split(".").pop()}` : "";
    const objectKey = `uploads/${fileId}${ext}`;

    const s3Client = getS3Client(env);
    const command = new PutObjectCommand({
      Bucket: "cohive-storage",
      Key: objectKey,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 600 });

    return new Response(
      JSON.stringify({
        uploadUrl,
        objectKey,
        fileUrl: `/api/files/download/${objectKey}`,
      }),
      { status: 200, headers }
    );
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers,
    });
  }
}

export async function handleGetPresignedDownloadUrl(request: Request, env: Env): Promise<Response> {
  const headers = {
    "Content-Type": "application/json",
  };

  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const url = new URL(request.url);
    const objectKey = url.searchParams.get("key");

    if (!objectKey) {
      return new Response(JSON.stringify({ error: "Missing 'key' query parameter" }), {
        status: 400,
        headers,
      });
    }

    // filesテーブルからファイル情報と紐づくチャンネル情報を取得して認可チェック
    const fileInfo = await env.DB.prepare(`
      SELECT f.workspace_id as workspaceId, f.channel_id as channelId, f.uploader_id as uploaderId, f.is_private as isPrivate,
             c.is_private as isChannelPrivate, c.type as channelType, c.group_id as groupId
      FROM files f
      LEFT JOIN channels c ON f.channel_id = c.id
      WHERE f.object_key = ?
      LIMIT 1
    `).bind(objectKey).first<{
      workspaceId: string;
      channelId: string | null;
      uploaderId: string;
      isPrivate: number;
      isChannelPrivate: number | null;
      channelType: string | null;
      groupId: string | null;
    }>();

    if (fileInfo) {
      // 1. ワークスペース所属チェック
      const isWsMember = await env.DB.prepare(
        "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
      ).bind(fileInfo.workspaceId, userId).first<{ role: string }>();

      if (!isWsMember) {
        return new Response(JSON.stringify({ error: "Forbidden: You are not a member of this workspace" }), { status: 403, headers });
      }

      // 閲覧権限チェック
      let hasAccess = false;

      // 自身がアップ主なら無条件でOK
      if (fileInfo.uploaderId === userId) {
        hasAccess = true;
      }
      // 管理者/グループ管理者は、DM以外のファイルであれば無条件でOK
      else if (isWsMember.role === 'owner' || isWsMember.role === 'group_admin') {
        if (!fileInfo.channelId || fileInfo.channelType !== 'dm') {
          hasAccess = true;
        }
      }

      // ゲストロールの場合は、自分がメンバーであるチャンネル（channel_members）のファイルのみ許可
      if (!hasAccess && isWsMember.role === 'guest') {
        if (fileInfo.channelId) {
          const isChanMember = await env.DB.prepare(
            "SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?"
          ).bind(fileInfo.channelId, userId).first();
          if (isChanMember) {
            hasAccess = true;
          }
        }
      }

      // ゲスト以外の通常の追加チェック
      if (!hasAccess && isWsMember.role !== 'guest' && fileInfo.channelId) {
        const isPublic = (fileInfo.channelType === 'channel' || !fileInfo.channelType) && fileInfo.isChannelPrivate === 0;
        if (isPublic) {
          hasAccess = true;
        } else {
          // プライベートチャンネルメンバーシップチェック
          const isChanMember = await env.DB.prepare(
            "SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?"
          ).bind(fileInfo.channelId, userId).first();

          if (isChanMember) {
            hasAccess = true;
          } else if (fileInfo.groupId) {
            const isGroupMem = await env.DB.prepare(
              "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?"
            ).bind(fileInfo.groupId, userId).first();
            if (isGroupMem) hasAccess = true;
          }
        }
      }

      // チャンネル未指定（ワークスペース全体）の場合のチェック（ゲストは対象外）
      if (!hasAccess && isWsMember.role !== 'guest' && !fileInfo.channelId) {
        // パブリックであればワークスペースメンバーならOK
        if (fileInfo.isPrivate === 0) {
          hasAccess = true;
        }
      }

      if (!hasAccess) {
        return new Response(JSON.stringify({ error: "Forbidden: Access denied" }), { status: 403, headers });
      }
    } else {
      return new Response(JSON.stringify({ error: "File Not Found" }), { status: 404, headers });
    }

    const s3Client = getS3Client(env);
    const command = new GetObjectCommand({
      Bucket: "cohive-storage",
      Key: objectKey,
    });

    const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    return new Response(JSON.stringify({ downloadUrl }), { status: 200, headers });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers,
    });
  }
}

export async function handleDirectUpload(request: Request, env: Env): Promise<Response> {
  const headers = {
    "Content-Type": "application/json",
  };

  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const contentType = request.headers.get("content-type");
    if (!contentType || !contentType.includes("multipart/form-data")) {
      return new Response(JSON.stringify({ error: "Content-Type must be multipart/form-data" }), {
        status: 400,
        headers,
      });
    }

    const formData = await request.formData();
    const file = formData.get("file") as File;
    const workspaceId = (formData.get("workspaceId") as string) || request.headers.get("X-Workspace-Id");
    const channelId = formData.get("channelId") as string | null;
    const isPrivateStr = formData.get("isPrivate") as string | null;
    const isPrivate = isPrivateStr === "1" ? 1 : 0;

    if (!file) {
      return new Response(JSON.stringify({ error: "No file was uploaded" }), {
        status: 400,
        headers,
      });
    }

    if (!workspaceId) {
      return new Response(JSON.stringify({ error: "workspaceId is required" }), {
        status: 400,
        headers,
      });
    }

    // SaaS制限チェック
    if (file && workspaceId) {
      // 1. ストレージ容量制限チェック
      const limitCheck = await checkWorkspaceLimit(env, workspaceId, "storage", file.size);
      if (!limitCheck.allowed) {
        return new Response(JSON.stringify({ error: limitCheck.message }), {
          status: 403,
          headers,
        });
      }

      // 2. メディア無効・禁止拡張子チェック
      const uploadExt = file.name.includes(".") ? `.${file.name.split(".").pop()}` : "";
      const mediaCheck = await checkWorkspaceLimit(env, workspaceId, "media", 1, { fileExtension: uploadExt });
      if (!mediaCheck.allowed) {
        return new Response(JSON.stringify({ error: mediaCheck.message }), {
          status: 403,
          headers,
        });
      }
    }

    const fileId = crypto.randomUUID();
    const ext = file.name.includes(".") ? `.${file.name.split(".").pop()}` : "";
    const objectKey = `uploads/${fileId}${ext}`;

    // R2に保存
    await env.BUCKET.put(objectKey, file.stream(), {
      httpMetadata: {
        contentType: file.type,
      },
    });

    // DB（filesテーブル）にレコード登録
    await env.DB.prepare(`
      INSERT INTO files (id, workspace_id, channel_id, uploader_id, file_name, object_key, file_size, content_type, is_private)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      fileId,
      workspaceId,
      channelId || null,
      userId,
      file.name,
      objectKey,
      file.size,
      file.type,
      isPrivate
    ).run();

    // 監査ログの記録
    logAudit(env, workspaceId, userId, "file_upload", { fileId, fileName: file.name, fileSize: file.size, contentType: file.type }, request).catch(console.error);

    return new Response(
      JSON.stringify({
        success: true,
        id: fileId,
        objectKey,
        fileUrl: `/api/files/download/${objectKey}`,
      }),
      { status: 201, headers }
    );
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers,
    });
  }
}

export async function handleDirectDownload(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    let userId = request.headers.get("X-User-Id") || url.searchParams.get("userId") || url.searchParams.get("user_id");
    if (!userId) {
      return new Response("Unauthorized", { status: 401 });
    }

    const prefix = "/api/files/download/";
    
    const objectKey = decodeURIComponent(
      url.pathname.substring(url.pathname.indexOf(prefix) + prefix.length)
    );

    if (!objectKey) {
      return new Response("Missing file path key", { status: 400 });
    }

    // filesテーブルからファイル情報と紐づくチャンネル情報を取得
    const fileInfo = await env.DB.prepare(`
      SELECT f.file_name as fileName, f.content_type as contentType, f.workspace_id as workspaceId, f.channel_id as channelId, f.uploader_id as uploaderId, f.is_private as isPrivate,
             c.is_private as isChannelPrivate, c.type as channelType, c.group_id as groupId
      FROM files f
      LEFT JOIN channels c ON f.channel_id = c.id
      WHERE f.object_key = ?
      LIMIT 1
    `).bind(objectKey).first<{
      fileName: string;
      contentType: string;
      workspaceId: string;
      channelId: string | null;
      uploaderId: string;
      isPrivate: number;
      isChannelPrivate: number | null;
      channelType: string | null;
      groupId: string | null;
    }>();

    if (fileInfo) {
      // 1. ワークスペース所属チェック
      const isWsMember = await env.DB.prepare(
        "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
      ).bind(fileInfo.workspaceId, userId).first<{ role: string }>();

      if (!isWsMember) {
        return new Response("Forbidden: You are not a member of this workspace", { status: 403 });
      }

      // 閲覧権限チェック
      let hasAccess = false;

      // 自身がアップ主なら無条件でOK
      if (fileInfo.uploaderId === userId) {
        hasAccess = true;
      }
      // 管理者/グループ管理者は、DM以外のファイルであれば無条件でOK
      else if (isWsMember.role === 'owner' || isWsMember.role === 'group_admin') {
        if (!fileInfo.channelId || fileInfo.channelType !== 'dm') {
          hasAccess = true;
        }
      }

      // ゲストロールの場合は、自分がメンバーであるチャンネル（channel_members）のファイルのみ許可
      if (!hasAccess && isWsMember.role === 'guest') {
        if (fileInfo.channelId) {
          const isChanMember = await env.DB.prepare(
            "SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?"
          ).bind(fileInfo.channelId, userId).first();
          if (isChanMember) {
            hasAccess = true;
          }
        }
      }

      // ゲスト以外の通常の追加チェック
      if (!hasAccess && isWsMember.role !== 'guest' && fileInfo.channelId) {
        const isPublic = (fileInfo.channelType === 'channel' || !fileInfo.channelType) && fileInfo.isChannelPrivate === 0;
        if (isPublic) {
          hasAccess = true;
        } else {
          // プライベートチャンネルメンバーシップチェック
          const isChanMember = await env.DB.prepare(
            "SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?"
          ).bind(fileInfo.channelId, userId).first();

          if (isChanMember) {
            hasAccess = true;
          } else if (fileInfo.groupId) {
            const isGroupMem = await env.DB.prepare(
              "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?"
            ).bind(fileInfo.groupId, userId).first();
            if (isGroupMem) hasAccess = true;
          }
        }
      }

      // チャンネル未指定（ワークスペース全体）の場合のチェック（ゲストは対象外）
      if (!hasAccess && isWsMember.role !== 'guest' && !fileInfo.channelId) {
        // パブリックであればワークスペースメンバーならOK
        if (fileInfo.isPrivate === 0) {
          hasAccess = true;
        }
      }

      if (!hasAccess) {
        return new Response("Forbidden: Access denied", { status: 403 });
      }
    } else {
      return new Response("File Not Found", { status: 404 });
    }

    const object = await env.BUCKET.get(objectKey);

    if (!object) {
      return new Response("File Not Found", { status: 404 });
    }

    const responseHeaders = new Headers();
    if (object.httpEtag) {
      responseHeaders.set("etag", object.httpEtag);
    }
    responseHeaders.set("Access-Control-Allow-Origin", "*");

    const contentType = (fileInfo && fileInfo.contentType) || object.httpMetadata?.contentType || "application/octet-stream";
    responseHeaders.set("Content-Type", contentType);

    const dispositionMode = url.searchParams.get("disposition") === "inline" ? "inline" : "attachment";
    if (fileInfo && fileInfo.fileName) {
      const encodedFileName = encodeURIComponent(fileInfo.fileName);
      responseHeaders.set("Content-Disposition", `${dispositionMode}; filename="${encodedFileName}"; filename*=UTF-8''${encodedFileName}`);
    }

    return new Response(object.body, {
      headers: responseHeaders,
    });
  } catch (error: any) {
    return new Response(error.message || "Internal Server Error", { status: 500 });
  }
}

export async function handleGetMediaLibrary(request: Request, env: Env): Promise<Response> {
  const headers = {
    "Content-Type": "application/json",
  };

  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspaceId") || url.searchParams.get("workspace_id");
    const channelId = url.searchParams.get("channelId") || url.searchParams.get("channel_id");
    const fileType = url.searchParams.get("fileType") || url.searchParams.get("file_type");

    if (!workspaceId) {
      return new Response(JSON.stringify({ error: "Missing 'workspaceId' parameter" }), {
        status: 400,
        headers,
      });
    }

    // ワークスペース所属チェック
    const isWsMember = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(workspaceId, userId).first<{ role: string }>();

    if (!isWsMember) {
      return new Response(JSON.stringify({ error: "Forbidden: Not workspace member" }), {
        status: 403,
        headers,
      });
    }

    if (isWsMember.role === 'guest' && !channelId) {
      return new Response(JSON.stringify({ error: "Forbidden: Guest cannot view global media library" }), {
        status: 403,
        headers,
      });
    }

    if (isWsMember.role === 'guest' && channelId) {
      const isChanMem = await env.DB.prepare(
        "SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?"
      ).bind(channelId, userId).first();
      if (!isChanMem) {
        return new Response(JSON.stringify({ error: "Forbidden: Not channel member" }), {
          status: 403,
          headers,
        });
      }
    }

    // クエリ構築
    let query = `
      SELECT f.*, u.display_name as uploader_name, c.name as channel_name
      FROM files f
      LEFT JOIN channels c ON f.channel_id = c.id
      LEFT JOIN users u ON f.uploader_id = u.id
      WHERE f.workspace_id = ?
    `;

    const params: any[] = [workspaceId];

    if (isWsMember.role === 'guest') {
      query += `
        AND (
          f.uploader_id = ?
          OR
          (f.channel_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM channel_members cm 
            WHERE cm.channel_id = f.channel_id AND cm.user_id = ?
          ))
        )
      `;
      params.push(userId, userId);
    } else {
      query += `
        AND (
          -- 1. 自分がアップ主
          f.uploader_id = ?
          
          OR
          
          -- 2. ワークスペースの管理者/グループ管理者（DM以外）
          (
            EXISTS (
              SELECT 1 FROM workspace_members wm 
              WHERE wm.workspace_id = f.workspace_id AND wm.user_id = ? AND wm.role IN ('owner', 'group_admin')
            )
            AND (c.type IS NULL OR c.type != 'dm')
          )
          
          OR
          
          -- 3. チャンネルに紐づくファイル
          (
            f.channel_id IS NOT NULL AND (
              (c.is_private = 0 AND (c.type = 'channel' OR c.type IS NULL))
              OR
              EXISTS (
                SELECT 1 FROM channel_members cm 
                WHERE cm.channel_id = f.channel_id AND cm.user_id = ?
              )
            )
          )
          
          OR
          
          -- 4. チャンネル未指定（ワークスペース全体）かつパブリック
          (f.channel_id IS NULL AND f.is_private = 0)
        )
      `;
      params.push(userId, userId, userId);
    }

    // 追加フィルタ: channelId
    if (channelId) {
      query += ` AND f.channel_id = ?`;
      params.push(channelId);
    }

    // 追加フィルタ: fileType
    if (fileType) {
      if (fileType === "image") {
        query += ` AND f.content_type LIKE 'image/%'`;
      } else if (fileType === "video") {
        query += ` AND f.content_type LIKE 'video/%'`;
      } else if (fileType === "document") {
        query += ` AND (f.content_type LIKE 'application/pdf' OR f.content_type LIKE 'text/%' OR f.content_type LIKE '%word%' OR f.content_type LIKE '%excel%' OR f.content_type LIKE '%powerpoint%')`;
      } else {
        query += ` AND NOT (f.content_type LIKE 'image/%' OR f.content_type LIKE 'video/%' OR f.content_type LIKE 'application/pdf' OR f.content_type LIKE 'text/%')`;
      }
    }

    query += ` ORDER BY f.created_at DESC`;

    const stmt = env.DB.prepare(query).bind(...params);
    const { results } = await stmt.all<any>();

    return new Response(JSON.stringify({ success: true, files: results }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers,
    });
  }
}

export async function handleDeleteFile(request: Request, env: Env): Promise<Response> {
  const headers = {
    "Content-Type": "application/json",
  };

  try {
    const userId = request.headers.get("X-User-Id");
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const url = new URL(request.url);
    const prefix = "/api/files/";
    // DELETE /api/files/:id
    const fileId = url.pathname.substring(url.pathname.indexOf(prefix) + prefix.length);

    if (!fileId) {
      return new Response(JSON.stringify({ error: "Missing 'id' parameter" }), {
        status: 400,
        headers,
      });
    }

    const fileInfo = await env.DB.prepare(`
      SELECT workspace_id, uploader_id, object_key FROM files WHERE id = ?
    `).bind(fileId).first<{ workspace_id: string; uploader_id: string; object_key: string }>();

    if (!fileInfo) {
      return new Response(JSON.stringify({ error: "File not found" }), {
        status: 404,
        headers,
      });
    }

    // 削除権限チェック
    const isWsMember = await env.DB.prepare(
      "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
    ).bind(fileInfo.workspace_id, userId).first<{ role: string }>();

    const hasDeletePermission = 
      fileInfo.uploader_id === userId || 
      (isWsMember && (isWsMember.role === "owner" || isWsMember.role === "group_admin"));

    if (!hasDeletePermission) {
      return new Response(JSON.stringify({ error: "Forbidden: You do not have permission to delete this file" }), {
        status: 403,
        headers,
      });
    }

    // R2から削除
    await env.BUCKET.delete(fileInfo.object_key);

    // DBから削除
    await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(fileId).run();

    // 監査ログの記録
    logAudit(env, fileInfo.workspace_id, userId, "file_delete", { fileId, fileName: fileInfo.object_key }, request).catch(console.error);

    return new Response(JSON.stringify({ success: true, message: "File deleted successfully" }), {
      status: 200,
      headers,
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers,
    });
  }
}

export async function linkFileToMessage(
  env: Env,
  fileUrl: string | null | undefined,
  fileName: string | null | undefined,
  fileSize: number | null | undefined,
  channelId: string,
  messageId: string,
  userId: string
): Promise<void> {
  if (!fileUrl) return;

  const prefix = "/api/files/download/";
  const idx = fileUrl.indexOf(prefix);
  if (idx === -1) return;

  const objectKey = decodeURIComponent(fileUrl.substring(idx + prefix.length));

  // チャンネルからワークスペースIDを取得
  const channelInfo = await env.DB.prepare(
    "SELECT workspace_id FROM channels WHERE id = ?"
  ).bind(channelId).first<{ workspace_id: string }>();

  if (!channelInfo) return;

  // すでにfilesテーブルに登録されているかチェック
  const existingFile = await env.DB.prepare(
    "SELECT 1 FROM files WHERE object_key = ?"
  ).bind(objectKey).first();

  if (existingFile) {
    // 既存レコードがあれば channel_id と message_id を更新
    await env.DB.prepare(`
      UPDATE files 
      SET channel_id = ?, message_id = ?
      WHERE object_key = ?
    `).bind(channelId, messageId, objectKey).run();
  } else {
    // なければ新規作成
    const fileId = crypto.randomUUID();
    let contentType = "application/octet-stream";
    const ext = objectKey.split('.').pop()?.toLowerCase();
    if (ext) {
      const mimeMap: Record<string, string> = {
        'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'webp': 'image/webp',
        'mp4': 'video/mp4', 'webm': 'video/webm', 'pdf': 'application/pdf', 'txt': 'text/plain',
        'zip': 'application/zip', 'json': 'application/json'
      };
      contentType = mimeMap[ext] || contentType;
    }

    await env.DB.prepare(`
      INSERT INTO files (id, workspace_id, channel_id, message_id, uploader_id, file_name, object_key, file_size, content_type, is_private)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).bind(
      fileId,
      channelInfo.workspace_id,
      channelId,
      messageId,
      userId,
      fileName || "attachment",
      objectKey,
      fileSize || 0,
      contentType
    ).run();
  }
}
