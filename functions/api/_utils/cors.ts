export function getCorsHeaders(
  request: Request,
  methods: string = "GET, POST, PUT, DELETE, OPTIONS",
  env?: any
): Record<string, string> {
  const origin = request.headers.get("Origin");
  let allowedOrigin = "";

  if (origin) {
    try {
      const url = new URL(request.url);
      const selfOrigin = url.origin;
      
      const allowedOrigins = [
        selfOrigin,
        "http://localhost:5173",
        "http://localhost:3000",
        "http://127.0.0.1:5173"
      ];

      if (env?.ALLOWED_ORIGINS) {
        const extra = env.ALLOWED_ORIGINS.split(",").map((o: string) => o.trim());
        allowedOrigins.push(...extra);
      }

      // ドメインが一致するか、または同一親ドメインの厳密なサブドメインである場合に許可
      const reqHost = url.hostname;
      const originUrl = new URL(origin);
      const originHost = originUrl.hostname;
      const baseDomain = reqHost.replace(/^api\./, '');

      const isSubdomainOfBase = baseDomain.includes('.') && 
        !baseDomain.endsWith('.pages.dev') && 
        !baseDomain.endsWith('.workers.dev') && 
        originHost.endsWith('.' + baseDomain);

      const isAllowed = allowedOrigins.includes(origin) || 
        originHost === reqHost || 
        originHost === baseDomain || 
        isSubdomainOfBase;

      if (isAllowed) {
        allowedOrigin = origin;
      } else {
        allowedOrigin = "";
      }
    } catch {
      allowedOrigin = "";
    }
  } else {
    allowedOrigin = "*";
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };

  if (allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
    if (allowedOrigin !== "*") {
      headers["Access-Control-Allow-Credentials"] = "true";
    }
  }

  return headers;
}
