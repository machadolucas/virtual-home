-- `furnishing` is a leaf table with no inbound foreign keys, so rebuilding its kind CHECK
-- preserves its rows without cascading into dependent records.
CREATE TABLE `__new_furnishing` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`model_node_id` text NOT NULL,
	`floor_id` text NOT NULL,
	`room_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`pos_x` real NOT NULL,
	`pos_y` real NOT NULL,
	`pos_z` real NOT NULL,
	`rot_yaw_deg` real DEFAULT 0 NOT NULL,
	`width_m` real NOT NULL,
	`depth_m` real NOT NULL,
	`height_m` real NOT NULL,
	`created_at_ms` integer NOT NULL,
	`created_by` text,
	`updated_at_ms` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_furnishing_kind" CHECK(kind IN ('sofa', 'sofa_l', 'bed_single', 'bed_double', 'bedside_table', 'chair', 'dining_table', 'computer_desk', 'bicycle', 'shelves', 'cabinet', 'kitchen_counter', 'rug', 'bench', 'tv_rack', 'stool', 'outdoor_wheelie_bin')),
	CONSTRAINT "ck_furnishing_width" CHECK(width_m > 0),
	CONSTRAINT "ck_furnishing_depth" CHECK(depth_m > 0),
	CONSTRAINT "ck_furnishing_height" CHECK(height_m > 0),
	CONSTRAINT "ck_furnishing_finite" CHECK("__new_furnishing"."pos_x" = "__new_furnishing"."pos_x" AND "__new_furnishing"."pos_y" = "__new_furnishing"."pos_y" AND "__new_furnishing"."pos_z" = "__new_furnishing"."pos_z")
);
--> statement-breakpoint
INSERT INTO `__new_furnishing`("id", "model_id", "model_node_id", "floor_id", "room_id", "kind", "name", "pos_x", "pos_y", "pos_z", "rot_yaw_deg", "width_m", "depth_m", "height_m", "created_at_ms", "created_by", "updated_at_ms", "updated_by") SELECT "id", "model_id", "model_node_id", "floor_id", "room_id", "kind", "name", "pos_x", "pos_y", "pos_z", "rot_yaw_deg", "width_m", "depth_m", "height_m", "created_at_ms", "created_by", "updated_at_ms", "updated_by" FROM `furnishing`;--> statement-breakpoint
DROP TABLE `furnishing`;--> statement-breakpoint
ALTER TABLE `__new_furnishing` RENAME TO `furnishing`;--> statement-breakpoint
CREATE INDEX `ix_furnishing_model_floor` ON `furnishing` (`model_id`,`floor_id`);--> statement-breakpoint
CREATE INDEX `ix_furnishing_node` ON `furnishing` (`model_id`,`model_node_id`);--> statement-breakpoint
ALTER TABLE `asset_placement` ADD `equipment_dimensions_json` text;
