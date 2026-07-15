// Web Crypto API を用いた Web Push 送信用ユーティリティ (RFC 8188 & RFC 8291 準拠)

export interface WebPushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

function base64UrlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) {
    str += "=";
  }
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function createVapidJwt(privateKeyJwk: any, audience: string, subject: string): Promise<string> {
  const jwtSecret = await crypto.subtle.importKey(
    "jwk",
    privateKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const header = { alg: "ES256", typ: "JWT" };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, // 12時間有効
    sub: subject
  };

  const headerEncoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadEncoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = new TextEncoder().encode(`${headerEncoded}.${payloadEncoded}`);

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    jwtSecret,
    signingInput
  );

  return `${headerEncoded}.${payloadEncoded}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function encryptPayload(
  payload: string,
  keys: { p256dh: string; auth: string }
): Promise<{ body: Uint8Array }> {
  const userPublicKeyBytes = base64UrlDecode(keys.p256dh);
  const userAuthBytes = base64UrlDecode(keys.auth);

  // 1. 送信側の一時ECDH鍵ペア生成
  const localKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits", "deriveKey"]
  );

  // 2. ブラウザの公開鍵インポート
  const userPublicKey = await crypto.subtle.importKey(
    "raw",
    userPublicKeyBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  // 3. 共有シークレット（ECDH）生成
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: userPublicKey },
    localKeyPair.privateKey,
    256
  );

  // 4. ランダムソルト（16バイト）生成
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const localPublicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", localKeyPair.publicKey)
  );

  // 5. HKDF 鍵導出
  const sharedSecretKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(sharedSecret),
    { name: "HKDF" },
    false,
    ["deriveBits"]
  );

  // info prefix and context: "WebPush: info\0" + userPublicKey + localPublicKey
  const infoPrefix = new TextEncoder().encode("WebPush: info\0");
  const infoContext = new Uint8Array(infoPrefix.length + userPublicKeyBytes.length + localPublicKeyBytes.length);
  infoContext.set(infoPrefix);
  infoContext.set(userPublicKeyBytes, infoPrefix.length);
  infoContext.set(localPublicKeyBytes, infoPrefix.length + userPublicKeyBytes.length);

  const ikmPrime = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: userAuthBytes,
      info: infoContext
    },
    sharedSecretKey,
    256
  );

  const ikmPrimeKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(ikmPrime),
    { name: "HKDF" },
    false,
    ["deriveKey", "deriveBits"]
  );

  // 暗号鍵(CEK)の導出
  const cekKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt,
      info: new TextEncoder().encode("Content-Encoding: aes128gcm\0")
    },
    ikmPrimeKey,
    { name: "AES-GCM", length: 128 },
    false,
    ["encrypt"]
  );

  // IVの導出
  const iv = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt,
      info: new TextEncoder().encode("Content-Encoding: nonce\0")
    },
    ikmPrimeKey,
    96 // 12 bytes = 96 bits
  );

  // 6. ペイロード暗号化（末尾にデリミタ 0x02 を付加）
  const payloadBytes = new TextEncoder().encode(payload);
  const recordBytes = new Uint8Array(payloadBytes.length + 1);
  recordBytes.set(payloadBytes);
  recordBytes[payloadBytes.length] = 0x02; // デリミタ：単一レコードの終端

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(iv),
      tagLength: 128
    },
    cekKey,
    recordBytes
  );

  // 7. パケット組み立て (RFC 8188 Header + Ciphertext)
  // Header: salt(16) + rs(4) + idlen(1) + keyid(65)
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  header.set([ (rs >> 24) & 0xff, (rs >> 16) & 0xff, (rs >> 8) & 0xff, rs & 0xff ], 16);
  header.set([ 65 ], 20);
  header.set(localPublicKeyBytes, 21);

  const body = new Uint8Array(header.length + ciphertext.byteLength);
  body.set(header, 0);
  body.set(new Uint8Array(ciphertext), header.length);

  return { body };
}

export async function sendWebPush(
  subscription: WebPushSubscription,
  payload: string,
  vapidKey: { publicKey: string; privateKey: string },
  subject: string = "mailto:admin@cohive.dev"
): Promise<Response> {
  const endpointUrl = new URL(subscription.endpoint);
  const audience = endpointUrl.origin;

  // JWTの作成
  const privateKeyJwk = JSON.parse(vapidKey.privateKey);
  const jwt = await createVapidJwt(privateKeyJwk, audience, subject);

  // ペイロード暗号化
  const { body } = await encryptPayload(payload, subscription.keys);

  // VAPID 公開鍵の Raw Base64URL 表現
  const publicKeyJwk = JSON.parse(vapidKey.publicKey);
  const cryptoPubKey = await crypto.subtle.importKey(
    "jwk",
    publicKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    []
  );
  const rawPubKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", cryptoPubKey));
  const base64UrlPubKey = base64UrlEncode(rawPubKeyBytes);

  const headers: HeadersInit = {
    "TTL": "86400", // 24時間保持
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    "Authorization": `vapid t=${jwt}, k=${base64UrlPubKey}`
  };

  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers,
    body
  });

  return response;
}

export async function generateVapidKeys() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );

  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

  return {
    publicKey: JSON.stringify(publicKeyJwk),
    privateKey: JSON.stringify(privateKeyJwk)
  };
}
