import type { Env } from "../[[route]]";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Id, Authorization",
};

/**
 * 1. アバター画像アップロード API (POST /api/avatars/upload)
 * ユーザー専用のアバター画像を R2 に保存します。
 * メディアライブラリ(filesテーブル)には登録しません。
 */
export async function handleUploadAvatar(request: Request, env: Env): Promise<Response> {
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

    if (!file) {
      return new Response(JSON.stringify({ error: "No file was uploaded" }), {
        status: 400,
        headers,
      });
    }

    const ext = file.name.includes(".") ? `.${file.name.split(".").pop()}` : ".png";
    const filename = `${userId}-${Date.now()}${ext}`;
    const objectKey = `avatars/${filename}`;

    // R2 に保存
    await env.BUCKET.put(objectKey, file.stream(), {
      httpMetadata: {
        contentType: file.type || "image/png",
      },
    });

    const fileUrl = `/api/avatars/${filename}`;

    return new Response(
      JSON.stringify({
        success: true,
        fileUrl,
        avatarUrl: fileUrl,
      }),
      { status: 201, headers }
    );
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal Server Error" }), {
      status: 500,
      headers,
    });
  }
}

/**
 * 2. アバター画像取得 API (GET /api/avatars/:filename)
 * HTMLの <img> タグから直接読み込めるように、認証ヘッダー不要で画像ストリームを配信します。
 */
export async function handleGetAvatar(request: Request, env: Env, filename: string): Promise<Response> {
  try {
    if (!filename) {
      return new Response("Filename is required", { status: 400 });
    }

    // パスインジェクション対策
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "");
    const objectKey = `avatars/${sanitizedFilename}`;

    const obj = await env.BUCKET.get(objectKey);
    if (!obj) {
      return new Response("Avatar image not found", { status: 404 });
    }

    const responseHeaders = new Headers();
    obj.writeHttpMetadata(responseHeaders);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Cache-Control", "public, max-age=31536000, immutable");

    return new Response(obj.body, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (error: any) {
    return new Response("Internal Server Error: " + error.message, { status: 500 });
  }
}
