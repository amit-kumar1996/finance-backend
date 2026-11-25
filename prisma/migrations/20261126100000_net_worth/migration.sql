-- CreateTable
CREATE TABLE `net_worth_snapshots` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `snapshot_date` DATE NOT NULL,
    `total_assets` DECIMAL(18, 2) NOT NULL,
    `total_liabilities` DECIMAL(18, 2) NOT NULL,
    `net_worth` DECIMAL(18, 2) NOT NULL,
    `asset_breakdown` JSON NOT NULL,
    `liability_breakdown` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `net_worth_snapshots_user_id_snapshot_date_idx`(`user_id`, `snapshot_date`),
    UNIQUE INDEX `net_worth_snapshots_user_id_snapshot_date_key`(`user_id`, `snapshot_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `net_worth_snapshots` ADD CONSTRAINT `net_worth_snapshots_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
