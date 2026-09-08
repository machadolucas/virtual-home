ALTER TABLE `ha_entity` ADD `live_state` text;--> statement-breakpoint
ALTER TABLE `ha_entity` ADD `live_restored` integer;--> statement-breakpoint
ALTER TABLE `ha_entity` ADD `live_at_ms` integer;