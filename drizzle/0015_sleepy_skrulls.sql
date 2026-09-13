CREATE TABLE `member_access` (
	`user_id` text PRIMARY KEY NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `ha_review` (
	`kind` text NOT NULL,
	`registry_id` text NOT NULL,
	`ignored` integer DEFAULT true NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`updated_by` text NOT NULL,
	PRIMARY KEY(`kind`, `registry_id`),
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
