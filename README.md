# 💬 cospace

A zero-cost, fully self-hosted, and ultra-lightweight business collaboration platform.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cospace-tms/cospace)

---

## 🌟 Overview

**cospace** is an ultra-lightweight, fully independent (self-hosted) business communication and collaboration application designed to break you free from vendor lock-in, soaring monthly fees, and data limits of proprietary platforms.

By leveraging Cloudflare’s powerful serverless ecosystem (Pages, Workers, D1, R2), you can deploy a secure, private collaboration environment to your own infrastructure with a single click.

---

## 🚀 Key Features

| Feature | Description |
| :--- | :--- |
| 🛡️ **Full Multi-Tenancy** | Automatically provisions a dedicated **Cloudflare D1 database** for each organization/company, ensuring enterprise-grade security and privacy. |
| 🍃 **Eco-Polling** | Replaces resource-heavy WebSockets with smart polling. It automatically slows down or pauses requests when a tab is inactive, dramatically reducing server load. |
| ⚡ **Optimistic UI** | Experience zero-latency communication. Sent messages appear in the chat instantly without waiting for server round-trips. |
| 📅 **Task & Calendar Integration** | A built-in Kanban task board integrated with a calendar to keep your team's schedule and tasks aligned. |
| 📝 **Co-editing Documents** | Live-editable Markdown documents shared across the workspace or individual channels. |
| 📁 **Secure Media Library** | An access-controlled asset library syncing with chat permissions to securely browse, upload, and manage files. |
| 💰 **Zero Infrastructure Cost** | Run your entire team's operations for $0/month by fitting comfortably within Cloudflare's generous **Free Tier**. |

---

## 🛠️ Deployment Guide (Step-by-Step)

### 📋 Prerequisites
Before you begin, ensure you have:
* A **Cloudflare Account** (Free tier is completely fine).
* A **GitHub Account** (Required for Cloudflare Pages integration).

---

### 1. Click the Deploy Button
Click the button below to start the deployment process:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cospace-tms/cospace)

### 2. Authorize & Deploy on Cloudflare
1. Log in to (or sign up for) your Cloudflare dashboard and authorize GitHub access.
2. Cloudflare will **automatically fork/import** this repository into your own GitHub account.
3. Build configurations and database bindings will be **automatically populated** based on `wrangler.toml`. Simply click "Connect" and "Deploy".

### 3. Visit the URL & Register
Once deployed, Cloudflare will provide a `https://xxx.pages.dev` URL. 
Visiting this URL for the first time will **automatically initialize the D1 database tables**. Fill out the administrator setup form, and you are ready to go!

### 4. Recommended: Configure SMTP Email Settings
By default, email sending is **optional**. However, without email settings, you must rely on:
* **Recovery Code** for administrator password recovery (provided during setup).
* **Temporary passwords** issued by the administrator for other workspace members.

To unlock full capabilities (automated workspace invitation emails, offline notifications, and MFA), log in as an administrator, navigate to **Workspace Settings > Email Sending Settings**, and enter your SMTP server credentials (e.g., Google App Password or SMTP credentials from your hosting provider).

---

## 💡 Under the Hood: What happens in Cloudflare?

When you click deploy, Cloudflare provisions and configures the following resources automatically in your account:

1. **Pages Project**: Hosts the frontend assets and backend serverless API (Functions).
2. **D1 Database (SQL)**: Automatically creates a database named `cospace_db`.
3. **R2 Bucket (Object Storage)**: Automatically creates a storage bucket named `cospace-storage` for attachments/media.
4. **Bindings**: Automatically connects the D1 Database and R2 Bucket to your Pages Functions.
5. **Database Initialization**: On your first visit to the deployment URL, the application code automatically executes schema creation (no manual SQL execution needed).

---

## 🔒 Security Best Practices (Cloudflare Configuration)

For production deployments, we strongly recommend implementing the following security measures in your Cloudflare Dashboard:

### 1. Web Application Firewall (WAF) Rules
Configure custom WAF rules to protect your application from malicious bots and unauthorized access:
* **Geoblocking**: If your team is located in a specific country, restrict access to that country only.
  - *Rule Expression*: `(ip.geoip.country ne "JP")` -> Action: *Block* (Replace `JP` with your country code).
* **IP Whitelisting**: If you have a static office IP, you can lock down the entire `/api/*` endpoints to your IP.

### 2. Cloudflare Zero Trust (Access)
Add an extra layer of protection by placing Cloudflare Access in front of your deployment:
* Go to Cloudflare Dashboard > **Zero Trust** > **Access** > **Applications**.
* Create a self-hosted application for your cospace domain.
* Set up a policy requiring identity verification (like Email One-Time Pin or Google Workspace OAuth) before anyone can access the site. This fully protects your application from exposure even if there are unpatched software vulnerabilities.

---

# 💬 cospace (日本語)

「維持費0円から始められる、完全独立（セルフホスト）型の超軽量ビジネスコラボレーションプラットフォーム」

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cospace-tms/cospace)

---

## 🌟 プロジェクト概要

**cospace** は、SlackやTeamsといった既存チャットツールのベンダーロックイン（高額な月額費用、メッセージ保存制限、データ管理権の喪失）からあなたを解放するために開発された、**完全独立（セルフホスト）型**の超軽量コラボレーションアプリです。

Cloudflareの強力なサーバーレスエコシステム（Pages, Workers, D1, R2）をフル活用することで、**ボタン1つであなた専用のセキュアな環境を構築**できます。

---

## 🚀 主な機能・特徴

| 特徴 | 詳細説明 |
| :--- | :--- |
| 🛡️ **完全マルチテナント** | 各組織（会社）ごとに個別の**D1データベース**を自動割り当て。物理的にデータが分離され、最高水準のセキュリティを担保します。 |
| 🍃 **超・省エネポーリング** | 常時接続が必要なWebSocketを使用せず、非アクティブ時に**通信頻度を自動的に減速・停止**するインテリジェント設計でサーバー負荷を極限まで抑えます。 |
| ⚡ **楽観的UI (Optimistic UI)** | サーバー応答を待たずにメッセージを即時描画。ネットワーク遅延を感じさせない、サクサクとした書き込み体験を提供します。 |
| 📅 **タスク＆カレンダー統合** | カレンダーの予定と密接に連携した、カンバン形式のタスク管理機能を内蔵。チームのスケジュールを一元管理できます。 |
| 📝 **ドキュメント共同編集** | ワークスペース全体、またはチャンネルごとにリアルタイムで共同編集・共有可能なマークダウンドキュメント機能。 |
| 📁 **閲覧制限付きメディアライブラリ** | チャットの閲覧権限（パブリック/プライベート/DM）と同期したアクセス制御を持つ、安全なメディアストレージと管理画面。 |
| 💰 **維持費0円 (Free Tier運用)** | すべての機能がCloudflareの**無料枠（Free Tier）**内で動作するよう最適化。小中規模チームなら完全0円で運用可能です。 |

---

## 🛠️ デプロイ方法（ステップ・バイ・ステップ）

### 📋 事前準備（必要なもの）
デプロイを開始する前に、以下を用意してください：
* **Cloudflare アカウント**（無料プランで完全に動作します）
* **GitHub アカウント**（Cloudflare Pages との連携・コードコピーに必要です）

---

### 1. デプロイボタンをクリックする
以下の「Deploy to Cloudflare Pages」ボタンをクリックします。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cospace-tms/cospace)

### 2. 画面の指示に従いデプロイを完了する
1. Cloudflare アカウントへログイン（または新規登録）し、GitHub アカウントとの連携を承認します。
2. 承認後、Cloudflare Pages が**このリポジトリをあなたの GitHub アカウントへ自動的にフォーク（コピー）**します。
3. ビルド設定やデータベースなどの連携は、設定ファイル（`wrangler.toml`）を元に**すべて自動で入力・作成される**ため、そのまま「Connect」や「Deploy」を進めてデプロイを完了させます。

### 3. 生成された URL にアクセスして運用開始！
デプロイ完了後、提供される `https://xxx.pages.dev` という専用の公開 URL にアクセスします。
デプロイ後、公開 URL に初めてアクセスした瞬間に、**データベースが自動で初期化（テーブルが作成）**され、管理者アカウントの初期設定画面が表示されます。

### 4. 推奨：メール送信設定（SMTP）の有効化
初期デプロイ直後は、メール機能は**オプション（任意）**となっています。メール設定を行わない場合、以下の運用になります：
* 最管理者のパスワード紛失時の復旧は、初期登録時に発行される**「リカバリーコード」**で行います。
* 一般メンバーのパスワード紛失時は、管理者が管理画面から**「一時パスワードを発行」**して手動で本人に伝えます。

自動での招待メール配信、オフライン時のメンション通知、2段階認証などのフル機能を利用したい場合は、管理者アカウントでログインし、**「ワークスペース管理」 > 「メール送信設定」** から、お使いのSMTPサーバー情報（Gmailのアプリパスワードや、レンタルサーバーのSMTPアカウント情報など）を設定してください。

---

## 💡 デプロイすると Cloudflare 上で何が起こるの？（作成されるリソース）

ワンクリックデプロイを実行すると、Cloudflare 側で以下のリソースが自動的に作成・設定されます。何が起こっているか不安な方は参考にしてください：

1. **Pages プロジェクトの作成**:
   * アプリケーションのフロントエンド（静的ファイル）およびバックエンド API（Functions）をホストするための場所が作成されます。
2. **D1 データベース（SQL データベース）の作成**:
   * アカウント内に `cospace_db` という名前の軽量 SQL データベースが自動で作成されます。
3. **R2 バケット（オブジェクトストレージ）の作成**:
   * アカウント内に `cospace-storage` という名前のメディアファイル（画像や添付ファイル）保存用ストレージが自動で作成されます。
4. **リソースの接続（バインディング）**:
   * 作成された D1 データベースと R2 バケットが、Pages プロジェクトの「関数設定」に自動的に紐付けられ、プログラムからアクセスできるようになります。
5. **テーブルの自動作成（初回アクセス時）**:
   * デプロイ後、公開 URL に初めてアクセスした瞬間に、プログラムが D1 内にユーザーテーブルやメッセージテーブルなどの必要な構造（テーブルやインデックス）を自動的に作成します（手動の SQL 実行は不要です）。

---

## 🔒 セキュリティ向上のための推奨設定 (Cloudflare)

本番運用を開始するにあたり、より強固なセキュリティを確保するため、Cloudflare ダッシュボードから以下の設定を行うことを強く推奨します。

### 1. WAF (Web Application Firewall) によるアクセス制限
悪意のあるボットや海外からのアタックをネットワークレベルで遮断します。
* **国別制限 (ジオブロック)**: 利用するメンバーが国内に限られる場合、日本国外からのアクセスをすべてブロックします。
  - *カスタムルール式の例*: `(ip.geoip.country ne "JP")` -> アクション: *ブロック*
* **IPアドレス制限**: 固定IP環境がある場合、特定のIPからのみアクセスを許可します。

### 2. Cloudflare Zero Trust (Access) による二重防御
ログイン画面の手前に Cloudflare Access を配置し、認証されたユーザーしかアプリにアクセスできないようにします。
* Cloudflare ダッシュボードの **Zero Trust** > **Access** > **Applications** に進みます。
* デプロイした cospace のドメイン宛のアプリケーションを作成します。
* 特定のメールアドレスやドメイン（例: `@yourcompany.com`）のユーザーに対して、ワンタイムPINや外部IDプロバイダ認証を要求するポリシーを設定します。これにより、ネットワークレベルで関係者以外のアクセスを完全に排除できます。

---

## 💻 ローカル開発方法

ローカルで動作確認および開発を行うための手順です。

### 1. 依存関係のインストール
プロジェクトのルートディレクトリで必要な依存関係をインストールします。

```bash
npm install
```


### 2. ローカル開発サーバーの起動
Vite 開発サーバーと Cloudflare Pages Functions (Wrangler) の両方を起動します。

**ターミナル 1 (Pages Functions API サーバーの起動):**
```bash
npm run pages:dev
```

**ターミナル 2 (フロントエンド Vite サーバーの起動):**
```bash
npm run dev
```

起動後、ブラウザで [http://localhost:3000](http://localhost:3000) にアクセスします。
（フロントエンドの API リクエストは `vite.config.ts` のプロキシ設定により `localhost:8788` の Pages Functions API へ自動で転送されます）