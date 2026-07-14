-- メールアドレス変更要求を一時的に保存するテーブル
CREATE TABLE IF NOT EXISTS email_change_requests (
    user_id TEXT PRIMARY KEY,
    new_email TEXT NOT NULL,
    verification_code TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
