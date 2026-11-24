-- CreateTable
CREATE TABLE `financial_accounts` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `account_type` ENUM('BANK', 'CASH', 'UPI', 'CREDIT_CARD') NOT NULL,
    `institution_name` VARCHAR(100) NULL,
    `ledger_account_id` VARCHAR(30) NOT NULL,
    `idempotency_key` VARCHAR(128) NOT NULL,
    `request_hash` CHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `financial_accounts_ledger_account_id_key`(`ledger_account_id`),
    INDEX `financial_accounts_user_id_account_type_idx`(`user_id`, `account_type`),
    UNIQUE INDEX `financial_accounts_user_id_idempotency_key_key`(`user_id`, `idempotency_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ledger_accounts` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `category` ENUM('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE') NOT NULL,
    `normal_balance` ENUM('DEBIT', 'CREDIT') NOT NULL,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ledger_accounts_user_id_category_idx`(`user_id`, `category`),
    UNIQUE INDEX `ledger_accounts_user_id_code_key`(`user_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ledger_transactions` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `effective_date` DATE NOT NULL,
    `description` VARCHAR(250) NOT NULL,
    `source` ENUM('OPENING_BALANCE', 'TRANSFER', 'EXPENSE', 'CREDIT_CARD_PURCHASE', 'CREDIT_CARD_PAYMENT', 'REVERSAL') NOT NULL,
    `idempotency_key` VARCHAR(128) NOT NULL,
    `request_hash` CHAR(64) NOT NULL,
    `reversal_of_id` VARCHAR(30) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ledger_transactions_reversal_of_id_key`(`reversal_of_id`),
    INDEX `ledger_transactions_user_id_effective_date_idx`(`user_id`, `effective_date`),
    UNIQUE INDEX `ledger_transactions_user_id_idempotency_key_key`(`user_id`, `idempotency_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `transaction_entries` (
    `id` VARCHAR(30) NOT NULL,
    `transaction_id` VARCHAR(30) NOT NULL,
    `ledger_account_id` VARCHAR(30) NOT NULL,
    `debit_amount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `credit_amount` DECIMAL(18, 2) NOT NULL DEFAULT 0,

    INDEX `transaction_entries_ledger_account_id_transaction_id_idx`(`ledger_account_id`, `transaction_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `entity_type` VARCHAR(40) NOT NULL,
    `entity_id` VARCHAR(30) NOT NULL,
    `action` VARCHAR(60) NOT NULL,
    `changes` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_user_id_created_at_idx`(`user_id`, `created_at`),
    INDEX `audit_logs_entity_type_entity_id_idx`(`entity_type`, `entity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Enforce that a ledger entry posts on exactly one side of the ledger.
ALTER TABLE `transaction_entries`
    ADD CONSTRAINT `transaction_entries_exactly_one_side_check`
    CHECK (
        (`debit_amount` > 0 AND `credit_amount` = 0)
        OR (`credit_amount` > 0 AND `debit_amount` = 0)
    );

-- AddForeignKey
ALTER TABLE `financial_accounts` ADD CONSTRAINT `financial_accounts_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `financial_accounts` ADD CONSTRAINT `financial_accounts_ledger_account_id_fkey` FOREIGN KEY (`ledger_account_id`) REFERENCES `ledger_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ledger_accounts` ADD CONSTRAINT `ledger_accounts_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ledger_transactions` ADD CONSTRAINT `ledger_transactions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ledger_transactions` ADD CONSTRAINT `ledger_transactions_reversal_of_id_fkey` FOREIGN KEY (`reversal_of_id`) REFERENCES `ledger_transactions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `transaction_entries` ADD CONSTRAINT `transaction_entries_transaction_id_fkey` FOREIGN KEY (`transaction_id`) REFERENCES `ledger_transactions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `transaction_entries` ADD CONSTRAINT `transaction_entries_ledger_account_id_fkey` FOREIGN KEY (`ledger_account_id`) REFERENCES `ledger_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
