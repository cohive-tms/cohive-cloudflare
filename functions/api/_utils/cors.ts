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

      // ドメインが一致するか、または同一親ドメインのサブドメインである場合に許可
      const baseDomain = url.host.replace(/^api\./, '');
      const isAllowed = allowedOrigins.includes(origin) || 
        (origin.startsWith("http") && (origin.endsWith(baseDomain) || origin.endsWith("." + baseDomain)));

      if (isAllowed) {
        allowedOrigin = origin;
      } else {
        allowedOrigin = allowedOrigins[0] || "http://localhost:5173";
      }
    } catch {
      allowedOrigin = "http://localhost:5173";
    }
  } else {
    allowedOrigin = "*";
  }

  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, X-Workspace-Id, X-User-Id, Authorization",
  };
}
