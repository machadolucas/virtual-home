CREATE TABLE `ha_entity_state` (
	`entity_id` text PRIMARY KEY NOT NULL,
	`registry_id` text,
	`state` text NOT NULL,
	`attributes_json` text,
	`last_changed_ms` integer NOT NULL,
	`last_updated_ms` integer NOT NULL,
	`observed_at_ms` integer NOT NULL,
	FOREIGN KEY (`registry_id`) REFERENCES `ha_entity`(`registry_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_ha_entity_state_registry` ON `ha_entity_state` (`registry_id`);--> statement-breakpoint
CREATE INDEX `ix_ha_entity_state_observed` ON `ha_entity_state` (`observed_at_ms`);