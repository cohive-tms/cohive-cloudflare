import { connect } from "cloudflare:sockets";
import { getJwtSecret } from "./jwt";
import type { Env } from "../[[route]]";

export async function getEncryptionSecret(env: Env): Promise<string> {
  if (env.ENCRYPTION_SECRET) {
    return env.ENCRYPTION_SECRET;
  }
  return await getJwtSecret(env);
}

export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  pass: string;
  fromName?: string;
  mfaEnabled?: boolean;
}

export interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

// AES-GCM によるデータの暗号化
export async function encryptText(text: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  // 秘密鍵を32バイトの境界に調整
  const keyBytes = enc.encode(secret.padEnd(32, "0").slice(0, 32));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(text)
  );

  const ivHex = Array.from(iv, (b) => b.toString(16).padStart(2, "0")).join("");
  const encryptedHex = Array.from(new Uint8Array(encrypted), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");

  return `${ivHex}:${encryptedHex}`;
}

// AES-GCM によるデータの復号
export async function decryptText(encryptedData: string, secret: string): Promise<string> {
  const parts = encryptedData.split(":");
  if (parts.length !== 2) throw new Error("Invalid encrypted format");
  const [ivHex, encryptedHex] = parts;

  const iv = new Uint8Array(
    ivHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
  );
  const encrypted = new Uint8Array(
    encryptedHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
  );

  const enc = new TextEncoder();
  const keyBytes = enc.encode(secret.padEnd(32, "0").slice(0, 32));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    encrypted
  );

  return new TextDecoder().decode(decrypted);
}

// データベースから暗号化されたSMTP設定を取得し、復号する
export async function getSmtpSettings(env: Env): Promise<SmtpSettings | null> {
  try {
    const result = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = ?"
    )
      .bind("smtp_settings")
      .first<{ value: string }>();

    if (!result || !result.value) {
      return null;
    }

    const secret = await getEncryptionSecret(env);
    const decryptedJson = await decryptText(result.value, secret);
    return JSON.parse(decryptedJson) as SmtpSettings;
  } catch (e) {
    console.error("Failed to retrieve or decrypt SMTP settings:", e);
    return null;
  }
}

// SMTP設定を暗号化してデータベースに保存する
export async function saveSmtpSettings(env: Env, settings: SmtpSettings): Promise<void> {
  const secret = await getEncryptionSecret(env);
  const encryptedJson = await encryptText(JSON.stringify(settings), secret);

  await env.DB.prepare(
    "INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  )
    .bind("smtp_settings", encryptedJson)
    .run();
}

// SMTP設定をデータベースから削除する（無効化）
export async function deleteSmtpSettings(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM system_settings WHERE key = ?")
    .bind("smtp_settings")
    .run();
}

// TCPソケットを使用したSMTP送信のコアロジック
class SmtpReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = "";

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  async readLine(): Promise<string> {
    while (true) {
      const index = this.buffer.indexOf("\r\n");
      if (index !== -1) {
        const line = this.buffer.substring(0, index + 2);
        this.buffer = this.buffer.substring(index + 2);
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) {
        if (this.buffer.length > 0) {
          const line = this.buffer;
          this.buffer = "";
          return line;
        }
        return "";
      }
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  releaseLock() {
    this.reader.releaseLock();
  }
}

export async function sendMail(settings: SmtpSettings, options: MailOptions): Promise<void> {
  const { host, port, user, pass, fromName } = settings;
  const fromEmail = user; // 送信者は基本認証ユーザーのものを利用

  // Cloudflare Workers の connect() でTCP接続
  const socket = connect(`${host}:${port}`, {
    secureTransport: port === 465 ? "on" : "off",
    allowHalfOpen: false,
  });

  const writer = socket.writable.getWriter();
  const reader = new SmtpReader(socket.readable.getReader());
  const encoder = new TextEncoder();

  const sendCmd = async (cmd: string) => {
    await writer.write(encoder.encode(cmd + "\r\n"));
  };

  try {
    // 1. サーバーステータスライン待機
    let resp = await reader.readLine();
    if (!resp.startsWith("220")) throw new Error(`SMTP Connect Error: ${resp}`);

    // 2. EHLO
    await sendCmd("EHLO localhost");
    resp = await reader.readLine();
    if (!resp.startsWith("250")) throw new Error(`SMTP EHLO Error: ${resp}`);
    while (resp.startsWith("250-") || (resp.length >= 4 && resp[3] === "-")) {
      resp = await reader.readLine();
    }

    // 3. AUTH LOGIN
    await sendCmd("AUTH LOGIN");
    resp = await reader.readLine();
    if (!resp.startsWith("334")) throw new Error(`SMTP AUTH LOGIN Error: ${resp}`);

    // 4. ユーザー名送信 (Base64)
    await sendCmd(btoa(user));
    resp = await reader.readLine();
    if (!resp.startsWith("334")) throw new Error(`SMTP AUTH Username Error: ${resp}`);

    // 5. パスワード送信 (Base64)
    await sendCmd(btoa(pass));
    resp = await reader.readLine();
    if (!resp.startsWith("235")) throw new Error(`SMTP AUTH Password Error: ${resp}`);

    // 6. MAIL FROM
    await sendCmd(`MAIL FROM:<${fromEmail}>`);
    resp = await reader.readLine();
    if (!resp.startsWith("250")) throw new Error(`SMTP MAIL FROM Error: ${resp}`);

    // 7. RCPT TO
    await sendCmd(`RCPT TO:<${options.to}>`);
    resp = await reader.readLine();
    if (!resp.startsWith("250")) throw new Error(`SMTP RCPT TO Error: ${resp}`);

    // 8. DATA
    await sendCmd("DATA");
    resp = await reader.readLine();
    if (!resp.startsWith("354")) throw new Error(`SMTP DATA Ready Error: ${resp}`);

    // 9. 本文構築・送信 (日本語文字化け対策に UTF-8 Base64 エンコードを採用)
    const boundary = "----=_Part_" + Math.random().toString(36).substring(2, 11);
    
    // 日本語のSubject/本文を安全にBase64化する関数
    const safeBtoa = (str: string) => btoa(unescape(encodeURIComponent(str)));

    const lines = [
      `From: ${fromName ? `"${fromName}" ` : ""}<${fromEmail}>`,
      `To: <${options.to}>`,
      `Subject: =?UTF-8?B?${safeBtoa(options.subject)}?=`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Math.random().toString(36).substring(2, 11)}@${host}>`,
      "",
      `--${boundary}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      "",
      safeBtoa(options.text),
      "",
      ...(options.html
        ? [
            `--${boundary}`,
            `Content-Type: text/html; charset="UTF-8"`,
            `Content-Transfer-Encoding: base64`,
            "",
            safeBtoa(options.html),
            "",
          ]
        : []),
      `--${boundary}--`,
      ".",
    ];

    const emailContent = lines.join("\r\n");

    await writer.write(encoder.encode(emailContent + "\r\n"));
    resp = await reader.readLine();
    if (!resp.startsWith("250")) throw new Error(`SMTP Send Content Error: ${resp}`);

    // 10. QUIT
    await sendCmd("QUIT");
    await reader.readLine();
  } finally {
    reader.releaseLock();
    writer.releaseLock();
    await socket.close();
  }
}
