# 💬 cohive

A zero-cost, fully self-hosted, and ultra-lightweight business collaboration platform.

> 🇯🇵 **[日本語版 README はこちら (Japanese Documentation)](./README.ja.md)**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cohive-tms/cohive-cloudflare)
[![Live Demo](https://img.shields.io/badge/Live_Demo-Try_Now-brightgreen?style=flat-square&logo=cloudflare)](https://demo.cohive.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## 🌟 Overview

**cohive** is an ultra-lightweight, fully independent (self-hosted) business communication and collaboration application designed to break you free from vendor lock-in, soaring monthly fees, and data limits of proprietary platforms.

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
2. **D1 Database (SQL)**: Automatically creates a database named `cohive_db`.
3. **R2 Bucket (Object Storage)**: Automatically creates a storage bucket named `cohive-storage` for attachments/media.
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
* Create a self-hosted application for your cohive domain.
* Set up a policy requiring identity verification (like Email One-Time Pin or Google Workspace OAuth) before anyone can access the site. This fully protects your application from exposure even if there are unpatched software vulnerabilities.

---

## 💻 Local Development Guide

Steps for local development and testing:

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Local Servers
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

## 📄 License & Policies

* **License**: [MIT License](./LICENSE)
* **Privacy Policy**: [PRIVACY.md](./PRIVACY.md)
* **Terms of Service**: [TERMS.md](./TERMS.md)
* **Security Policy**: [SECURITY.md](./SECURITY.md)