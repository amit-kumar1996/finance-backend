-- AlterTable
ALTER TABLE `ledger_transactions` MODIFY `source` ENUM('OPENING_BALANCE', 'TRANSFER', 'EXPENSE', 'CREDIT_CARD_PURCHASE', 'CREDIT_CARD_PAYMENT', 'REVERSAL', 'PERSON_GIVE', 'PERSON_RECEIVE', 'PERSON_BORROW', 'PERSON_REPAY') NOT NULL;

-- CreateTable
CREATE TABLE `persons` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `notes` VARCHAR(500) NULL,
    `receivable_account_id` VARCHAR(30) NOT NULL,
    `payable_account_id` VARCHAR(30) NOT NULL,
    `archived_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `persons_receivable_account_id_key`(`receivable_account_id`),
    UNIQUE INDEX `persons_payable_account_id_key`(`payable_account_id`),
    INDEX `persons_user_id_archived_at_name_idx`(`user_id`, `archived_at`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `idempotency_records` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `key` VARCHAR(128) NOT NULL,
    `request_hash` CHAR(64) NOT NULL,
    `resource_type` VARCHAR(40) NOT NULL,
    `resource_id` VARCHAR(30) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idempotency_records_resource_type_resource_id_idx`(`resource_type`, `resource_id`),
    UNIQUE INDEX `idempotency_records_user_id_key_key`(`user_id`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `persons` ADD CONSTRAINT `persons_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `persons` ADD CONSTRAINT `persons_receivable_account_id_fkey` FOREIGN KEY (`receivable_account_id`) REFERENCES `ledger_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `persons` ADD CONSTRAINT `persons_payable_account_id_fkey` FOREIGN KEY (`payable_account_id`) REFERENCES `ledger_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `idempotency_records` ADD CONSTRAINT `idempotency_records_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
