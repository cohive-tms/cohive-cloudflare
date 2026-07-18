import type { Env } from "../../[[route]]";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id",
};

// 簡易スニペット生成関数（マッチした単語の周辺を切り取る ＆ ハイライト）
function createSnippet(content: string, words: string[]): string {
  if (!content) return "";
  const lowerContent = content.toLowerCase();
  
  // 最初に一致したキーワードの位置を探す
  let firstIdx = -1;
  let matchedWord = "";
  for (const word of words) {
    const idx = lowerContent.indexOf(word.toLowerCase());
    if (idx !== -1) {
      if (firstIdx === -1 || idx < firstIdx) {
        firstIdx = idx;
        matchedWord = word;
      }
    }
  }
  
  // 一致する単語がない場合は先頭から100文字を返す
  if (firstIdx === -1) {
    return content.substring(0, 100) + (content.length > 100 ? "..." : "");
  }
  
  // 一致箇所の前後を切り取る
  const start = Math.max(0, firstIdx - 30);
  const end = Math.min(content.length, firstIdx + matchedWord.length + 50);
  
  let snippet = content.substring(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";
  
  // マッチした単語を <mark> タグで囲む（ハイライト用）
  for (const word of words) {
    const escapedWord = word.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(escapedWord, 'gi');
    snippet = snippet.replace(regex, (match) => `<mark>${match}</mark>`);
  }
  
  return snippet;
}

// ワークスペース内横断全文検索 API
export async function handleSearchWorkspace(
  request: Request,
  env: Env,
  workspaceId: string
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const queryParam = url.searchParams.get("q") || "";
    const userId = request.headers.get("X-User-Id");

    if (!workspaceId) {
      return new Response(JSON.stringify({ error: "workspaceId is required" }), {
        status: 400,
        headers,
      });
    }

    if (!userId) {
      return new Response(JSON.stringify({ error: "User unauthorized" }), {
        status: 401,
        headers,
      });
    }

    if (!queryParam.trim()) {
      return new Response(JSON.stringify({ success: true, data: { messages: [], documents: [] } }), {
        status: 200,
        headers,
      });
    }

    // 複数単語のパース (スペース区切り)
    const words = queryParam.trim().split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) {
      return new Response(JSON.stringify({ success: true, data: { messages: [], documents: [] } }), {
        status: 200,
        headers,
      });
    }

    // 1. LIKE 複合条件の構築 (メッセージ)
    // 各キーワードが、本文(content)・送信者名(displayName)・チャンネル名(channelName)のいずれかに含まれる（AND）
    const messageConditions = words.map(() => "(m.content LIKE ? OR u.display_name LIKE ? OR c.name LIKE ?)");
    const messageWhereClause = messageConditions.join(" AND ");
    
    const isAll = workspaceId === "all";

    // バインドパラメータの構築
    const messageBindParams: any[] = [];
    if (isAll) {
      messageBindParams.push(userId, userId);
    } else {
      messageBindParams.push(workspaceId, userId);
    }
    words.forEach(w => {
      const likeVal = `%${w}%`;
      messageBindParams.push(likeVal, likeVal, likeVal);
    });

    // メッセージ検索クエリの実行
    const messageQuery = `
      SELECT 
        m.id,
        m.channel_id as channelId,
        c.name as channelName,
        m.user_id as userId,
        u.display_name as userDisplayName,
        m.content,
        m.created_at as createdAt,
        (CASE WHEN pm.message_id IS NOT NULL THEN 1 ELSE 0 END) as isPinned
      FROM messages m
      INNER JOIN channels c ON m.channel_id = c.id
      LEFT JOIN users u ON m.user_id = u.id
      LEFT JOIN message_pins pm ON m.id = pm.message_id
      WHERE ${isAll ? "c.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?)" : "c.workspace_id = ?"}
        AND (
          c.is_private = 0 
          OR EXISTS (
            SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?
          )
        )
        AND (${messageWhereClause})
      ORDER BY m.created_at DESC
      LIMIT 100
    `;
    const messageResults = await env.DB.prepare(messageQuery).bind(...messageBindParams).all<any>();

    // 2. LIKE 複合条件の構築 (ドキュメント)
    // 各キーワードが、タイトル(title)・本文(content)のいずれかに含まれる（AND）
    const documentConditions = words.map(() => "(fts.title LIKE ? OR fts.content LIKE ?)");
    const documentWhereClause = documentConditions.join(" AND ");
    
    // バインドパラメータの構築
    const documentBindParams: any[] = [];
    if (isAll) {
      documentBindParams.push(userId, userId, userId);
    } else {
      documentBindParams.push(workspaceId, workspaceId, userId);
    }
    words.forEach(w => {
      const likeVal = `%${w}%`;
      documentBindParams.push(likeVal, likeVal);
    });

    // ドキュメント検索クエリの実行
    const documentQuery = `
      SELECT 
        fts.source_type as sourceType,
        fts.source_id as sourceId,
        fts.title,
        fts.content
      FROM documents_fts fts
      WHERE (
        -- ワークスペースドキュメント
        (fts.source_type = 'workspace' AND ${isAll ? "fts.source_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?)" : "fts.source_id = ?"})
        OR
        -- チャンネルドキュメント
        (fts.source_type = 'channel' AND EXISTS (
          SELECT 1 FROM channels c
          WHERE c.id = fts.source_id
            AND ${isAll ? "c.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?)" : "c.workspace_id = ?"}
            AND (
              c.is_private = 0
              OR EXISTS (
                SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?
              )
            )
        ))
      )
      AND (${documentWhereClause})
      LIMIT 50
    `;
    const documentResults = await env.DB.prepare(documentQuery).bind(...documentBindParams).all<any>();

    return new Response(JSON.stringify({
      success: true,
      data: {
        messages: messageResults.results.map((row: any) => ({
          id: row.id,
          channelId: row.channelId,
          channelName: row.channelName,
          userId: row.userId,
          userDisplayName: row.userDisplayName || "Unknown User",
          content: row.content,
          createdAt: row.createdAt,
          snippet: createSnippet(row.content, words),
          isPinned: !!row.isPinned,
        })),
        documents: documentResults.results.map((row: any) => ({
          sourceType: row.sourceType,
          sourceId: row.sourceId,
          title: row.title,
          content: row.content,
          snippet: createSnippet(row.content, words),
        })),
      }
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
