CREATE TABLE `model_fix` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`mode` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`resolved_at_ms` integer,
	`resolution_json` text,
	`created_at_ms` integer NOT NULL,
	`created_by` text,
	`updated_at_ms` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_model_fix_mode" CHECK(mode IN ('desktop', 'vr', 'mr')),
	CONSTRAINT "ck_model_fix_status" CHECK(status IN ('pending', 'resolved')),
	CONSTRAINT "ck_model_fix_resolution" CHECK((status = 'pending' AND resolved_at_ms IS NULL AND resolution_json IS NULL)
    OR (status = 'resolved' AND resolved_at_ms IS NOT NULL AND resolution_json IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `ix_model_fix_order` ON `model_fix` (`created_at_ms`,`id`);--> statement-breakpoint
CREATE INDEX `ix_model_fix_model_status_order` ON `model_fix` (`model_id`,`status`,`created_at_ms`,`id`);--> statement-breakpoint
CREATE TABLE `model_fix_screenshot` (
	`id` text PRIMARY KEY NOT NULL,
	`fix_id` text NOT NULL,
	`source` text NOT NULL,
	`model_revision_id` text,
	`viewpoint_json` text,
	`image_id` text NOT NULL,
	`second_image_id` text,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`fix_id`) REFERENCES `model_fix`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_revision_id`) REFERENCES `model_revision`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`image_id`) REFERENCES `attachment`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`second_image_id`) REFERENCES `attachment`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_model_fix_screenshot_source" CHECK((source = 'viewer' AND model_revision_id IS NOT NULL AND viewpoint_json IS NOT NULL)
    OR (source = 'quest_system' AND model_revision_id IS NULL AND viewpoint_json IS NULL AND second_image_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_model_fix_screenshot_request` ON `model_fix_screenshot` (`created_by`,`request_id`);--> statement-breakpoint
CREATE INDEX `ix_model_fix_screenshot_order` ON `model_fix_screenshot` (`fix_id`,`created_at_ms`,`id`);