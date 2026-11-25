CREATE TABLE `room_survey` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`room_id` text NOT NULL,
	`floor_id` text NOT NULL,
	`room_name` text NOT NULL,
	`registration_error_m` real NOT NULL,
	`statistics_json` text NOT NULL,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`revision_id`) REFERENCES `model_revision`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_room_survey_residual" CHECK(registration_error_m >= 0 AND registration_error_m <= 0.05)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_room_survey_request` ON `room_survey` (`created_by`,`request_id`);--> statement-breakpoint
CREATE INDEX `ix_room_survey_order` ON `room_survey` (`created_at_ms`,`id`);--> statement-breakpoint
CREATE INDEX `ix_room_survey_model_room_order` ON `room_survey` (`model_id`,`room_id`,`created_at_ms`,`id`);--> statement-breakpoint
CREATE TABLE `room_survey_geometry` (
	`survey_id` text PRIMARY KEY NOT NULL,
	`metadata_json` text NOT NULL,
	FOREIGN KEY (`survey_id`) REFERENCES `room_survey`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `room_survey_geometry_chunk` (
	`survey_id` text NOT NULL,
	`surface` integer NOT NULL,
	`section` text NOT NULL,
	`chunk` integer NOT NULL,
	`payload_json` text NOT NULL,
	PRIMARY KEY(`survey_id`, `surface`, `section`, `chunk`),
	FOREIGN KEY (`survey_id`) REFERENCES `room_survey_geometry`(`survey_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_room_survey_geometry_chunk_section" CHECK(section IN ('points', 'indices'))
);
--> statement-breakpoint
CREATE TABLE `room_survey_move` (
	`id` text PRIMARY KEY NOT NULL,
	`survey_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`target_name` text NOT NULL,
	`target_version` integer NOT NULL,
	`applied_target_version` integer,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`apply_blocked_reason` text,
	`registration_error_m` real NOT NULL,
	`status` text NOT NULL,
	`applied_at_ms` integer,
	`undone_at_ms` integer,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`created_by` text,
	`updated_at_ms` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`survey_id`) REFERENCES `room_survey`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_room_survey_move_target" CHECK(target_kind IN ('equipment', 'furnishing')),
	CONSTRAINT "ck_room_survey_move_status" CHECK(status IN ('proposed', 'applied', 'undone')),
	CONSTRAINT "ck_room_survey_move_residual" CHECK(registration_error_m >= 0 AND registration_error_m <= 0.05)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_room_survey_move_request` ON `room_survey_move` (`created_by`,`request_id`);--> statement-breakpoint
CREATE INDEX `ix_room_survey_move_order` ON `room_survey_move` (`survey_id`,`created_at_ms`,`id`);--> statement-breakpoint
CREATE TABLE `room_survey_observation` (
	`fix_id` text PRIMARY KEY NOT NULL,
	`survey_id` text NOT NULL,
	`kind` text NOT NULL,
	`position_json` text NOT NULL,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`fix_id`) REFERENCES `model_fix`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`survey_id`) REFERENCES `room_survey`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_room_survey_observation_kind" CHECK(kind IN ('structure', 'new_object'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_room_survey_observation_request` ON `room_survey_observation` (`created_by`,`request_id`);--> statement-breakpoint
CREATE INDEX `ix_room_survey_observation_order` ON `room_survey_observation` (`survey_id`,`created_at_ms`,`fix_id`);