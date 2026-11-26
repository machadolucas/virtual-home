CREATE TABLE `fit_proposal` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`room_id` text NOT NULL,
	`draft_json` text NOT NULL,
	`request_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_fit_proposal_request` ON `fit_proposal` (`created_by`,`request_id`);--> statement-breakpoint
CREATE INDEX `ix_fit_proposal_room` ON `fit_proposal` (`model_id`,`fingerprint`,`room_id`,`created_at_ms`);--> statement-breakpoint
ALTER TABLE `room_survey_observation` ADD `comparison_json` text;