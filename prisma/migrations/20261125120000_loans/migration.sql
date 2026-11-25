-- AlterTable
ALTER TABLE `ledger_transactions`
  MODIFY `source` ENUM('OPENING_BALANCE', 'TRANSFER', 'EXPENSE', 'CREDIT_CARD_PURCHASE', 'CREDIT_CARD_PAYMENT', 'REVERSAL', 'PERSON_GIVE', 'PERSON_RECEIVE', 'PERSON_BORROW', 'PERSON_REPAY', 'LOAN_DISBURSEMENT', 'LOAN_OPENING_BALANCE', 'LOAN_EMI_PAYMENT', 'LOAN_PREPAYMENT') NOT NULL,
  ADD COLUMN `loan_id` VARCHAR(30) NULL,
  ADD COLUMN `counts_as_emi` BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE `loans` (
  `id` VARCHAR(30) NOT NULL,
  `user_id` VARCHAR(30) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `provider` VARCHAR(120) NOT NULL,
  `principal` DECIMAL(18, 2) NOT NULL,
  `annual_rate` DECIMAL(7, 4) NOT NULL,
  `term_months` SMALLINT UNSIGNED NOT NULL,
  `emi_amount` DECIMAL(18, 2) NOT NULL,
  `due_day` TINYINT UNSIGNED NOT NULL,
  `start_date` DATE NOT NULL,
  `liability_account_id` VARCHAR(30) NOT NULL,
  `status` ENUM('ACTIVE', 'CLOSED') NOT NULL DEFAULT 'ACTIVE',
  `idempotency_key` VARCHAR(128) NOT NULL,
  `request_hash` CHAR(64) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `loans_liability_account_id_key`(`liability_account_id`),
  UNIQUE INDEX `loans_user_id_idempotency_key_key`(`user_id`, `idempotency_key`),
  INDEX `loans_user_id_status_start_date_idx`(`user_id`, `status`, `start_date`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ledger_transactions_loan_id_effective_date_idx` ON `ledger_transactions`(`loan_id`, `effective_date`);

-- AddForeignKey
ALTER TABLE `loans` ADD CONSTRAINT `loans_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `loans` ADD CONSTRAINT `loans_liability_account_id_fkey` FOREIGN KEY (`liability_account_id`) REFERENCES `ledger_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `ledger_transactions` ADD CONSTRAINT `ledger_transactions_loan_id_fkey` FOREIGN KEY (`loan_id`) REFERENCES `loans`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
