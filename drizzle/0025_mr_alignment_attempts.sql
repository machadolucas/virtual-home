CREATE TABLE `alignment_attempt` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`model_revision_id` text NOT NULL,
	`revision` integer NOT NULL,
	`started_at_ms` integer NOT NULL,
	`received_at_ms` integer NOT NULL,
	`elapsed_ms` integer NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`room_id` text,
	`evidence_json` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_revision_id`) REFERENCES `model_revision`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_alignment_attempt_revision" CHECK(revision >= 1)
);
--> statement-breakpoint
CREATE INDEX `ix_alignment_attempt_user_time` ON `alignment_attempt` (`user_id`,`started_at_ms`,`id`);--> statement-breakpoint
CREATE INDEX `ix_alignment_attempt_expiry` ON `alignment_attempt` (`started_at_ms`);
