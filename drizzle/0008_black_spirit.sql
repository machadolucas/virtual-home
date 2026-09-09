CREATE TABLE `model_label_preference` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`model_node_id` text NOT NULL,
	`display_name` text,
	`visible` integer,
	`created_at_ms` integer NOT NULL,
	`created_by` text,
	`updated_at_ms` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_model_label_preference` ON `model_label_preference` (`model_id`,`model_node_id`);--> statement-breakpoint
CREATE INDEX `ix_model_label_preference_model` ON `model_label_preference` (`model_id`);--> statement-breakpoint
CREATE TABLE `ha_control_command` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`entity_registry_id` text NOT NULL,
	`entity_id_snapshot` text NOT NULL,
	`domain` text NOT NULL,
	`command_json` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`requested_by` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`sending_at_ms` integer,
	`finished_at_ms` integer,
	`last_error` text,
	FOREIGN KEY (`asset_id`) REFERENCES `asset`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_registry_id`) REFERENCES `ha_entity`(`registry_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`requested_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_ha_control_command_state" CHECK(state IN ('queued', 'sending', 'sent', 'failed', 'expired')),
	CONSTRAINT "ck_ha_control_command_domain" CHECK(domain IN ('light', 'switch')),
	CONSTRAINT "ck_ha_control_command_expiry" CHECK(expires_at_ms > created_at_ms)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_ha_control_command_request` ON `ha_control_command` (`requested_by`,`request_id`);--> statement-breakpoint
CREATE INDEX `ix_ha_control_command_ready` ON `ha_control_command` (`state`,`expires_at_ms`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `ix_ha_control_command_asset` ON `ha_control_command` (`asset_id`,`created_at_ms`);