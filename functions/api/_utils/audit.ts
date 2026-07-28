import { Env } from "../[[route]]";

export async function logAudit(
  env: Env,
  workspaceId: string | null,
  userId: string | null,
  action: string,
  details: any,
  request?: Request
) {
  try {
    const id = crypto.randomUUID();
    const ipAddress = request ? (request.headers.get("CF-Connecting-IP") || "127.0.0.1") : null;
    const localIp = request ? request.headers.get("X-Local-Ip") : null;
    const computerName = request ? request.headers.get("X-Computer-Name") : null;
    const detailsStr = typeof details === "string" ? details : JSON.stringify(details);

    await env.DB.prepare(`
      INSERT INTO audit_logs (id, workspace_id, user_id, action, details, ip_address, local_ip, computer_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(id, workspaceId, userId, action, detailsStr, ipAddress, localIp, computerName).run();
  } catch (err: any) {
    console.error("Failed to log audit activity with full schema, trying fallback insertion:", err);
    try {
      const id = crypto.randomUUID();
      const ipAddress = request ? (request.headers.get("CF-Connecting-IP") || "127.0.0.1") : null;
      const detailsStr = typeof details === "string" ? details : JSON.stringify(details);

      await env.DB.prepare(`
        INSERT INTO audit_logs (id, workspace_id, user_id, action, details, ip_address, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).bind(id, workspaceId, userId, action, detailsStr, ipAddress).run();
    } catch (fallbackErr) {
      console.error("Failed to log audit activity fallback:", fallbackErr);
    }
  }
}
