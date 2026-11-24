ALTER TABLE `infra_route` ADD `flow_direction` text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE `infra_route` ADD `flow_basis` text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE `infra_route` ADD `flow_state` text DEFAULT 'unknown' NOT NULL;
