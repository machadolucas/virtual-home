-- Additive columns for infrastructure documentation and renovation projects:
--   asset_placement: the mount (kind, surface, height, offset), the location note and the close-up
--                    photo — the coverage gap recorded in docs/model-contract.md §3.1;
--   infra_route:     lifecycle dates, depth/offset relative to a surface, and the project link;
--   infra_route_point: the per-point floor/room of the span that starts there.
--
-- HAND-CORRECTED, twice, and both corrections matter:
--
-- 1. drizzle-kit emitted the *new* column list on both sides of the asset_placement copy, so the
--    SELECT read columns the old table does not have. The new columns take their defaults instead.
-- 2. The generated `PRAGMA foreign_keys=OFF/ON` pair is removed: the migrator runs each migration
--    inside a transaction, where that pragma is a documented no-op. It is not needed here —
--    asset_placement is the only rebuilt table and nothing references it. `infra_route` is
--    extended with plain ALTER TABLE ADD COLUMN precisely so it is *not* rebuilt: rebuilding it
--    would run an implicit DELETE FROM that cascades into infra_route_point and silently take
--    every route's polyline with it. That is why the new date coherence rule lives in the API
--    layer rather than in a CHECK constraint (see src/db/schema/infrastructure.ts).
CREATE TABLE `__new_asset_placement` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`model_revision_id` text NOT NULL,
	`model_node_id` text NOT NULL,
	`pos_x` real,
	`pos_y` real,
	`pos_z` real,
	`rot_yaw_deg` real,
	`placement_kind` text DEFAULT 'body' NOT NULL,
	`mount_kind` text DEFAULT 'floor' NOT NULL,
	`mount_surface_id` text,
	`mount_height_m` real,
	`mount_offset_m` real,
	`location_note` text,
	`photo_attachment_id` text,
	`needs_reconciliation` integer DEFAULT false NOT NULL,
	`color_override` text,
	`created_at_ms` integer NOT NULL,
	`created_by` text,
	`updated_at_ms` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`asset_id`) REFERENCES `asset`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_revision_id`) REFERENCES `model_revision`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`photo_attachment_id`) REFERENCES `attachment`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_asset_placement_kind" CHECK(placement_kind IN ('body', 'access_panel', 'label', 'shutoff')),
	CONSTRAINT "ck_asset_placement_mount_kind" CHECK(mount_kind IN ('floor', 'wall', 'ceiling', 'free')),
	CONSTRAINT "ck_asset_placement_color" CHECK(color_override IS NULL OR color_override GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')
);
--> statement-breakpoint
INSERT INTO `__new_asset_placement`("id", "asset_id", "model_revision_id", "model_node_id", "pos_x", "pos_y", "pos_z", "rot_yaw_deg", "placement_kind", "mount_kind", "mount_surface_id", "mount_height_m", "mount_offset_m", "location_note", "photo_attachment_id", "needs_reconciliation", "color_override", "created_at_ms", "created_by", "updated_at_ms", "updated_by") SELECT "id", "asset_id", "model_revision_id", "model_node_id", "pos_x", "pos_y", "pos_z", "rot_yaw_deg", "placement_kind", 'floor', NULL, NULL, NULL, NULL, NULL, "needs_reconciliation", "color_override", "created_at_ms", "created_by", "updated_at_ms", "updated_by" FROM `asset_placement`;--> statement-breakpoint
DROP TABLE `asset_placement`;--> statement-breakpoint
ALTER TABLE `__new_asset_placement` RENAME TO `asset_placement`;--> statement-breakpoint
CREATE UNIQUE INDEX `ux_asset_placement_kind` ON `asset_placement` (`asset_id`,`placement_kind`);--> statement-breakpoint
CREATE INDEX `ix_asset_placement_node` ON `asset_placement` (`model_revision_id`,`model_node_id`);--> statement-breakpoint
CREATE INDEX `ix_asset_placement_surface` ON `asset_placement` (`mount_surface_id`);--> statement-breakpoint
ALTER TABLE `infra_route` ADD `installed_on` text;--> statement-breakpoint
ALTER TABLE `infra_route` ADD `removed_on` text;--> statement-breakpoint
ALTER TABLE `infra_route` ADD `depth_m` real;--> statement-breakpoint
ALTER TABLE `infra_route` ADD `offset_surface_id` text;--> statement-breakpoint
ALTER TABLE `infra_route` ADD `offset_m` real;--> statement-breakpoint
ALTER TABLE `infra_route` ADD `project_id` text REFERENCES project(id);--> statement-breakpoint
CREATE INDEX `ix_infra_route_project` ON `infra_route` (`project_id`);--> statement-breakpoint
ALTER TABLE `infra_route_point` ADD `floor_id` text;--> statement-breakpoint
ALTER TABLE `infra_route_point` ADD `room_id` text;--> statement-breakpoint
CREATE INDEX `ix_infra_route_point_room` ON `infra_route_point` (`room_id`);