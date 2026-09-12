CREATE TABLE `mcp_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`scopes_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`revoked_at_ms` integer,
	`last_used_at_ms` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_mcp_connection_hash` ON `mcp_connection` (`token_hash`);--> statement-breakpoint
CREATE INDEX `ix_mcp_connection_user` ON `mcp_connection` (`user_id`);--> statement-breakpoint
CREATE TABLE `mcp_mutation` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`request_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `mcp_connection`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_mcp_mutation_request` ON `mcp_mutation` (`connection_id`,`request_key`);--> statement-breakpoint
CREATE TABLE `mcp_request` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`operation` text NOT NULL,
	`payload_json` text NOT NULL,
	`summary` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`decided_at_ms` integer,
	`decided_by` text,
	`result_json` text,
	FOREIGN KEY (`connection_id`) REFERENCES `mcp_connection`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`decided_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `ix_mcp_request_state` ON `mcp_request` (`state`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `document_text` (
	`attachment_id` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`extractor_version` text NOT NULL,
	`status` text NOT NULL,
	`pages_json` text DEFAULT '[]' NOT NULL,
	`error` text,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `integrity_quarantine` (
	`id` text PRIMARY KEY NOT NULL,
	`original_path` text NOT NULL,
	`quarantined_at_ms` integer NOT NULL,
	`actor_user_id` text NOT NULL,
	`restored_at_ms` integer,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
-- app_alert has no child foreign keys. Rebuild only this leaf table to add integrity.
-- Keep foreign keys enabled; never rebuild asset/attachment/route parent tables.
CREATE TABLE `__new_app_alert` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`entity_table` text,
	`entity_id` text,
	`title` text NOT NULL,
	`body` text,
	`dedupe_key` text NOT NULL,
	`first_seen_at_ms` integer NOT NULL,
	`last_seen_at_ms` integer NOT NULL,
	`seen_count` integer DEFAULT 1 NOT NULL,
	`acknowledged_at_ms` integer,
	`acknowledged_by` text,
	`resolved_at_ms` integer,
	FOREIGN KEY (`acknowledged_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_app_alert_kind" CHECK(kind IN ('low_stock', 'negative_stock', 'expiring_part', 'ha_link_missing', 'ha_entity_renamed', 'stale_sensor', 'model_reconciliation', 'notify_device_missing', 'worker_outage', 'integrity')),
	CONSTRAINT "ck_app_alert_severity" CHECK(severity IN ('info', 'warning', 'error')),
	CONSTRAINT "ck_app_alert_seen_count" CHECK(seen_count >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_app_alert`("id", "kind", "severity", "entity_table", "entity_id", "title", "body", "dedupe_key", "first_seen_at_ms", "last_seen_at_ms", "seen_count", "acknowledged_at_ms", "acknowledged_by", "resolved_at_ms") SELECT "id", "kind", "severity", "entity_table", "entity_id", "title", "body", "dedupe_key", "first_seen_at_ms", "last_seen_at_ms", "seen_count", "acknowledged_at_ms", "acknowledged_by", "resolved_at_ms" FROM `app_alert`;--> statement-breakpoint
DROP TABLE `app_alert`;--> statement-breakpoint
ALTER TABLE `__new_app_alert` RENAME TO `app_alert`;--> statement-breakpoint
CREATE UNIQUE INDEX `ux_app_alert_dedupe` ON `app_alert` (`dedupe_key`) WHERE resolved_at_ms IS NULL;--> statement-breakpoint
CREATE INDEX `ix_app_alert_kind` ON `app_alert` (`kind`,`resolved_at_ms`);--> statement-breakpoint
CREATE INDEX `ix_app_alert_last_seen` ON `app_alert` (`last_seen_at_ms`);--> statement-breakpoint
ALTER TABLE `service_provider` ADD `archived_at_ms` integer;
--> statement-breakpoint
UPDATE app_alert SET kind = 'integrity' WHERE kind = 'worker_outage' AND dedupe_key IN ('integrity:attachments', 'integrity:project_links');
