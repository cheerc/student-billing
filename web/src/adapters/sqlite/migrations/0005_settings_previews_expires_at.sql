-- 0005_settings_previews_expires_at.sql: 為 settings_previews 增加 expires_at 欄位以支援 TTL

ALTER TABLE settings_previews ADD COLUMN expires_at TEXT;
