# 💬 CoHive

A zero-cost, fully self-hosted, and ultra-lightweight business collaboration platform.

> 🇯🇵 **[日本語版 README はこちら (Japanese Documentation)](./README.ja.md)**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cohive-tms/cohive-cloudflare)
[![Live Demo](https://img.shields.io/badge/Live_Demo-Try_Now-brightgreen?style=flat-square&logo=cloudflare)](https://demo.cohive.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## 🌟 Overview

**CoHive** is an ultra-lightweight, fully independent (self-hosted) business communication and collaboration application designed to break you free from vendor lock-in, soaring monthly fees, and data limits of proprietary platforms.

By leveraging Cloudflare’s powerful serverless ecosystem (Pages, Workers, D1, R2), you can deploy a secure, private collaboration environment to your own infrastructure with a single click.

* 🚀 **[Try Live Demo](https://demo.cohive.dev)** (Explore without installation)
* 🔒 **[Privacy Policy](./PRIVACY.md)** (Zero data tracking / selling guaranteed)
* 📄 **[Terms of Service](./TERMS.md)**

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

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cohive-tms/cohive-cloudflare)

> 💡 **Automatic Updates**  
> Repositories deployed via this button include a GitHub Actions workflow (`.github/workflows/auto-sync.yml`) that automatically syncs fixes and features from upstream daily, keeping your app **up-to-date automatically without manual action**.  
> 
> **※ Note for Manual Management:**  
> If you prefer to manage updates manually or customize the codebase yourself, please **`Fork`** (or `Use this template`) this repository into your account first. To stop automatic updates, simply delete the `.github/workflows/auto-sync.yml` file (or disable it under the GitHub Actions tab) in your repository.

### 2. Authorize & Deploy on Cloudflare
1. Log in to (or sign up for) your Cloudflare dashboard and authorize GitHub access.
2. Cloudflare will **automatically import** this repository into your own GitHub account.
3. Build configurations and database bindings will be **automatically populated** based on `wrangler.toml`. Simply click "Connect" and "Deploy".

### 3. Visit the URL & Register
Once deployed, Cloudflare will provide a `https://xxx.pages.dev` URL. 
Visiting this URL for the first time will **automatically initialize the D1 database tables**. Fill out the administrator setup form, and you are ready to go!

---

## 🚀 Production Setup Checklist

When moving your deployment into active production for your team or organization, we strongly recommend following these setup steps to ensure optimal security and operational readiness.

```mermaid
flowchart TD
    Step1["🚀 STEP 1: One-Click Deploy<br/>(Initial setup & Admin registration)"] --> Step2["🔑 STEP 2: Configure ENCRYPTION_SECRET<br/>(Physical key-data separation against DB leaks)"]
    Step2 --> Step3["✉️ STEP 3: Configure SMTP Email<br/>(Invitations, MFA & Offline notifications)"]
    Step3 --> Step4["🌐 STEP 4: Custom Domain & Access Rules<br/>(CORS restriction, WAF & Zero Trust)"]
```

### 1. 🔑 Strongly Recommended: Set `ENCRYPTION_SECRET` Environment Variable
By default (without environment variables), encryption keys are auto-generated and stored directly inside the D1 database.  
To **completely eliminate the risk of decrypted credentials in the event of a full D1 database leak**, you should store your encryption secret in Cloudflare Workers environment variables (Secrets).

* **Setup Instructions**:
  1. Go to Cloudflare Dashboard > **Workers & Pages** > Select your deployed project.
  2. Navigate to **Settings > Environment Variables**.
  3. Click **Add variable** and configure:
     - **Variable name**: `ENCRYPTION_SECRET`
     - **Value**: A random 32+ byte secret string (e.g. generated via `openssl rand -hex 32`)
     - **Type**: `Secret (Encrypted)`

> 💡 **Physical Separation Benefit**  
> This physically separates the decryption key from the D1 database storage. Even if your entire D1 database dump is compromised, sensitive values like SMTP passwords **cannot be decrypted**.

---

### 2. ✉️ Recommended: Configure SMTP Email Settings
By default, email sending is **optional**. However, without email settings, you must rely on:
* **Recovery Code** for administrator password recovery (provided during setup).
* **Temporary passwords** issued by the administrator for other workspace members.

To unlock full capabilities (automated workspace invitation emails, offline notifications, and MFA), log in as an administrator, navigate to **Workspace Settings > Email Sending Settings**, and enter your SMTP server credentials (e.g., Google App Password or SMTP credentials from your provider).

---

## 💡 Under the Hood: What happens in Cloudflare?

When you click deploy, Cloudflare provisions and configures the following resources automatically in your account:

1. **Pages Project**: Hosts the frontend assets and backend serverless API (Functions).
2. **D1 Database (SQL)**: Automatically creates a database named `cohive_db`.
3. **R2 Bucket (Object Storage)**: Automatically creates a storage bucket named `cohive-storage` for attachments/media.
4. **Binding**: Automatically connects the D1 Database and R2 Bucket to your Pages Functions.
5. **Database Initialization**: On your first visit to the deployment URL, the application code automatically executes schema creation (no manual SQL execution needed).

---

## 🔒 Security Best Practices (Cloudflare Configuration)

For production deployments, we strongly recommend implementing the following security measures in your Cloudflare Dashboard:

### 1. Physical Key Separation (`ENCRYPTION_SECRET`)
Set `ENCRYPTION_SECRET` in Cloudflare Pages Environment Variables as described above to physically separate the encryption key from D1 storage.

### 2. Restrict CORS Origins (`ALLOWED_ORIGINS`)
Set `ALLOWED_ORIGINS` to your production domain (e.g., `https://chat.yourcompany.com`) to prevent unauthorized cross-origin API requests from third-party websites.

### 3. Web Application Firewall (WAF) Rules
Configure custom WAF rules to protect your application from malicious bots and unauthorized access:
* **Geoblocking**: If your team is located in a specific country, restrict access to that country only.
  - *Rule Expression*: `(ip.geoip.country ne "JP")` -> Action: *Block* (Replace `JP` with your country code).
* **IP Whitelisting**: If you have a static office IP, you can lock down access to your IP only.

### 4. Cloudflare Zero Trust (Access)
Add an extra layer of protection by placing Cloudflare Access in front of your deployment:
* Go to Cloudflare Dashboard > **Zero Trust** > **Access** > **Applications**.
* Create a self-hosted application for your cohive domain.
* Set up a policy requiring identity verification (like Email One-Time Pin or Google Workspace OAuth) before anyone can access the site. This fully protects your application from exposure even if there are unpatched software vulnerabilities.

---

## ⚙️ Environment Variables

| Variable | Required | Description |
| :--- | :--- | :--- |
| `ENCRYPTION_SECRET` | **Recommended for Prod** | 32-byte secret used to encrypt sensitive configuration (e.g., SMTP passwords) using AES-GCM. Setting this physically separates the key from D1 database storage. |
| `ALLOWED_ORIGINS` | Optional | Comma-separated list of allowed CORS origins (e.g., `https://cohive.dev,https://app.cohive.dev`). |
| `JWT_SECRET` | Optional | Custom secret key for signing JWT tokens. Auto-generated and stored in D1 database on setup if omitted. |
| `R2_ACCESS_KEY_ID` | Optional | Cloudflare R2 Access Key ID (required for generating S3 presigned URLs & direct uploads). |
| `R2_SECRET_ACCESS_KEY` | Optional | Cloudflare R2 Secret Access Key. |
| `R2_ACCOUNT_ID` | Optional | Cloudflare Account ID for R2 endpoints. |

---

## 💻 Local Development Guide

Steps for local development and testing:

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Local Settings
Copy `wrangler.example.toml` to `wrangler.toml` and fill in your Cloudflare resource IDs:
```bash
cp wrangler.example.toml wrangler.toml
```

### 3. Run Local Servers
Start both Vite frontend server and Pages Functions API server:

**Terminal 1 (API Server):**
```bash
npm run pages:dev
```

**Terminal 2 (Frontend Dev Server):**
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## ⚠️ Disclaimer & Important Notes

### 🧪 1. Beta Status (Public Preview)
* **CoHive** is currently provided as a **Beta / Public Preview** release.
* Unintended bugs, breaking changes, or database schema updates may occur in future versions. Regular backups are recommended for critical data.

### 🛡️ 2. Disclaimer of Warranty & Liability
* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
* IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES, DATA LOSS, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### 💬 3. Support & Feedback Policy
* CoHive is an open-source project created by an individual developer. Dedicated 24/7 technical support or guaranteed SLA is not provided.
* Please report bugs and feature requests via [GitHub Issues](https://github.com/cohive-tms/cohive-cloudflare/issues) (handled on a best-effort basis).

### 💼 4. Sponsor Edition (SaaS / Multi-Workspace Edition)
* The private repository provided to sponsors serves as a token of gratitude for supporting ongoing development. It does not constitute a commercial product warranty or Enterprise SLA.

---

## 📄 License & Policies

* **License**: [MIT License](./LICENSE)
* **Privacy Policy**: [PRIVACY.md](./PRIVACY.md)
* **Terms of Service**: [TERMS.md](./TERMS.md)
* **Security Policy**: [SECURITY.md](./SECURITY.md)