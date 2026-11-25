-- AlterTable
ALTER TABLE `ledger_transactions` ADD COLUMN `investment_id` VARCHAR(30) NULL,
    MODIFY `source` ENUM('OPENING_BALANCE', 'TRANSFER', 'EXPENSE', 'CREDIT_CARD_PURCHASE', 'CREDIT_CARD_PAYMENT', 'REVERSAL', 'PERSON_GIVE', 'PERSON_RECEIVE', 'PERSON_BORROW', 'PERSON_REPAY', 'LOAN_DISBURSEMENT', 'LOAN_OPENING_BALANCE', 'LOAN_EMI_PAYMENT', 'LOAN_PREPAYMENT', 'INVESTMENT_BUY', 'INVESTMENT_SELL', 'INVESTMENT_CONTRIBUTION', 'INVESTMENT_WITHDRAWAL', 'INVESTMENT_VALUATION') NOT NULL;

-- CreateTable
CREATE TABLE `investments` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `investment_type` ENUM('NPS', 'MUTUAL_FUND', 'STOCK', 'FD', 'PPF', 'EPF') NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `provider` VARCHAR(120) NULL,
    `symbol` VARCHAR(32) NULL,
    `annual_rate` DECIMAL(7, 4) NULL,
    `maturity_date` DATE NULL,
    `ledger_account_id` VARCHAR(30) NOT NULL,
    `idempotency_key` VARCHAR(128) NOT NULL,
    `request_hash` CHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `investments_ledger_account_id_key`(`ledger_account_id`),
    INDEX `investments_user_id_investment_type_name_idx`(`user_id`, `investment_type`, `name`),
    UNIQUE INDEX `investments_user_id_idempotency_key_key`(`user_id`, `idempotency_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `investment_activities` (
    `id` VARCHAR(30) NOT NULL,
    `user_id` VARCHAR(30) NOT NULL,
    `investment_id` VARCHAR(30) NOT NULL,
    `ledger_transaction_id` VARCHAR(30) NOT NULL,
    `activity_type` ENUM('BUY', 'SELL', 'CONTRIBUTION', 'WITHDRAWAL', 'VALUATION') NOT NULL,
    `effective_date` DATE NOT NULL,
    `units` DECIMAL(24, 8) NULL,
    `unit_price` DECIMAL(18, 8) NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `cost_basis_amount` DECIMAL(18, 2) NULL,
    `note` VARCHAR(250) NULL,
    `idempotency_key` VARCHAR(128) NOT NULL,
    `request_hash` CHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `investment_activities_ledger_transaction_id_key`(`ledger_transaction_id`),
    INDEX `investment_activities_investment_id_effective_date_idx`(`investment_id`, `effective_date`),
    INDEX `investment_activities_user_id_effective_date_idx`(`user_id`, `effective_date`),
    UNIQUE INDEX `investment_activities_user_id_idempotency_key_key`(`user_id`, `idempotency_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `investment_price_snapshots` (
    `id` VARCHAR(30) NOT NULL,
    `investment_id` VARCHAR(30) NOT NULL,
    `effective_date` DATE NOT NULL,
    `unit_price` DECIMAL(18, 8) NOT NULL,
    `source` ENUM('AMFI', 'MANUAL', 'PROVIDER') NOT NULL,
    `idempotency_key` VARCHAR(128) NOT NULL,
    `request_hash` CHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `investment_price_snapshots_investment_id_effective_date_idx`(`investment_id`, `effective_date`),
    UNIQUE INDEX `investment_price_snapshots_investment_id_idempotency_key_key`(`investment_id`, `idempotency_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `investment_valuations` (
    `id` VARCHAR(30) NOT NULL,
    `investment_id` VARCHAR(30) NOT NULL,
    `effective_date` DATE NOT NULL,
    `current_value` DECIMAL(18, 2) NOT NULL,
    `ledger_transaction_id` VARCHAR(30) NULL,
    `idempotency_key` VARCHAR(128) NOT NULL,
    `request_hash` CHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `investment_valuations_ledger_transaction_id_key`(`ledger_transaction_id`),
    INDEX `investment_valuations_investment_id_effective_date_idx`(`investment_id`, `effective_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ledger_transactions_investment_id_effective_date_idx` ON `ledger_transactions`(`investment_id`, `effective_date`);

-- AddForeignKey
ALTER TABLE `ledger_transactions` ADD CONSTRAINT `ledger_transactions_investment_id_fkey` FOREIGN KEY (`investment_id`) REFERENCES `investments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `investments` ADD CONSTRAINT `investments_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `investments` ADD CONSTRAINT `investments_ledger_account_id_fkey` FOREIGN KEY (`ledger_account_id`) REFERENCES `ledger_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `investment_activities` ADD CONSTRAINT `investment_activities_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `investment_activities` ADD CONSTRAINT `investment_activities_investment_id_fkey` FOREIGN KEY (`investment_id`) REFERENCES `investments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `investment_activities` ADD CONSTRAINT `investment_activities_ledger_transaction_id_fkey` FOREIGN KEY (`ledger_transaction_id`) REFERENCES `ledger_transactions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `investment_price_snapshots` ADD CONSTRAINT `investment_price_snapshots_investment_id_fkey` FOREIGN KEY (`investment_id`) REFERENCES `investments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `investment_valuations` ADD CONSTRAINT `investment_valuations_investment_id_fkey` FOREIGN KEY (`investment_id`) REFERENCES `investments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `investment_valuations` ADD CONSTRAINT `investment_valuations_ledger_transaction_id_fkey` FOREIGN KEY (`ledger_transaction_id`) REFERENCES `ledger_transactions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
