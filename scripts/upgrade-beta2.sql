-- Incremental upgrade script for existing pre-0.9-beta.2 databases.
-- Fresh databases already receive these columns from 0001_initial_schema.sql and installer.ts ensureSchema().
ALTER TABLE micros ADD COLUMN content_html TEXT DEFAULT '';
ALTER TABLE datasets ADD COLUMN sort_order INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_datasets_sort_order ON datasets(site_id, collection_id, sort_order DESC, updated_at DESC);
INSERT INTO system_meta (key, value) VALUES ('schema_version', '0.9.1')
ON CONFLICT(key) DO UPDATE SET value = '0.9.1', updated_at = CURRENT_TIMESTAMP;
